/**
 * Fuzzy (typo-tolerant) term expansion — M4-C.
 *
 * Problem: a query term that is absent from the dictionary (`seach` for
 * `search`) contributes the empty set ∅ to Boolean retrieval — the query
 * silently returns nothing. Bounded edit-distance expansion recovers it.
 *
 * Method: QUERY-TIME probing against the reader's dictionary — no
 * index-layout change (the M1 freeze stands):
 *   - distance ≤ 1: generate the ~27·len variants directly (delete /
 *     substitute / insert over a-z) and probe the O(1) term hash;
 *   - distance ≤ 2 (opt-in): a bounded dictionary scan — every term with
 *     length within ±2, verified by `boundedEditDistance(.., 2)` with early
 *     exit. (Composing edit1×edit1 was quadratic — measured 1.55 s worst
 *     case — so the scan is both faster and complete: no truncation.)
 *     Only run when distance-1 did not already fill the per-term cap
 *     (distance-1 candidates outrank distance-2 anyway), and only for
 *     terms of length ≥ 5 — this is what keeps "bounded" honest.
 *
 * Applied ONLY to term leaves whose analyzed form is missing from the
 * dictionary — terms that already exist are never expanded (exact match
 * wins), phrase leaves keep positional semantics, and NOT subtrees are left
 * alone (expanding a negated typo would exclude documents wrongly).
 *
 * Strict limits, all recorded in run artifacts:
 *   maxEdits ∈ {1, 2} · minTermLength · maxExpansionsPerTerm ·
 *   maxFuzzyTermsPerQuery (absent terms attempted) ·
 *   maxExpansionsPerQuery (variants added overall)
 *
 * Integration: `expandFuzzyQuery` annotates term leaves with their variants
 * (leaf = original ∪ alternatives, union semantics in evalAnalyzed), so
 * candidate retrieval AND scoring (positiveQueryTerms walks every leaf term)
 * see the alternatives with their real idf — one transformation, both layers.
 */

import type { IndexReader } from '../index/reader.js';
import type { AnalyzedQuery } from './analyze-query.js';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

export interface FuzzyOptions {
  /** Maximum edit distance for expansion. 1 or 2. Default 1. */
  readonly maxEdits?: number;
  /** Terms shorter than this are never expanded. Default 3. */
  readonly minTermLength?: number;
  /** Variants kept per fuzzy term (ordered by distance, then df desc). Default 10. */
  readonly maxExpansionsPerTerm?: number;
  /** Absent terms attempted per query. Default 10. */
  readonly maxFuzzyTermsPerQuery?: number;
  /** Total variants added per query. Default 20. */
  readonly maxExpansionsPerQuery?: number;
}

export interface ResolvedFuzzyOptions {
  readonly maxEdits: 1 | 2;
  readonly minTermLength: number;
  readonly maxExpansionsPerTerm: number;
  readonly maxFuzzyTermsPerQuery: number;
  readonly maxExpansionsPerQuery: number;
}

export const DEFAULT_FUZZY: ResolvedFuzzyOptions = Object.freeze({
  maxEdits: 1,
  minTermLength: 3,
  maxExpansionsPerTerm: 10,
  maxFuzzyTermsPerQuery: 10,
  maxExpansionsPerQuery: 20,
});

/** Distance-2 generation is only attempted for terms of at least this length. */
export const MIN_LENGTH_FOR_EDITS_2 = 5;

export function resolveFuzzy(options: FuzzyOptions = {}): ResolvedFuzzyOptions {
  const maxEdits = options.maxEdits ?? DEFAULT_FUZZY.maxEdits;
  if (maxEdits !== 1 && maxEdits !== 2) {
    throw new RangeError(`fuzzy maxEdits must be 1 or 2, got ${maxEdits}`);
  }
  const num = (name: keyof FuzzyOptions, value: number, min: number): number => {
    if (!Number.isInteger(value) || value < min) {
      throw new RangeError(`fuzzy ${name} must be an integer >= ${min}, got ${value}`);
    }
    return value;
  };
  return {
    maxEdits,
    minTermLength: num('minTermLength', options.minTermLength ?? DEFAULT_FUZZY.minTermLength, 1),
    maxExpansionsPerTerm: num(
      'maxExpansionsPerTerm',
      options.maxExpansionsPerTerm ?? DEFAULT_FUZZY.maxExpansionsPerTerm,
      1,
    ),
    maxFuzzyTermsPerQuery: num(
      'maxFuzzyTermsPerQuery',
      options.maxFuzzyTermsPerQuery ?? DEFAULT_FUZZY.maxFuzzyTermsPerQuery,
      1,
    ),
    maxExpansionsPerQuery: num(
      'maxExpansionsPerQuery',
      options.maxExpansionsPerQuery ?? DEFAULT_FUZZY.maxExpansionsPerQuery,
      1,
    ),
  };
}

