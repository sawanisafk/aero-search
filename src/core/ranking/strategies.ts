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
 *   bm25-pr            (mode D)  — normalized fusion of BM25 + PageRank
 *
 * Mode-C composition is RAW-additive (bm25 + phrase + proximity) — M2
 * measures raw signals as they are. Mode D is the first FUSED strategy
 * (M4-B): both signals are per-query min-max normalized (fusion.ts, outlier
 * guard) before the weighted sum, because BM25 (~0–40) and PageRank
 * (~1/N scale) are incommensurable (ARCHITECTURE §6).
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
import { normalizeScores } from './fusion.js';
import { sortScored, type RankingStrategy, type ScoredDoc } from './types.js';

/** Defaults for mode-C knobs — exported so run artifacts can record them. */
export const DEFAULT_PHRASE_BONUS = 1.2;
export const DEFAULT_PROXIMITY_K = 1.0;

/** Defaults for mode-D fusion knobs (recorded in experiment artifacts). */
export const DEFAULT_PR_WEIGHT = 0.2;
// Plain min-max by default — the p95 outlier guard measurably HURTS fusion
// on SciFact (top-candidate band condensation; see docs/EXPERIMENTS.md M4-B).
export const DEFAULT_NORM_GUARD = 1;

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
  const bonus = options.phraseBonus ?? DEFAULT_PHRASE_BONUS;
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
  const bonus = options.phraseBonus ?? DEFAULT_PHRASE_BONUS;
  const k = options.proximityK ?? DEFAULT_PROXIMITY_K;
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

export interface PageRankStrategyOptions extends Bm25Options {
  /** docId -> PageRank value (length must equal the index doc count). */
  readonly pagerank: Float64Array;
  /** weight of the PageRank signal in the fused score; BM25 keeps 1−w. [0, 1] */
  readonly prWeight?: number;
  /** guard percentile for BOTH normalizations (1 = plain min-max). Default 1. */
  readonly normGuard?: number;
}

/**
 * Mode D: `score = (1−w)·ŝ_bm25 + w·ŝ_pagerank`.
 *
 * Normalization scopes differ by signal semantics (ARCHITECTURE §6):
 * - BM25 is query-dependent → min-max per query over the query's candidates.
 * - PageRank is query-independent → min-max ONCE over the whole corpus.
 *   Per-candidate min-max on PageRank would stretch its near-flat tail
 *   (most papers sit on the teleport floor) to the full [0, 1] per query —
 *   amplifying rounding-level differences into full-scale noise that
 *   overrides BM25's top hits (observed: MAP 0.64 → 0.12 at w=0.2).
 *
 * Both use the outlier-guarded quantile mapping (fusion.ts): strictly
 * monotone, bounded [0, 1], no ties. Breakdown entries are the weighted
 * components, so they sum to `score`.
 */
