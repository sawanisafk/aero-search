/**
 * Query lexer: raw string -> structural tokens.
 *
 * Rules (documented in docs/SEARCH.md):
 *   - Operators are recognized ONLY as standalone uppercase words AND/OR/NOT;
 *     lowercase "and" is an ordinary term, so natural-language queries are
 *     never silently reinterpreted.
 *   - `"` opens a phrase up to the next `"` (no escaping in M2); a phrase is
 *     split into words with the SAME `extractRuns()` the index pipeline uses,
 *     so query words are tokenized identically to document words.
 *   - `(` `)` are grouping tokens; adjacency of operand tokens (implicit AND)
 *     is left to the parser — the lexer only records structure.
 *   - Term positions are absolute offsets into the original query string.
 *
 * Lexing throws only for quote problems (UNBALANCED_QUOTE / EMPTY_PHRASE);
 * everything else (dangling operators, stray parens) is a parser concern.
 */

import { extractRuns } from '../text/analyze.js';
import { QueryParseError } from './errors.js';

export type QueryToken =
  | { readonly type: 'term'; readonly text: string; readonly position: number }
  | { readonly type: 'phrase'; readonly terms: readonly string[]; readonly position: number }
  | { readonly type: 'and'; readonly position: number }
  | { readonly type: 'or'; readonly position: number }
  | { readonly type: 'not'; readonly position: number }
  | { readonly type: 'lparen'; readonly position: number }
  | { readonly type: 'rparen'; readonly position: number };

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
}

function isStructural(c: string): boolean {
  return c === '"' || c === '(' || c === ')';
}

export function lex(input: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  const len = input.length;
  let i = 0;

  while (i < len) {
    const c = input[i]!;
    if (isSpace(c)) {
      i++;
      continue;
    }

    if (c === '"') {
      const quotePos = i;
      const end = input.indexOf('"', i + 1);
      if (end === -1) {
        throw new QueryParseError('UNBALANCED_QUOTE', quotePos, 'no closing \'"\'');
      }
      const words = extractRuns(input.slice(i + 1, end)).map((r) => r.term);
      if (words.length === 0) {
        throw new QueryParseError('EMPTY_PHRASE', quotePos, 'phrase contains no words');
      }
      tokens.push({ type: 'phrase', terms: words, position: quotePos });
      i = end + 1;
      continue;
    }

    if (c === '(') {
      tokens.push({ type: 'lparen', position: i });
      i++;
      continue;
    }

    if (c === ')') {
      tokens.push({ type: 'rparen', position: i });
      i++;
      continue;
    }

    // raw chunk: everything up to whitespace/structural
    const start = i;
    while (i < len && !isSpace(input[i]!) && !isStructural(input[i]!)) i++;
    const chunk = input.slice(start, i);

    if (chunk === 'AND') tokens.push({ type: 'and', position: start });
    else if (chunk === 'OR') tokens.push({ type: 'or', position: start });
    else if (chunk === 'NOT') tokens.push({ type: 'not', position: start });
    else {
      for (const run of extractRuns(chunk)) {
        tokens.push({ type: 'term', text: run.term, position: start + run.start });
      }
    }
  }

  return tokens;
}
