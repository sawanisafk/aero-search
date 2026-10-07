/**
 * Query parse failures as typed errors (never thrown as bare strings).
 *
 * Every error carries the character position of the offending input so the
 * UI (M5) can underline the problem and tests can assert precisely WHERE a
 * malformed query broke. Codes are a closed set — callers switch on them.
 */

export type QueryParseErrorCode =
  | 'EMPTY_QUERY'
  | 'UNBALANCED_QUOTE'
  | 'EMPTY_PHRASE'
  | 'UNBALANCED_PAREN'
  | 'EMPTY_GROUP'
  | 'MISSING_OPERAND'
  | 'UNEXPECTED_TOKEN';

export class QueryParseError extends Error {
  readonly code: QueryParseErrorCode;
  /** character offset into the raw query string */
  readonly position: number;

  constructor(code: QueryParseErrorCode, position: number, detail: string) {
    super(`${code} at ${position}: ${detail}`);
    this.name = 'QueryParseError';
    this.code = code;
    this.position = position;
  }
}
