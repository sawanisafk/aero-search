/**
 * Okapi BM25 from first principles (ADR-004 / ARCHITECTURE §6):
 *
 *   score(q, d) = Σ_t  IDF(t) · tf·(k1+1) / ( tf + k1·(1 − b + b·|d|/avgdl) )
 *   IDF(t) = ln( 1 + (N − df + 0.5)/(df + 0.5) )
 *
 * Defaults k1 = 1.2, b = 0.75 (the literature defaults — exposed as knobs so
 * parameter sensitivity becomes an experiment, not a guess).
 *
 * Why these knobs exist:
 *   k1 controls tf saturation — the 50th occurrence of a term is not 50× the
 *        evidence of the first (denominator asymptotes to k1·lengthNorm).
 *   b controls length normalization — |d|/avgdl penalizes verbosity, b = 0
 *        turns normalization off entirely.
 *
 * The +0.5 smoothing keeps IDF strictly positive even at df = N (no
 * log-of-zero, no negative idf), which is why this form is used verbatim.
 */

export interface Bm25Options {
  /** term-frequency saturation (default 1.2) */
  readonly k1?: number;
  /** length normalization strength in [0, 1] (default 0.75) */
  readonly b?: number;
}

export interface ResolvedBm25Options {
  readonly k1: number;
  readonly b: number;
}

export const DEFAULT_BM25: ResolvedBm25Options = Object.freeze({ k1: 1.2, b: 0.75 });

export function resolveBm25(options: Bm25Options = {}): ResolvedBm25Options {
  const k1 = options.k1 ?? DEFAULT_BM25.k1;
  const b = options.b ?? DEFAULT_BM25.b;
  if (!Number.isFinite(k1) || k1 < 0) throw new RangeError(`bm25 k1 must be ≥ 0, got ${k1}`);
  if (!Number.isFinite(b) || b < 0 || b > 1) throw new RangeError(`bm25 b must be in [0,1], got ${b}`);
  return { k1, b };
}

/** IDF(t) = ln(1 + (N − df + 0.5)/(df + 0.5)) — strictly positive smoothing. */
export function bm25Idf(numDocs: number, df: number): number {
  return Math.log(1 + (numDocs - df + 0.5) / (df + 0.5));
}

/**
 * Single-term contribution to a document's BM25 score.
 * `docLengthRatio` is |d|/avgdl.
 */
export function bm25TermScore(
  tf: number,
  df: number,
  numDocs: number,
  docLengthRatio: number,
  { k1, b }: ResolvedBm25Options,
): number {
  if (tf <= 0) return 0;
  const idf = bm25Idf(numDocs, df);
  const lengthNorm = 1 - b + b * docLengthRatio;
  return (idf * (tf * (k1 + 1))) / (tf + k1 * lengthNorm);
}
