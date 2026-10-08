/**
 * Score normalization for cross-signal fusion (ARCHITECTURE §6: "BM25 (~0–40),
 * PageRank (~0–0.02) ... normalization is mandatory before any weighted sum").
 *
 * Default: plain per-signal min-max over the values being compared — strictly
 * monotone, bounded [0, 1], degenerate ranges (all equal) → 0.
 *
 * Optional outlier guard (`guardPercentile`, e.g. 0.95): split the value range
 * at the guard quantile; the pack spreads across [0, guard] and the tail above
 * the anchor gets the remaining band:
 *
 *   v ≤ anchor:  guard · (v − min) / (anchor − min)
 *   v > anchor:  guard + (1 − guard) · (v − anchor) / (max − anchor)
 *
 * Meant for runaway outliers that would otherwise compress everything else
 * toward 0. EMPIRICALLY OFF BY DEFAULT for mode-D fusion: evaluated on
 * SciFact, guarding at p95 inflated the candidate pack (top ~5% of a
 * 1700–3000-candidate query all land in [0.95, 1]) and destroyed BM25's
 * top-end discrimination — MAP collapsed 0.64 → 0.12 at w=0.2 (see the M4-B
 * ablation in docs/EXPERIMENTS.md). Guard stays available as a knob because
 * it does help when a single document genuinely owns the scale; it is
 * strictly monotone either way (no distinct scores ever tie).
 *
 * Deterministic: no randomness, quantiles by nearest rank, same inputs →
 * same outputs.
 */

export interface NormalizeOptions {
  /** Percentile split anchor for the outlier guard; 1 = plain min-max. Default 1. */
  readonly guardPercentile?: number;
}

/** Nearest-rank quantile (q in [0, 1]) over an ascending-sorted copy. */
function quantile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(q * sorted.length) - 1;
  return sorted[Math.min(Math.max(idx, 0), sorted.length - 1)]!;
}

/**
 * Normalize `raw` at the candidate docIds into [0, 1]; non-candidates stay 0.
 * Returns a new array — inputs are never mutated.
 */
export function normalizeScores(
  raw: Float64Array,
  candidates: Uint32Array,
  options: NormalizeOptions = {},
): Float64Array {
  const guard = options.guardPercentile ?? 1;
  if (!(guard > 0 && guard <= 1)) {
    throw new RangeError(`guardPercentile must be in (0, 1], got ${guard}`);
  }

  const out = new Float64Array(raw.length);
  if (candidates.length === 0) return out;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const docId of candidates) {
    const v = raw[docId]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max === min) return out; // no discrimination → contribute nothing

  const sorted = new Float64Array(candidates.length);
  let i = 0;
  for (const docId of candidates) sorted[i++] = raw[docId]!;
  sorted.sort();

  const anchor = quantile(sorted, guard);
  const packRange = anchor - min;
  const tailRange = max - anchor;
  const split = tailRange > 0; // anchor < max: guard band actually active
  for (const docId of candidates) {
    const v = raw[docId]!;
    let norm: number;
    if (v <= anchor) {
      // anchor === min ⇒ only v === min sits here → 0 (guard·0/0 avoided).
      // No tail (anchor === max, e.g. small candidate sets) ⇒ plain min-max.
      norm = packRange > 0 ? ((split ? guard : 1) * (v - min)) / packRange : 0;
    } else {
      norm = guard + ((1 - guard) * (v - anchor)) / tailRange;
    }
    out[docId] = norm > 1 ? 1 : norm < 0 ? 0 : norm;
  }
  return out;
}
