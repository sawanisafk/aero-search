/**
 * Ranking strategies: pluggable score functions over boolean candidates.
 *
 * All strategies share one contract (types.ts): analyzed query + candidate
 * docIds in, deterministic ScoredDoc[] out. Scoring walks the POSTINGS of the
 * query's positive terms (O(Σ df) per query — cost tracks query terms, not
 * corpus size) and only accumulates into flagged candidates.
 *
 * Registry (ARCHITECTURE §6 modes):
 *   boolean                      — unranked baseline (docId order)
 *   tfidf              (mode A)  — TF-IDF, selectable tf weighting
 *   bm25               (mode B)  — Okapi BM25, configurable k1/b
 *   bm25-phrase        (mode C)  — BM25 + exact-phrase bonus (ablation arm)
 *   bm25-phrase-proximity (mode C) — + proximity window signal (full mode C)
 *
 * Mode-C composition is RAW-additive (bm25 + phrase + proximity). That is
 * deliberate: normalization and cross-signal fusion are M4 (ARCHITECTURE §6),
 * out of M2 scope — M2 measures the raw signals as they are.
 */

import type { IndexReader } from '../index/reader.js';
import {
  positiveQueryTerms,
  type AnalyzedQuery,
} from '../retrieval/analyze-query.js';
import { matchPhrase } from '../retrieval/phrase.js';
import { minimumWindow, proximityScore } from '../retrieval/proximity.js';
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

interface Component {
  readonly name: string;
  readonly values: Float64Array;
}

/** One ScoredDoc per candidate: score = Σ components, breakdown = per-component. */
function assemble(candidates: Uint32Array, components: Component[]): ScoredDoc[] {
  const out: ScoredDoc[] = [];
  for (const docId of candidates) {
    const breakdown: Record<string, number> = {};
    let score = 0;
    for (const component of components) {
      const v = component.values[docId]!;
      breakdown[component.name] = v;
      score += v;
    }
    out.push({ docId, score, breakdown });
  }
  return sortScored(out);
}

/** Phrase leaves of the analyzed query (each entry: ordered analyzed terms). */
function phraseLeaves(query: AnalyzedQuery): string[][] {
  const out: string[][] = [];
  const walk = (node: AnalyzedQuery): void => {
    switch (node.kind) {
      case 'phrase':
        if (node.terms.length > 0) out.push([...node.terms]);
        return;
      case 'term':
        return;
      case 'and':
      case 'or':
        walk(node.left);
        walk(node.right);
        return;
      case 'not':
        return;
    }
  };
  walk(query);
  return out;
}

function accumulateBm25(
  reader: IndexReader,
  analyzed: AnalyzedQuery,
  candidates: Uint32Array,
  options: Bm25Options,
): Float64Array {
  const params = resolveBm25(options);
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
      scores[docId] = scores[docId]! + bm25TermScore(tf, view.df, stats.numDocs, ratio, params);
    });
  }
  return scores;
}

/** Per-candidate additive bonus: +bonus for every phrase leaf matched exactly. */
function accumulatePhraseBonus(
  reader: IndexReader,
  analyzed: AnalyzedQuery,
  candidates: Uint32Array,
  bonus: number,
): Float64Array {
  const scores = new Float64Array(reader.numDocs());
  if (bonus === 0) return scores;
  const flags = candidateFlags(candidates, reader.numDocs());
  for (const terms of phraseLeaves(analyzed)) {
    for (const docId of matchPhrase(reader, terms)) {
      if (flags[docId] === 1) scores[docId] = scores[docId]! + bonus;
    }
  }
  return scores;
}

