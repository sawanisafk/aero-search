/**
 * Evaluation data model (M2 qrels v1).
 *
 * Identifiers are STRINGS everywhere: TREC/BEIR judgments key documents by
 * corpus ids ("4983"), not by our internal docIds. Keeping metrics stringly
 * typed makes them dataset-agnostic and lets tests hand-write tiny fixtures;
 * the experiment runner owns the corpus-id <-> docId mapping (I/O side).
 *
 * Grades are numbers: binary corpora (SciFact) use 1, graded corpora use
 * 0..4; absence from the map means UNJUDGED (implicit grade 0 — unjudged is
 * not the same as judged-irrelevant in TREC practice, but for the metrics
 * implemented here both contribute no gain; documented in EVALUATION.md).
 */

/** queryId -> (corpusDocId -> relevance grade, higher = more relevant) */
export type Qrels = ReadonlyMap<string, ReadonlyMap<string, number>>;

/** queryId -> ranked corpusDocIds, best first */
export type Run = ReadonlyMap<string, readonly string[]>;

export interface QueryResult {
  readonly queryId: string;
  /** mean over evaluated queries of each metric at each k */
  readonly precision: Readonly<Record<number, number>>;
  readonly recall: Readonly<Record<number, number>>;
  readonly f1: Readonly<Record<number, number>>;
  readonly ndcg: Readonly<Record<number, number>>;
  readonly averagePrecision: number;
}

export interface EvaluationSummary {
  readonly kValues: readonly number[];
  /** number of queries from qrels that were evaluated (missing run -> empty ranking) */
  readonly queries: number;
  readonly precision: Readonly<Record<number, number>>;
  readonly recall: Readonly<Record<number, number>>;
  readonly f1: Readonly<Record<number, number>>;
  readonly ndcg: Readonly<Record<number, number>>;
  readonly map: number;
}

export const DEFAULT_K_VALUES: readonly number[] = Object.freeze([1, 5, 10, 100]);