/**
 * Levenshtein distance with a hard bound: returns the true distance when it
 * is ≤ maxEdits, otherwise maxEdits + 1 (a sentinel — callers only need to
 * know "outside the bound"). Row-wise DP with per-row minima early exit.
 */
export function boundedEditDistance(a: string, b: string, maxEdits: number): number {
  if (!Number.isInteger(maxEdits) || maxEdits < 0) {
    throw new RangeError(`maxEdits must be an integer >= 0, got ${maxEdits}`);
  }
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxEdits) return maxEdits + 1;
  if (a.length === 0) return b.length <= maxEdits ? b.length : maxEdits + 1;
  if (b.length === 0) return a.length <= maxEdits ? a.length : maxEdits + 1;

  let prev = new Uint32Array(b.length + 1);
  let curr = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0]!;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxEdits) return maxEdits + 1; // every alignment exceeds the bound
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  const dist = prev[b.length]!;
  return dist <= maxEdits ? dist : maxEdits + 1;
}

/** Every string within edit distance 1 (delete / substitute / insert over a-z). */
export function edit1Variants(term: string): Set<string> {
  const out = new Set<string>();
  const n = term.length;
  for (let i = 0; i < n; i++) out.add(term.slice(0, i) + term.slice(i + 1));
  for (let i = 0; i < n; i++) {
    const head = term.slice(0, i);
    const tail = term.slice(i + 1);
    for (let c = 0; c < 26; c++) {
      const ch = ALPHABET[c]!;
      if (ch !== term[i]) out.add(head + ch + tail);
    }
  }
  for (let i = 0; i <= n; i++) {
    const head = term.slice(0, i);
    const tail = term.slice(i);
    for (let c = 0; c < 26; c++) out.add(head + ALPHABET[c]! + tail);
  }
  return out;
}

export interface FuzzyExpansion {
  /** The absent analyzed term that triggered expansion. */
  readonly term: string;
  /** Dictionary alternatives within the bound, ordered (dist asc, df desc, term asc). */
  readonly variants: readonly string[];
  readonly distance: 1 | 2;
}

export interface FuzzyStats {
  readonly termsAttempted: number;
  readonly termsExpanded: number;
  readonly variantsAdded: number;
  /** Counters — every strict limit that actually fired, per query. */
  readonly caps: {
    readonly tooShort: number;
    readonly fuzzyTermsPerQuery: number;
    readonly expansionsPerTerm: number;
    readonly expansionsPerQuery: number;
    readonly edits2SkippedLength: number;
  };
}

export interface FuzzyResult {
  /** Annotated query — expanded term leaves carry [original, ...variants]. */
  readonly query: AnalyzedQuery;
  readonly expansions: readonly FuzzyExpansion[];
  readonly stats: FuzzyStats;
}

interface MutableStats {
  termsAttempted: number;
  termsExpanded: number;
  variantsAdded: number;
  tooShort: number;
  fuzzyTermsPerQuery: number;
  expansionsPerTerm: number;
  expansionsPerQuery: number;
  edits2SkippedLength: number;
}

/**
 * Expand absent term leaves of an analyzed query against the index
 * dictionary. Phrase leaves and NOT subtrees are never touched; terms that
 * exist in the dictionary are never expanded (exact match wins).
 */
