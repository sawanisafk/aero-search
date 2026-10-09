/**
 * Lenient free-text parsing for natural-language queries (Plan A).
 *
 * Problem: the strict Boolean query language treats `(`, `)` and `"` as
 * syntax, so ordinary question titles like `Understanding the exclamation
 * mark (!) in bash` fail with EMPTY_GROUP / EMPTY_PHRASE / UNBALANCED_QUOTE
 * and the evaluation harness discards a query that still has searchable
 * terms (measured: 33 of 4,854 Tier B queries — docs/EVALUATION.md §6).
 *
 * Design: STRICT-FIRST, ERROR-TARGETED REPAIR.
 *   1. Try the strict `parseQuery` unchanged. If it succeeds the caller gets
 *      the exact strict AST with zero repairs — valid Boolean queries
 *      (`foo AND (bar OR baz)`, phrases, NOT) are never altered.
 *   2. Only on a QueryParseError does a bounded repair loop engage. Each
 *      iteration applies ONE minimal, position-targeted edit at the error
 *      position reported by the strict lexer/parser and re-parses:
 *
 *        EMPTY_PHRASE@p        remove_quoted_span   delete the symbol-only
 *                                                   `"..."` at p (its content
 *                                                   lexes to nothing anyway)
 *        UNBALANCED_QUOTE@p    remove_quote         delete the unclosed `"`
 *        EMPTY_GROUP@p         remove_group         delete `(...)` whose
 *                                                   contents are non-lexical
 *        UNBALANCED_PAREN@p    remove_stray_rparen  p points at `)` -> delete
 *                                  / close_paren     p points at `(` -> append `)`
 *
 *      No broad regex ever touches the query: every edit is a slice anchored
 *      at the exact character the strict parser complained about, guarded by
 *      an explicit character check (if the guard fails we refuse to repair).
 *   3. EMPTY_QUERY is never repaired — there is nothing to preserve; it is
 *      reported as its own category (empty query, not syntax error).
 *   4. MISSING_OPERAND / UNEXPECTED_TOKEN are NOT repaired in this patch:
 *      they have no evidence base among the 33 failures, so they surface as
 *      the `unsupported_syntax` category instead of an invented heuristic.
 *   5. Non-QueryParseError exceptions always propagate (internal engine
 *      errors are never re-labelled as parse failures).
 *
 * Termination: every repair either deletes >= 1 character or appends exactly
 * one `)` (only for unclosed groups, bounded by the number of `(` in the
 * input); a no-progress guard and a hard iteration cap (2*len+8) are
 * additional backstops.
 *
 * Scope: used by the evaluation harness (scripts/lib/retrieval-run.ts) only.
 * The API/UI still runs the strict path at src/api/search-service.ts:527
 * (search) and :700 (document highlighting) — that integration is a separate,
 * reviewed change behind an explicit option; see docs/SEARCH.md §errors.
 *
 * Limitation (documented, unchanged): repairs preserve WORDS, not symbols.
 * The index has no symbol tokens, so queries about a symbol itself (e.g.
 * `(!)` alone) may parse after repair but still match nothing — lenient
 * parsing does not make symbols searchable.
 */

import type { Query } from './ast.js';
import { QueryParseError, type QueryParseErrorCode } from './errors.js';
import { parseQuery, type QueryParseOptions } from './parser.js';

/** One minimal source edit applied at a strict-parser error position. */
export interface LenientRepair {
  /** strict error code that triggered the edit */
  readonly code: QueryParseErrorCode;
  /** character offset the strict parser reported */
  readonly position: number;
  readonly action:
    | 'remove_quoted_span'
    | 'remove_quote'
    | 'remove_group'
    | 'remove_stray_rparen'
    | 'close_paren';
  /** exact source text removed (empty for close_paren, which appends ')') */
  readonly removed: string;
}

export interface LenientParseOk {
  readonly ok: true;
  readonly query: Query;
  /** empty for queries the strict parser accepted as-is */
  readonly repairs: readonly LenientRepair[];
}

