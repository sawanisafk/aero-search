export { intersect, union, difference, universe } from './boolean.js';
export { analyzeQuery, analyzedLeafTerms, positiveQueryTerms, type AnalyzedQuery } from './analyze-query.js';
export { retrieveBoolean, retrieveAnalyzed } from './evaluate.js';
export { matchPhrase } from './phrase.js';
export { minimumWindow, proximityScore } from './proximity.js';
export { positionsInDoc, containsPosition } from './positions.js';
export {
  boundedEditDistance,
  edit1Variants,
  expandFuzzyQuery,
  resolveFuzzy,
  DEFAULT_FUZZY,
  MIN_LENGTH_FOR_EDITS_2,
  type FuzzyOptions,
  type ResolvedFuzzyOptions,
  type FuzzyExpansion,
  type FuzzyStats,
  type FuzzyResult,
} from './fuzzy.js';