/** Per-candidate proximity signal over the query's positive terms. */
function accumulateProximity(
  reader: IndexReader,
  analyzed: AnalyzedQuery,
  candidates: Uint32Array,
  k: number,
): Float64Array {
  const scores = new Float64Array(reader.numDocs());
  if (k === 0) return scores;
  const terms = positiveQueryTerms(analyzed);
  if (terms.length < 2) return scores; // window over 1 term carries no signal
  for (const docId of candidates) {
    const window = minimumWindow(reader, terms, docId);
    scores[docId] = proximityScore(window, terms.length, k);
  }
  return scores;
}

/** Unranked baseline: every candidate is a match; order is docId ascending. */
export const booleanStrategy: RankingStrategy = Object.freeze({
  id: 'boolean',
  mode: 'BOOL',
  rank(_reader: IndexReader, _analyzed: AnalyzedQuery, candidates: Uint32Array) {
    return assemble(candidates, [
      { name: 'boolean', values: new Float64Array(_reader.numDocs()) },
    ]);
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
      return assemble(candidates, [{ name: 'tfidf', values: scores }]);
    },
  };
}

export function bm25Strategy(options: Bm25Options = {}): RankingStrategy {
  const params = resolveBm25(options);
  return {
    id: `bm25-k${params.k1}-b${params.b}`,
    mode: 'B',
    rank(reader, analyzed, candidates) {
      return assemble(candidates, [
        { name: 'bm25', values: accumulateBm25(reader, analyzed, candidates, options) },
      ]);
    },
  };
}

export interface PhraseStrategyOptions extends Bm25Options {
  /** additive bonus per exactly-matched phrase leaf (default 1.2) */
  readonly phraseBonus?: number;
}

export interface ProximityStrategyOptions extends PhraseStrategyOptions {
  /** scale k of k/(1+(window−|q|)); 0 disables the signal (default 1.0) */
  readonly proximityK?: number;
}

export function bm25PhraseStrategy(options: PhraseStrategyOptions = {}): RankingStrategy {
  resolveBm25(options); // validate k1/b eagerly (thrown at construction, not first query)
  const bonus = options.phraseBonus ?? 1.2;
  if (!Number.isFinite(bonus) || bonus < 0) {
    throw new RangeError(`phraseBonus must be ≥ 0, got ${bonus}`);
  }
  return {
    id: 'bm25-phrase',
    mode: 'C',
    rank(reader, analyzed, candidates) {
      return assemble(candidates, [
        { name: 'bm25', values: accumulateBm25(reader, analyzed, candidates, options) },
        { name: 'phrase', values: accumulatePhraseBonus(reader, analyzed, candidates, bonus) },
      ]);
    },
  };
}

export function bm25PhraseProximityStrategy(
  options: ProximityStrategyOptions = {},
): RankingStrategy {
  resolveBm25(options); // validate k1/b eagerly (thrown at construction, not first query)
  const bonus = options.phraseBonus ?? 1.2;
  const k = options.proximityK ?? 1.0;
  if (!Number.isFinite(bonus) || bonus < 0) throw new RangeError(`phraseBonus must be ≥ 0, got ${bonus}`);
  if (!Number.isFinite(k) || k < 0) throw new RangeError(`proximityK must be ≥ 0, got ${k}`);
  return {
    id: 'bm25-phrase-proximity',
    mode: 'C',
    rank(reader, analyzed, candidates) {
      return assemble(candidates, [
        { name: 'bm25', values: accumulateBm25(reader, analyzed, candidates, options) },
        { name: 'phrase', values: accumulatePhraseBonus(reader, analyzed, candidates, bonus) },
        { name: 'proximity', values: accumulateProximity(reader, analyzed, candidates, k) },
      ]);
    },
  };
}

/** Strategies registered by id — the experiment runner looks strategies up here. */
export const RANKING_STRATEGIES: Readonly<Record<string, RankingStrategy>> = Object.freeze({
  boolean: booleanStrategy,
  tfidf: tfidfStrategy(),
  bm25: bm25Strategy(),
  'bm25-phrase': bm25PhraseStrategy(),
  'bm25-phrase-proximity': bm25PhraseProximityStrategy(),
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
