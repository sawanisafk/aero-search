/**
 * Positional phrase matching: docs where the analyzed terms occur at
 * CONSECUTIVE positions p, p+1, …, p+n−1 (not merely co-occurring — plain
 * AND of the terms is the wrong answer, that's what boolean retrieval does).
 *
 * Two stages:
 *   1. intersect the terms' posting lists — docs must contain every term
 *   2. per surviving doc, verify adjacency over the decoded position runs
 *
 * Position semantics come from the shared analyzer: stop-words consume no
 * position, so "red the fox" indexes red@0 fox@1 and the phrase "red fox"
 * MATCHES it — index and query go through the identical analyze() path, so
 * the adjacency rule cannot drift between the two sides (ADR-009).
 *
 * Single-term "phrases" (`"red"`) degrade to ordinary term lookup: adjacency
 * of one term is trivially true. An empty term list (all stop-words) is ∅.
 */

import type { IndexReader, TermPostingsView } from '../index/reader.js';
import { intersect } from './boolean.js';
import { containsPosition, positionsInDoc } from './positions.js';

function hasConsecutive(lists: number[][]): boolean {
  for (const start of lists[0]!) {
    let ok = true;
    for (let i = 1; i < lists.length; i++) {
      if (!containsPosition(lists[i]!, start + i)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** Docs containing `terms` at consecutive positions (ascending docIds). */
export function matchPhrase(reader: IndexReader, terms: readonly string[]): Uint32Array {
  if (terms.length === 0) return new Uint32Array(0);

  const views: TermPostingsView[] = [];
  for (const term of terms) {
    const view = reader.postingsForTerm(term);
    if (view === null) return new Uint32Array(0); // unknown term -> phrase can never match
    views.push(view);
  }

  // Stage 1: docs containing every term.
  let docs = views[0]!.docIds();
  for (let i = 1; i < views.length && docs.length > 0; i++) {
    docs = intersect(docs, views[i]!.docIds());
  }
  if (terms.length === 1 || docs.length === 0) return docs;

  // Stage 2: positional verification.
  const kept: number[] = [];
  for (const docId of docs) {
    const lists: number[][] = [];
    let complete = true;
    for (const view of views) {
      const positions = positionsInDoc(view, docId);
      if (positions === null) {
        complete = false;
        break;
      }
      lists.push(positions);
    }
    if (complete && hasConsecutive(lists)) kept.push(docId);
  }
  return Uint32Array.from(kept);
}
