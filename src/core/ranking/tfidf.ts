/**
 * TF-IDF from first principles (ARCHITECTURE §6):
 *
 *   score(q, d) = Σ_t  tf_weight(t, d) · idf(t),   idf(t) = ln(N / df_t)
 *
 * Three tf weightings are selectable because tf treatment is an EXPERIMENTAL
 * axis (which one wins is an evaluation question, not a taste question):
 *
 *   raw       tf                     — unbounded, frequent terms dominate
 *   log       1 + ln(tf)             — logarithmic damping, never below 1
 *   augmented 0.5 + 0.5·tf/maxtf(d)  — bounded to (0.5, 1], normalizes by the
 *                                      document's most frequent term
 *
 * maxtf(d) requires the max term frequency per document, which the inverted
 * layout does not store directly (no forward index in M1/M2 — M1 freeze).
 * It is computed once per index by scanning all postings and cached per
 * IndexReader instance, so repeated queries pay nothing (O(postings) once).
 *
 * tf = 0 (term absent from candidate) contributes 0 for every weighting.
 */

import type { IndexReader } from '../index/reader.js';

export type TfWeighting = 'raw' | 'log' | 'augmented';

export const DEFAULT_TF_WEIGHTING: TfWeighting = 'raw';

/** idf(t) = ln(N / df). df ≤ N so this is ≥ 0 (0 when every doc matches). */
export function idf(numDocs: number, df: number): number {
  return Math.log(numDocs / df);
}

/** tf weighting at tf (tf ≥ 1); returns 0 for tf = 0 (absent term). */
export function tfWeight(tf: number, maxTfDoc: number, weighting: TfWeighting): number {
  if (tf <= 0) return 0;
  switch (weighting) {
    case 'raw':
      return tf;
    case 'log':
      return 1 + Math.log(tf);
    case 'augmented':
      return 0.5 + (0.5 * tf) / Math.max(maxTfDoc, tf);
  }
}

const MAX_TF_CACHE = new WeakMap<object, Uint32Array>();

/**
 * Per-document maximum term frequency, computed once per reader and cached.
 * Full pass over all postings: O(numPostings), amortized to zero across the
 * queries of an evaluation run.
 */
export function maxTermFrequencies(reader: IndexReader): Uint32Array {
  const cached = MAX_TF_CACHE.get(reader);
  if (cached !== undefined) return cached;

  const maxTf = new Uint32Array(reader.numDocs());
  const numTerms = reader.stats().vocabSize;
  for (let termId = 0; termId < numTerms; termId++) {
    reader.postings(termId).forEach((_index, docId, tf) => {
      if (tf > maxTf[docId]!) maxTf[docId] = tf;
    });
  }
  MAX_TF_CACHE.set(reader, maxTf);
  return maxTf;
}