export interface LenientParseFail {
  readonly ok: false;
  /** the original strict error (never re-labelled; code/position preserved) */
  readonly error: QueryParseError;
  /** repairs applied before the attempt was abandoned */
  readonly repairs: readonly LenientRepair[];
}

export type LenientParseResult = LenientParseOk | LenientParseFail;

/** Attempt a minimal repair for `e` in `text`; null = policy refuses. */
function repairStep(text: string, e: QueryParseError): { text: string; repair: LenientRepair } | null {
  const p = e.position;
  const at = (i: number): string | undefined => (i >= 0 && i < text.length ? text[i] : undefined);

  switch (e.code) {
    case 'UNBALANCED_QUOTE': {
      if (at(p) !== '"') return null;
      return {
        text: text.slice(0, p) + text.slice(p + 1),
        repair: { code: e.code, position: p, action: 'remove_quote', removed: '"' },
      };
    }
    case 'EMPTY_PHRASE': {
      if (at(p) !== '"') return null;
      const end = text.indexOf('"', p + 1);
      const spanEnd = end === -1 ? p + 1 : end + 1;
      const removed = text.slice(p, spanEnd);
      return {
        text: text.slice(0, p) + text.slice(spanEnd),
        repair: { code: e.code, position: p, action: 'remove_quoted_span', removed },
      };
    }
    case 'EMPTY_GROUP': {
      if (at(p) !== '(') return null;
      const close = text.indexOf(')', p + 1);
      // unreachable in practice: EMPTY_GROUP fires only when the next token
      // IS a rparen, so a ')' exists — refuse rather than mislabel an edit.
      if (close === -1) return null;
      const spanEnd = close + 1;
      return {
        text: text.slice(0, p) + text.slice(spanEnd),
        repair: { code: e.code, position: p, action: 'remove_group', removed: text.slice(p, spanEnd) },
      };
    }
    case 'UNBALANCED_PAREN': {
      const c = at(p);
      if (c === ')') {
        return {
          text: text.slice(0, p) + text.slice(p + 1),
          repair: { code: e.code, position: p, action: 'remove_stray_rparen', removed: ')' },
        };
      }
      if (c === '(') {
        return {
          text: `${text})`,
          repair: { code: e.code, position: p, action: 'close_paren', removed: '' },
        };
      }
      return null;
    }
    case 'EMPTY_QUERY':
    case 'MISSING_OPERAND':
    case 'UNEXPECTED_TOKEN':
      return null;
  }
}

/**
 * Lenient parse: strict-first, then bounded error-targeted repair.
 * Non-throwing — failures carry the ORIGINAL strict error plus the repairs
 * that were attempted, so callers can report exactly what happened.
 */
export function tryParseQueryLenient(
  input: string,
  options: QueryParseOptions = {},
): LenientParseResult {
  let text = input;
  const repairs: LenientRepair[] = [];
  const cap = input.length * 2 + 8;
  for (let i = 0; i <= cap; i++) {
    try {
      return { ok: true, query: parseQuery(text, options), repairs };
    } catch (e) {
      if (!(e instanceof QueryParseError)) throw e; // internal errors propagate untouched
      if (e.code === 'EMPTY_QUERY') {
        // nothing left to preserve — not a syntax problem, do not repair
        return { ok: false, error: e, repairs };
      }
      const step = repairs.length < cap ? repairStep(text, e) : null;
      if (step === null || step.text === text) {
        return { ok: false, error: e, repairs };
      }
      text = step.text;
      repairs.push(step.repair);
    }
  }
  throw new QueryParseError('UNEXPECTED_TOKEN', 0, 'lenient repair did not converge');
}

/** Throwing convenience wrapper around tryParseQueryLenient. */
export function parseQueryLenient(input: string, options: QueryParseOptions = {}): Query {
  const result = tryParseQueryLenient(input, options);
  if (!result.ok) throw result.error;
  return result.query;
}
