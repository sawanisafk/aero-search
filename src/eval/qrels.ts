/**
 * Pure parsers for evaluation inputs (string in -> structures out).
 * File reading/writing lives in scripts/ — src/eval stays I/O-free so the
 * metrics can be tested and reused anywhere (module rules, ARCHITECTURE).
 *
 * Supported formats (M2):
 *   - BEIR qrels TSV: header `query-id\tcorpus-id\tscore` + one row per
 *     judgment (SciFact ships exactly this). Scores are relevance grades:
 *     binary corpora use 1, graded corpora 0..4.
 *   - BEIR queries JSONL: one JSON object per line with `_id` and `text`.
 * Both parsers are strict: malformed rows/lines throw with a 1-based line
 * number — silent data loss in an evaluation harness is unacceptable.
 */

import type { Qrels } from './types.js';

const QRELS_HEADER = 'query-id\tcorpus-id\tscore';

export function parseQrelsTsv(tsv: string): Qrels {
  const qrels = new Map<string, Map<string, number>>();
  const lines = tsv.split(/\r?\n/);

  let start = 0;
  const first = lines[0]?.trim() ?? '';
  if (first === QRELS_HEADER) start = 1;
  else if (first.startsWith('query-id')) {
    throw new Error(`qrels line 1: unexpected header "${first}" (expected "${QRELS_HEADER}")`);
  }

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    const lineNo = i + 1;
    const cols = line.split('\t');
    if (cols.length !== 3) {
      throw new Error(`qrels line ${lineNo}: expected 3 tab-separated columns, got ${cols.length}`);
    }
    const [queryId, docId, rawScore] = cols as [string, string, string];
    const score = Number(rawScore);
    if (!Number.isFinite(score) || score < 0) {
      throw new Error(`qrels line ${lineNo}: invalid score "${rawScore}"`);
    }
    let judgments = qrels.get(queryId);
    if (judgments === undefined) {
      judgments = new Map<string, number>();
      qrels.set(queryId, judgments);
    }
    if (judgments.has(docId)) {
      throw new Error(`qrels line ${lineNo}: duplicate judgment for query ${queryId} doc ${docId}`);
    }
    judgments.set(docId, score);
  }
  return qrels;
}

export function parseQueriesJsonl(jsonl: string): Map<string, string> {
  const queries = new Map<string, string>();
  const lines = jsonl.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    const lineNo = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new Error(`queries line ${lineNo}: invalid JSON (${(e as Error).message})`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`queries line ${lineNo}: expected a JSON object`);
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj['_id'] !== 'string' || typeof obj['text'] !== 'string') {
      throw new Error(`queries line ${lineNo}: missing string fields "_id" and "text"`);
    }
    queries.set(obj['_id'], obj['text']);
  }
  return queries;
}
