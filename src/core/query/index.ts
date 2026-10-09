export type {
  Query,
  TermQuery,
  PhraseQuery,
  AndQuery,
  OrQuery,
  NotQuery,
} from './ast.js';
export { isLeaf } from './ast.js';
export { QueryParseError, type QueryParseErrorCode } from './errors.js';
export { lex, type QueryToken } from './lexer.js';
export { parseQuery, type QueryParseOptions } from './parser.js';
export {
  parseQueryLenient,
  tryParseQueryLenient,
  type LenientParseResult,
  type LenientParseOk,
  type LenientParseFail,
  type LenientRepair,
} from './lenient.js';
