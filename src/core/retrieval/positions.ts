/**
 * Position access helpers for positional retrieval.
 *
 * positionsInDoc walks one term's posting list to find the target document,
 * then decodes that posting's position run (O(tf)). This costs O(df) per
 * (term, doc) lookup — fine at M2 scale (documented deferral: a forward
 * index or cached posting cursor if benchmarks ever say otherwise).
 */

import type { TermPostingsView } from '../index/reader.js';

/** Sorted positions of `term` inside `docId`, or null when absent. */
export function positionsInDoc(view: TermPostingsView, docId: number): number[] | null {
  let found: number[] | null = null;
  view.forEach((index, doc) => {
    if (doc === docId) found = view.positions(index);
  });
  return found;
}

/** Binary membership test over an ascending position list. */
export function containsPosition(sorted: number[], target: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = sorted[mid]!;
    if (v === target) return true;
    if (v < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}
