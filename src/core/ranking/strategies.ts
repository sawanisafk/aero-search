/**
 * Ranking strategies: pluggable score functions over boolean candidates.
 *
 * All strategies share one contract (types.ts): analyzed query + candidate
 * docIds in, deterministic ScoredDoc[] out. Scoring always walks the POSTINGS
 * of the query's positive terms (O(Σ df) per query — cost tracks query terms,
 * not corpus size) and only accumulates into flagged candidates.
 *
 * M2 registry (ARCHITECTURE §6 modes):
 *   boolean                     — unranked baseline (docId order)
 *   tfidf   (mode A)            — TF-IDF, selectable tf weighting
 *   bm25    (mode B)            — Okapi BM25, configurable k1/b
 *   bm25-phrase               (mode C, Phase 4) — + phrase bonus
 *   bm25-phrase-proximity     (mode C, Phase 4) — + phrase bonus + proximity
 */

import type { IndexReader } from '../index/reader.js';
import { positiveQueryTerms, type AnalyzedQuery } from '../retrieval/analyze-query.js';
import {
  DEFAULT_TF_WEIGHTING,
  idf,
  maxTermFrequencies,
  tfWeight,
  type TfWeighting,
} from './tfidf.js';
import { bm25TermScore, resolveBm25, type Bm25Options } from './bm25.js';
import { sortScored, type RankingStrategy, type ScoredDoc } from './types.js';

/** Fast "is this doc a candidate?" membership test. */
function candidateFlags(candidates: Uint32Array, numDocs: number): Uint8Array {
  const flags = new Uint8Array(numDocs);
  for (const docId of candidates) flags[docId] = 1;
  return flags;
}

function buildResult(
  candidates: Uint32Array,
  scores: Float64Array,
  component: string,
): ScoredDoc[] {
  const out: ScoredDoc[] = [];
  for (const docId of candidates) {
    out.push({ docId, score: scores[docId]!, breakdown: { [component]: scores[docId]! } });
  }
  return sortScored(out);
}

/** Unranked baseline: every candidate is a match; order is docId ascending. */
export const booleanStrategy: RankingStrategy = Object.freeze({
  id: 'boolean',
  mode: 'BOOL',
  rank(_reader: IndexReader, _analyzed: AnalyzedQuery, candidates: Uint32Array): ScoredDoc[] {
    const out: ScoredDoc[] = [];
    for (const docId of candidates) out.push({ docId, score: 0, breakdown: { boolean: 0 } });
    return out;
  },
});

export interface TfidfOptions {
  readonly tf?: TfWeighting;
}

export function tfidfStrategy(options: TfidfOptions = {}): RankingStrategy {
  const weighting = options.tf ?? DEFAULT_TF_WEIGHTING;
  return {
    id: `tfidf-${weighting}`,
    mode: 'A',
    rank(reader, analyzed, candidates) {
      const { numDocs } = reader.stats();
      const flags = candidateFlags(candidates, numDocs);
      const scores = new Float64Array(numDocs);
      const maxTf = weighting === 'augmented' ? maxTermFrequencies(reader) : null;

      for (const term of positiveQueryTerms(analyzed)) {
        const view = reader.postingsForTerm(term);
        if (view === null) continue;
        const termIdf = idf(numDocs, view.df);
        view.forEach((_index, docId, tf) => {
          if (flags[docId] === 0) return;
          const w = tfWeight(tf, maxTf === null ? tf : maxTf[docId]!, weighting);
          scores[docId] = scores[docId]! + termIdf * w;
        });
      }
      return buildResult(candidates, scores, 'tfidf');
    },
  };
}

export function bm25Strategy(options: Bm25Options = {}): RankingStrategy {
  const params = resolveBm25(options);
  return {
    id: `bm25-k${params.k1}-b${params.b}`,
    mode: 'B',
    rank(reader, analyzed, candidates) {
      const stats = reader.stats();
      const flags = candidateFlags(candidates, stats.numDocs);
      const scores = new Float64Array(stats.numDocs);
      const avgdl = stats.avgDocLength;

      for (const term of positiveQueryTerms(analyzed)) {
        const view = reader.postingsForTerm(term);
        if (view === null) continue;
        view.forEach((_index, docId, tf) => {
          if (flags[docId] === 0) return;
          const ratio = avgdl === 0 ? 0 : reader.docLength(docId) / avgdl;
          scores[docId] =
            scores[docId]! + bm25TermScore(tf, view.df, stats.numDocs, ratio, params);
        });
      }
      return buildResult(candidates, scores, 'bm25');
    },
  };
}

/** Strategies registered by id — the experiment runner looks strategies up here. */
export const RANKING_STRATEGIES: Readonly<Record<string, RankingStrategy>> = Object.freeze({
  boolean: booleanStrategy,
  tfidf: tfidfStrategy(),
  bm25: bm25Strategy(),
});

export function getRankingStrategy(id: string): RankingStrategy {
  const strategy = RANKING_STRATEGIES[id];
  if (strategy === undefined) {
    throw new Error(
      `unknown ranking strategy "${id}" (available: ${Object.keys(RANKING_STRATEGIES).join(', ')})`,
    );
  }
  return strategy;
}
