/**
 * IR metrics from first principles — every formula is the textbook definition,
 * each one hand-verified in tests/eval.test.ts (arithmetic written out).
 *
 *   P@K   = |top K ∩ relevant| / K            (K in the denominator even when
 *                                              fewer than K docs were returned:
 *                                              an incomplete run counts against you)
 *   R@K   = |top K ∩ relevant| / |relevant|
 *   F1@K  = 2·P·R / (P + R), 0 when P + R = 0
 *   AP    = (1/|relevant|) · Σ_i  P@i · [rank i is relevant]
 *   MAP   = mean of AP over queries
 *   NDCG@K = DCG@K / IDCG@K
 *           DCG@K  = Σ_{i=1..K} (2^g_i − 1) / log2(i + 1)
 *           IDCG@K = same sum over the query's ideal (grade-descending) order
 *           NDCG   = 0 when IDCG = 0 (no judged relevant docs)
 *
 * Unjudged documents contribute gain 0 to DCG (but still occupy a rank).
 */

/** P@K — precision of the top-k ranking. k must be ≥ 1. */
export function precisionAtK(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (k < 1) throw new RangeError(`k must be ≥ 1, got ${k}`);
  let hits = 0;
  for (let i = 0; i < k && i < ranked.length; i++) {
    if (relevant.has(ranked[i]!)) hits++;
  }
  return hits / k;
}

/** R@K — fraction of all relevant docs found in the top k. 0 if no relevant docs. */
export function recallAtK(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (k < 1) throw new RangeError(`k must be ≥ 1, got ${k}`);
  if (relevant.size === 0) return 0;
  let hits = 0;
  for (let i = 0; i < k && i < ranked.length; i++) {
    if (relevant.has(ranked[i]!)) hits++;
  }
  return hits / relevant.size;
}

/** F1@K — harmonic mean of P@K and R@K. */
export function f1AtK(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  const p = precisionAtK(ranked, relevant, k);
  const r = recallAtK(ranked, relevant, k);
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

/**
 * Average Precision over the full ranking:
 * mean of P@i taken only at ranks where a relevant doc appears, normalized
 * by the total number of relevant docs. 0 when there are no relevant docs.
 */
export function averagePrecision(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
): number {
  if (relevant.size === 0) return 0;
  let hits = 0;
  let sum = 0;
  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i]!)) {
      hits++;
      sum += hits / (i + 1);
    }
  }
  return sum / relevant.size;
}

/**
 * NDCG@K with graded gain (2^g − 1) and log2 rank discount.
 * `grades` maps corpus docId -> grade; anything absent is unjudged (gain 0).
 */
export function ndcgAtK(
  ranked: readonly string[],
  grades: ReadonlyMap<string, number>,
  k: number,
): number {
  if (k < 1) throw new RangeError(`k must be ≥ 1, got ${k}`);

  let dcg = 0;
  for (let i = 0; i < k && i < ranked.length; i++) {
    const g = grades.get(ranked[i]!) ?? 0;
    if (g > 0) dcg += (2 ** g - 1) / Math.log2(i + 2);
  }

  const ideal = [...grades.values()].filter((g) => g > 0).sort((a, b) => b - a);
  let idcg = 0;
  for (let i = 0; i < k && i < ideal.length; i++) {
    idcg += (2 ** ideal[i]! - 1) / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}