export function bm25PageRankStrategy(options: PageRankStrategyOptions): RankingStrategy {
  const params = resolveBm25(options);
  const w = options.prWeight ?? DEFAULT_PR_WEIGHT;
  const guard = options.normGuard ?? DEFAULT_NORM_GUARD;
  if (!Number.isFinite(w) || w < 0 || w > 1) throw new RangeError(`prWeight must be in [0, 1], got ${w}`);
  if (!(guard > 0 && guard <= 1)) throw new RangeError(`normGuard must be in (0, 1], got ${guard}`);
  if (!(options.pagerank instanceof Float64Array)) throw new TypeError('pagerank must be a Float64Array');
  // Corpus-global PageRank normalization, computed once (query-independent).
  const allDocs = new Uint32Array(options.pagerank.length);
  for (let i = 0; i < allDocs.length; i++) allDocs[i] = i;
  const prGlobal = normalizeScores(options.pagerank, allDocs, { guardPercentile: guard });
  return {
    id: `bm25-pr-w${w}`,
    mode: 'D',
    rank(reader, analyzed, candidates) {
      if (options.pagerank.length !== reader.numDocs()) {
        throw new Error(
          `pagerank has ${options.pagerank.length} entries but index has ${reader.numDocs()} docs`,
        );
      }
      const bm25Raw = accumulateBm25(reader, analyzed, candidates, options);
      const bm25Norm = normalizeScores(bm25Raw, candidates, { guardPercentile: guard });
      // Weighted components: assemble derives score = Σ breakdown by construction.
      const bm25Part: Float64Array = new Float64Array(reader.numDocs());
      const prPart: Float64Array = new Float64Array(reader.numDocs());
      for (const docId of candidates) {
        bm25Part[docId] = (1 - w) * bm25Norm[docId]!;
        prPart[docId] = w * prGlobal[docId]!;
      }
      return assemble(candidates, [
        { name: 'bm25', values: bm25Part },
        { name: 'pagerank', values: prPart },
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

/**
 * Every strategy id createStrategy accepts — the static registry plus
 * data-dependent strategies (mode D needs a PageRank vector, so it cannot be
 * pre-registered). Experiment tooling validates against this list.
 */
export const STRATEGY_IDS: readonly string[] = Object.freeze([
  ...Object.keys(RANKING_STRATEGIES),
  'bm25-pr',
]);

export function getRankingStrategy(id: string): RankingStrategy {
  const strategy = RANKING_STRATEGIES[id];
  if (strategy === undefined) {
    throw new Error(
      `unknown ranking strategy "${id}" (available: ${Object.keys(RANKING_STRATEGIES).join(', ')})`,
    );
  }
  return strategy;
}

/**
 * All tunable knobs for configured construction (experiment runner).
 * Properties may be explicitly undefined — meaning "use the default".
 */
export interface CreateStrategyOptions {
  readonly k1?: number | undefined;
  readonly b?: number | undefined;
  readonly tf?: TfWeighting | undefined;
  readonly phraseBonus?: number | undefined;
  readonly proximityK?: number | undefined;
  /** mode D only: docId -> PageRank value (required for `bm25-pr`). */
  readonly pagerank?: Float64Array | undefined;
  /** mode D only: PageRank weight in [0, 1] (default 0.2). */
  readonly prWeight?: number | undefined;
  /** mode D only: normalization guard percentile in (0, 1] (default 0.95). */
  readonly normGuard?: number | undefined;
}

/** Explicit-undefined-tolerant option subsets (exactOptionalPropertyTypes). */
function partialBm25(o: CreateStrategyOptions): Bm25Options {
  return { ...(o.k1 === undefined ? {} : { k1: o.k1 }), ...(o.b === undefined ? {} : { b: o.b }) };
}

function partialPhrase(o: CreateStrategyOptions): PhraseStrategyOptions {
  return { ...partialBm25(o), ...(o.phraseBonus === undefined ? {} : { phraseBonus: o.phraseBonus }) };
}

/**
 * Build a strategy by id with explicit parameter overrides — the single
 * source of truth used by the experiment runner so a run artifact's recorded
 * params exactly match the strategy instance that produced the numbers.
 * Unknown ids fail with the same message as getRankingStrategy.
 */
export function createStrategy(id: string, options: CreateStrategyOptions = {}): RankingStrategy {
  const { tf, proximityK, pagerank, prWeight, normGuard } = options;
  switch (id) {
    case 'boolean':
      return booleanStrategy;
    case 'tfidf':
      return tfidfStrategy(tf === undefined ? {} : { tf });
    case 'bm25':
      return bm25Strategy(partialBm25(options));
    case 'bm25-phrase':
      return bm25PhraseStrategy(partialPhrase(options));
    case 'bm25-phrase-proximity':
      return bm25PhraseProximityStrategy({
        ...partialPhrase(options),
        ...(proximityK === undefined ? {} : { proximityK }),
      });
    case 'bm25-pr': {
      if (pagerank === undefined) {
        throw new Error('bm25-pr requires options.pagerank (docId -> PageRank Float64Array)');
      }
      return bm25PageRankStrategy({
        ...partialBm25(options),
        pagerank,
        ...(prWeight === undefined ? {} : { prWeight }),
        ...(normGuard === undefined ? {} : { normGuard }),
      });
    }
    default:
      throw new Error(
        `unknown ranking strategy "${id}" (available: ${STRATEGY_IDS.join(', ')})`,
      );
  }
}

/**
 * Fully-resolved parameter set for a strategy id — what a run artifact must
 * record so the numbers are reproducible (undefined option = default value).
 * Parameters are validated by createStrategy; call that first.
 */
export function resolveStrategyParams(
  id: string,
  options: CreateStrategyOptions = {},
): Readonly<Record<string, number | string>> {
  switch (id) {
    case 'boolean':
      return {};
    case 'tfidf':
      return { tf: options.tf ?? DEFAULT_TF_WEIGHTING };
    case 'bm25': {
      const p = resolveBm25(partialBm25(options));
      return { k1: p.k1, b: p.b };
    }
    case 'bm25-phrase': {
      const p = resolveBm25(partialBm25(options));
      return { k1: p.k1, b: p.b, phraseBonus: options.phraseBonus ?? DEFAULT_PHRASE_BONUS };
    }
    case 'bm25-phrase-proximity': {
      const p = resolveBm25(partialBm25(options));
      return {
        k1: p.k1,
        b: p.b,
        phraseBonus: options.phraseBonus ?? DEFAULT_PHRASE_BONUS,
        proximityK: options.proximityK ?? DEFAULT_PROXIMITY_K,
      };
    }
    case 'bm25-pr': {
      const p = resolveBm25(partialBm25(options));
      return {
        k1: p.k1,
        b: p.b,
        prWeight: options.prWeight ?? DEFAULT_PR_WEIGHT,
        normBm25: 'minmax-query',
        normPr: 'minmax-corpus',
        normGuard: options.normGuard ?? DEFAULT_NORM_GUARD,
      };
    }
    default:
      throw new Error(
        `unknown ranking strategy "${id}" (available: ${STRATEGY_IDS.join(', ')})`,
      );
  }
}
