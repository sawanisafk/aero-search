/**
 * Proximity: the smallest window containing at least one occurrence of every
 * query term in a document (ARCHITECTURE §5 — "smallest window containing
 * all query terms").
 *
 *   window = max(position used) − min(position used) + 1
 *   proximity score = k / (1 + (window − |q|))
 *
 * Adjacency gives the maximum: window = |q| ⇒ score = k; every extra token
 * between query terms costs one more unit of denominator. |q| = 1 has no
 * meaningful notion of proximity (window is trivially 1 for every match) —
 * callers guard on ≥ 2 terms (the mode-C strategy does).
 *
 * Returns null when any term is absent from the document (no window exists).
 *
 * Independent of BM25 by design: proximity is a separate additive signal so
 * evaluation can ablate it (k = 0) without touching tf/length handling.
 */

import type { IndexReader } from '../index/reader.js';
import { positionsInDoc } from './positions.js';

interface Event {
  readonly pos: number;
  readonly term: number;
}

/** Smallest covering window (span in positions) or null if not all terms present. */
export function minimumWindow(
  reader: IndexReader,
  terms: readonly string[],
  docId: number,
): number | null {
  if (terms.length === 0) return null;

  const lists: number[][] = [];
  for (const term of terms) {
    const view = reader.postingsForTerm(term);
    if (view === null) return null;
    const positions = positionsInDoc(view, docId);
    if (positions === null || positions.length === 0) return null;
    lists.push(positions);
  }

  // Merge all term positions into one stream (positions are unique per doc —
  // each token owns exactly one position — so the merge has no cross-term ties
  // to worry about; sort anyway for a total order).
  const events: Event[] = [];
  for (let i = 0; i < lists.length; i++) {
    for (const pos of lists[i]!) events.push({ pos, term: i });
  }
  events.sort((a, b) => a.pos - b.pos);

  // Sliding window covering every term at least once.
  const counts = new Uint32Array(lists.length);
  let covered = 0;
  let left = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let right = 0; right < events.length; right++) {
    if (counts[events[right]!.term]!++ === 0) covered++;
    while (covered === lists.length) {
      const span = events[right]!.pos - events[left]!.pos + 1;
      if (span < best) best = span;
      const evicted = events[left]!.term;
      counts[evicted] = counts[evicted]! - 1;
      if (counts[evicted] === 0) covered--;
      left++;
    }
  }
  return best === Number.POSITIVE_INFINITY ? null : best;
}

/** k / (1 + (window − |q|)) — null-safe: missing window or |q| < 2 ⇒ 0. */
export function proximityScore(
  window: number | null,
  numTerms: number,
  k: number,
): number {
  if (window === null || numTerms < 2) return 0;
  return k / (1 + (window - numTerms));
}
