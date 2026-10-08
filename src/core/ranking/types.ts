/**
 * Ranking contracts: what a strategy receives and what it returns.
 *
 * ScoredDoc matches the ARCHITECTURE §6 explanation contract: `score` is the
 * value the strategy sorts by, `breakdown` exposes the raw per-signal
 * components so /api/search?explain=true (M5) and evaluation can show WHY a
 * document ranked where it did. Components are raw (unnormalized) — fusion
 * and normalization are M4, deliberately out of M2 scope.
 */

import type { IndexReader } from '../index/reader.js';
import type { AnalyzedQuery } from '../retrieval/analyze-query.js';

export interface ScoredDoc {
  readonly docId: number;
  /** strategy score — higher is better; the sort key */
  readonly score: number;
  /** raw signal contributions, e.g. { bm25: 8.1, phrase: 1.2, proximity: 0.4 } */
  readonly breakdown: Readonly<Record<string, number>>;
}

export type StrategyMode = 'A' | 'B' | 'C' | 'D' | 'BOOL';

export interface RankingStrategy {
  /** stable identifier recorded in experiment artifacts */
  readonly id: string;
  /** ARCHITECTURE §6 mode letter ('BOOL' = unranked boolean baseline) */
  readonly mode: StrategyMode;
  /**
   * Score candidate documents for an already-analyzed query.
   * Returns one ScoredDoc per candidate, sorted by score descending,
   * ties broken by smaller docId (deterministic output — evaluation requires it).
   */
  rank(reader: IndexReader, analyzed: AnalyzedQuery, candidates: Uint32Array): ScoredDoc[];
}

/** Sort score-desc, docId-asc — the single ordering rule for all strategies. */
export function sortScored(docs: ScoredDoc[]): ScoredDoc[] {
  return docs.sort((a, b) => b.score - a.score || a.docId - b.docId);
}