export function expandFuzzyQuery(
  reader: IndexReader,
  analyzed: AnalyzedQuery,
  options: FuzzyOptions = {},
): FuzzyResult {
  const opts = resolveFuzzy(options);
  const stats: MutableStats = {
    termsAttempted: 0,
    termsExpanded: 0,
    variantsAdded: 0,
    tooShort: 0,
    fuzzyTermsPerQuery: 0,
    expansionsPerTerm: 0,
    expansionsPerQuery: 0,
    edits2SkippedLength: 0,
  };
  const expansions: FuzzyExpansion[] = [];

  const expandLeaf = (terms: readonly string[]): readonly string[] => {
    let changed = false;
    const out: string[] = [...terms];
    for (const term of terms) {
      if (term.length === 0) continue;
      if (reader.hasTerm(term)) continue; // exact match wins — never expand
      if (term.length < opts.minTermLength) {
        stats.tooShort++;
        continue;
      }
      if (stats.termsAttempted >= opts.maxFuzzyTermsPerQuery) {
        stats.fuzzyTermsPerQuery++; // budget spent; keep counting so it's observable
        continue;
      }
      if (stats.variantsAdded >= opts.maxExpansionsPerQuery) {
        stats.expansionsPerQuery++; // no room left — skip the probes entirely
        continue;
      }
      stats.termsAttempted++;

      const hits = probe(reader, term, opts, stats);
      if (hits.length === 0) continue;

      const byTerm = hits.slice(0, opts.maxExpansionsPerTerm);
      if (byTerm.length < hits.length) stats.expansionsPerTerm++;
      const queryRoom = opts.maxExpansionsPerQuery - stats.variantsAdded;
      const accepted = byTerm.slice(0, Math.max(queryRoom, 0));
      if (accepted.length < byTerm.length) stats.expansionsPerQuery++;
      if (accepted.length === 0) continue;

      for (const v of accepted) out.push(v.term);
      stats.variantsAdded += accepted.length;
      stats.termsExpanded++;
      changed = true;
      expansions.push({
        term,
        variants: accepted.map((h) => h.term),
        distance: accepted[accepted.length - 1]!.distance,
      });
    }
    return changed ? out : terms;
  };

  const walk = (node: AnalyzedQuery, underNot: boolean): AnalyzedQuery => {
    switch (node.kind) {
      case 'term': {
        if (underNot || node.terms.length === 0) return node;
        const terms = expandLeaf(node.terms);
        return terms === node.terms ? node : { kind: 'term', terms };
      }
      case 'phrase':
        return node; // positional semantics — fuzzy does not apply
      case 'and':
      case 'or': {
        const left = walk(node.left, underNot);
        const right = walk(node.right, underNot);
        if (left === node.left && right === node.right) return node;
        return node.kind === 'and' ? { kind: 'and', left, right } : { kind: 'or', left, right };
      }
      case 'not': {
        const operand = walk(node.operand, true);
        return operand === node.operand ? node : { kind: 'not', operand };
      }
    }
  };

  return {
    query: walk(analyzed, false),
    expansions,
    stats: {
      termsAttempted: stats.termsAttempted,
      termsExpanded: stats.termsExpanded,
      variantsAdded: stats.variantsAdded,
      caps: {
        tooShort: stats.tooShort,
        fuzzyTermsPerQuery: stats.fuzzyTermsPerQuery,
        expansionsPerTerm: stats.expansionsPerTerm,
        expansionsPerQuery: stats.expansionsPerQuery,
        edits2SkippedLength: stats.edits2SkippedLength,
      },
    },
  };
}

interface ProbeHit {
  readonly term: string;
  readonly df: number;
  readonly distance: 1 | 2;
}

/**
 * Dictionary probes for one absent term: distance-1 first, distance-2 only
 * when maxEdits = 2, the term is long enough, and distance-1 did not already
 * fill the per-term cap (distance-1 candidates outrank distance-2 anyway).
 * Ordered (distance asc, df desc, term asc) — deterministic.
 */
function probe(reader: IndexReader, term: string, opts: ResolvedFuzzyOptions, stats: MutableStats): ProbeHit[] {
  const seen = new Set<string>([term]);
  const hits: ProbeHit[] = [];

  const collect = (candidates: Set<string>, distance: 1 | 2): void => {
    for (const cand of candidates) {
      if (seen.has(cand)) continue;
      seen.add(cand);
      if (!reader.hasTerm(cand)) continue;
      const view = reader.postingsForTerm(cand);
      hits.push({ term: cand, df: view === null ? 0 : view.df, distance });
    }
  };
  const byRank = (a: ProbeHit, b: ProbeHit): number =>
    a.distance - b.distance || b.df - a.df || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0);

  collect(edit1Variants(term), 1);
  hits.sort(byRank);

  if (opts.maxEdits === 2 && hits.length < opts.maxExpansionsPerTerm) {
    if (term.length < MIN_LENGTH_FOR_EDITS_2) {
      stats.edits2SkippedLength++;
    } else {
      // bounded dictionary scan: length filter first, then early-exit DP
      const lo = term.length - 2;
      const hi = term.length + 2;
      const dict = reader.raw.terms;
      for (const cand of dict) {
        if (cand.length < lo || cand.length > hi) continue;
        if (seen.has(cand)) continue;
        if (boundedEditDistance(term, cand, 2) > 2) continue;
        seen.add(cand);
        if (!reader.hasTerm(cand)) continue;
        const view = reader.postingsForTerm(cand);
        hits.push({ term: cand, df: view === null ? 0 : view.df, distance: 2 });
      }
      hits.sort(byRank);
    }
  }
  return hits;
}
