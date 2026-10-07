export type { ScoredDoc, RankingStrategy, StrategyMode } from './types.js';
export { sortScored } from './types.js';
export {
  idf,
  tfWeight,
  maxTermFrequencies,
  DEFAULT_TF_WEIGHTING,
  type TfWeighting,
} from './tfidf.js';
export {
  bm25Idf,
  bm25TermScore,
  resolveBm25,
  DEFAULT_BM25,
  type Bm25Options,
  type ResolvedBm25Options,
} from './bm25.js';
export {
  booleanStrategy,
  tfidfStrategy,
  bm25Strategy,
  bm25PhraseStrategy,
  bm25PhraseProximityStrategy,
  createStrategy,
  resolveStrategyParams,
  DEFAULT_PHRASE_BONUS,
  DEFAULT_PROXIMITY_K,
  RANKING_STRATEGIES,
  getRankingStrategy,
  type CreateStrategyOptions,
  type TfidfOptions,
  type PhraseStrategyOptions,
  type ProximityStrategyOptions,
} from './strategies.js';
