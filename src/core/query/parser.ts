/**
 * Recursive-descent query parser.
 *
 * Grammar (precedence: NOT > AND > OR — OR binds loosest, as in Boolean algebra):
 *
 *   orExpr   := andExpr ( OR andExpr )*
 *   andExpr  := notExpr ( AND? notExpr )*     // operator AND and adjacency both make AND
 *   notExpr  := NOT notExpr | primary
 *   primary  := '(' orExpr ')' | PHRASE | TERM
 *
 * Implicit operator: by default `a b` == `a AND b`, so free-text queries
 * pasted from a UI are conjunctions (the common web expectation) while
 * explicit OR stays opt-in. IR evaluation (BEIR/TREC BM25 baselines) uses
 * the opposite convention — a query is a bag of words joined by OR — so
 * callers can pass `{ implicitOperator: 'or' }` (scripts/run-experiment.ts
 * does). Explicit AND/OR tokens, phrases and parens behave identically in
 * both modes; the option only changes what bare adjacency means.
 * `a NOT b` parses as `a AND (NOT b)` (default) or `a OR (NOT b)` ('or')
 * because NOT is an operand prefix.
 *
 * Errors: every malformed shape maps to a QueryParseError code with the
 * offending character position (see errors.ts for the closed code set).
 */

import type { Query } from './ast.js';
import { QueryParseError } from './errors.js';
import { lex, type QueryToken } from './lexer.js';

export interface QueryParseOptions {
  /** operator implied by bare adjacency — 'and' (default) or 'or' (IR eval) */
  readonly implicitOperator?: 'and' | 'or';
}

function startsOperand(t: QueryToken): boolean {
  return t.type === 'term' || t.type === 'phrase' || t.type === 'lparen' || t.type === 'not';
}

function tokenLabel(t: QueryToken): string {
  switch (t.type) {
    case 'term':
      return `"${t.text}"`;
    case 'phrase':
      return 'phrase';
    case 'and':
      return 'AND';
    case 'or':
      return 'OR';
    case 'not':
      return 'NOT';
    case 'lparen':
      return "'('";
    case 'rparen':
      return "')'";
  }
}

class Parser {
  private pos = 0;
  /** position of the innermost unclosed '(' (only read when input ends mid-group) */
  private openParenPos = 0;

  constructor(
    private readonly tokens: QueryToken[],
    private readonly implicit: 'and' | 'or' = 'and',
  ) {}

  parse(): Query {
    if (this.tokens.length === 0) {
      throw new QueryParseError('EMPTY_QUERY', 0, 'query contains no searchable words');
    }
    const node = this.parseOr();
    const rest = this.tokens[this.pos];
    if (rest !== undefined) {
      // unreachable branches documented: only '(' or ')' survive a completed
      // orExpr — a stray ')' has no opener, an '(' means a group never closed.
      throw new QueryParseError(
        'UNBALANCED_PAREN',
        rest.position,
        `unexpected ${tokenLabel(rest)}`,
      );
    }
    return node;
  }

  private peek(): QueryToken | undefined {
    return this.tokens[this.pos];
  }

  private parseOr(): Query {
    let left = this.parseAnd();
    for (;;) {
      const t = this.peek();
      if (t?.type !== 'or') return left;
      this.pos++;
      this.requireOperand(t, 'OR');
      left = { kind: 'or', left, right: this.parseAnd() };
    }
  }

  private parseAnd(): Query {
    let left = this.parseNot();
    for (;;) {
      const t = this.peek();
      if (t === undefined) return left;
      if (t.type === 'and') {
        this.pos++;
        this.requireOperand(t, 'AND');
        left = { kind: 'and', left, right: this.parseNot() };
      } else if (startsOperand(t)) {
        const right = this.parseNot();
        left =
          this.implicit === 'or' ? { kind: 'or', left, right } : { kind: 'and', left, right };
      } else {
        return left;
      }
    }
  }

  private parseNot(): Query {
    const t = this.peek();
    if (t?.type === 'not') {
      this.pos++;
      this.requireOperand(t, 'NOT');
      return { kind: 'not', operand: this.parseNot() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Query {
    const t = this.peek();
    if (t === undefined) {
      // Reached only when input ends immediately after '(' (top-level EOF is
      // EMPTY_QUERY, operator EOF is caught by requireOperand).
      throw new QueryParseError('UNBALANCED_PAREN', this.openParenPos, "unclosed '('");
    }
    switch (t.type) {
      case 'term':
        this.pos++;
        return { kind: 'term', term: t.text };
      case 'phrase':
        this.pos++;
        return { kind: 'phrase', terms: t.terms };
      case 'lparen': {
        this.pos++;
        if (this.peek()?.type === 'rparen') {
          throw new QueryParseError('EMPTY_GROUP', t.position, "'()' has no expression");
        }
        this.openParenPos = t.position;
        const inner = this.parseOr();
        const close = this.peek();
        if (close?.type !== 'rparen') {
          throw new QueryParseError('UNBALANCED_PAREN', t.position, "unclosed '('");
        }
        this.pos++;
        return inner;
      }
      case 'rparen':
        throw new QueryParseError('UNBALANCED_PAREN', t.position, "unexpected ')'");
      default:
        throw new QueryParseError(
          'MISSING_OPERAND',
          t.position,
          `${tokenLabel(t)} has no left-hand operand`,
        );
    }
  }

  private requireOperand(op: QueryToken, name: string): void {
    const next = this.peek();
    if (next === undefined || !startsOperand(next)) {
      throw new QueryParseError('MISSING_OPERAND', op.position, `${name} has no right-hand operand`);
    }
  }
}

/** Parse a raw query string into a typed AST. Throws QueryParseError. */
export function parseQuery(input: string, options: QueryParseOptions = {}): Query {
  return new Parser(lex(input), options.implicitOperator ?? 'and').parse();
}
