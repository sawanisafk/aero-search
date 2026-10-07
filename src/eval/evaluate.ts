/**
 * Run evaluation: per-query metrics + aggregation into a summary.
 *
 * Evaluation iterates over the QRELS, not the run: the query set defines the
 * task, so a query the run missed counts as an empty ranking (all zeros) —
 * a retrieval failure cannot be hidden by skipping a query.
 */

import {
  averagePrecision,
  f1AtK,
  ndcgAtK,
  precisionAtK,
  recallAtK,
} from './metrics.js';
import { DEFAULT_K_VALUES, type EvaluationSummary, type Qrels, type QueryResult, type Run } from './types.js';

function relevantDocs(judgments: ReadonlyMap<string, number>): Set<string> {
  const out = new Set<string>();
  for (const [docId, grade] of judgments) {
    if (grade > 0) out.add(docId);
  }
  return out;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Metrics for one query. Missing from run => empty ranking => zeros. */
export function evaluateQuery(
  queryId: string,
  ranked: readonly string[] | undefined,
  judgments: ReadonlyMap<string, number>,
  kValues: readonly number[] = DEFAULT_K_VALUES,
): QueryResult {
  const ranking = ranked ?? [];
  const relevant = relevantDocs(judgments);

  const precision: Record<number, number> = {};
  const recall: Record<number, number> = {};
  const f1: Record<number, number> = {};
  const ndcg: Record<number, number> = {};
  for (const k of kValues) {
    precision[k] = precisionAtK(ranking, relevant, k);
    recall[k] = recallAtK(ranking, relevant, k);
    f1[k] = f1AtK(ranking, relevant, k);
    ndcg[k] = ndcgAtK(ranking, judgments, k);
  }

  return {
    queryId,
    precision,
    recall,
    f1,
    ndcg,
    averagePrecision: averagePrecision(ranking, relevant),
  };
}

/** Aggregate a run against qrels over every judged query. */
export function evaluateRun(
  run: Run,
  qrels: Qrels,
  kValues: readonly number[] = DEFAULT_K_VALUES,
): EvaluationSummary {
  const perQuery: QueryResult[] = [];
  for (const [queryId, judgments] of qrels) {
    perQuery.push(evaluateQuery(queryId, run.get(queryId), judgments, kValues));
  }

  const average = (pick: (r: QueryResult) => Record<number, number>): Record<number, number> => {
    const out: Record<number, number> = {};
    for (const k of kValues) out[k] = mean(perQuery.map((r) => pick(r)[k]!));
    return out;
  };

  return {
    kValues: [...kValues],
    queries: perQuery.length,
    precision: average((r) => r.precision),
    recall: average((r) => r.recall),
    f1: average((r) => r.f1),
    ndcg: average((r) => r.ndcg),
    map: mean(perQuery.map((r) => r.averagePrecision)),
  };
}
