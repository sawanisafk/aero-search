/**
 * IndexReader — read-side view over an IndexData segment.
 *
 * Access patterns (why the API looks like this):
 *   - getTermId: dictionary lookup, O(1) hash access.
 *   - postings(): returns a view over the term's slice of the flat buffers;
 *     doc ids are delta-encoded, so they are decoded in one sequential pass
 *     (the natural access pattern for boolean retrieval: scan the list once).
 *   - positions(i): O(tf) decode of one posting's position run via
 *     posRunStarts — needed by phrase/proximity matching.
 *
 * No skip lists / WAND yet — deliberately deferred until benchmarks show
 * they are needed (docs/DEVELOPMENT.md scaling path).
 */

import { computeDfs } from './writer.js';
import type { DocMeta, IndexData, IndexStats } from './types.js';

export class TermPostingsView {
  constructor(
    private readonly data: IndexData,
    private readonly termId: number,
  ) {
    if (termId < 0 || termId >= data.stats.vocabSize) {
      throw new RangeError(`termId ${termId} out of range`);
    }
  }

  /** document frequency of the term */
  get df(): number {
    return this.data.dfs[this.termId]!;
  }

  /** number of postings (same as df) */
  get size(): number {
    return this.df;
  }

  /** Decode all doc ids in one sequential pass (allocates an array). */
  docIds(): Uint32Array {
    const { docOffsets, docDeltas } = this.data;
    const from = docOffsets[this.termId]!;
    const to = docOffsets[this.termId + 1]!;
    const out = new Uint32Array(to - from);
    let doc = 0;
    for (let i = from; i < to; i++) {
      doc += docDeltas[i]!;
      out[i - from] = doc;
    }
    return out;
  }

  /**
   * Single sequential scan: visit(index, docId, tf) for every posting.
   * `index` is the posting's global position (used by positions(index)).
   */
  forEach(visit: (index: number, docId: number, tf: number) => void): void {
    const { docOffsets, docDeltas, tfs } = this.data;
    const from = docOffsets[this.termId]!;
    const to = docOffsets[this.termId + 1]!;
    let doc = 0;
    for (let i = from; i < to; i++) {
      doc += docDeltas[i]!;
      visit(i, doc, tfs[i]!);
    }
  }

  /** Decode the position run of the posting at global index. */
  positions(index: number): number[] {
    const { posDeltas, posRunStarts } = this.data;
    const start = posRunStarts[index]!;
    const end = posRunStarts[index + 1]!;
    const out: number[] = [];
    let pos = 0;
    for (let q = start; q < end; q++) {
      pos += posDeltas[q]!;
      out.push(pos);
    }
    return out;
  }
}

export class IndexReader {
  constructor(private readonly data: IndexData) {}

  static fromData(data: IndexData): IndexReader {
    return new IndexReader(data);
  }

  get raw(): IndexData {
    return this.data;
  }

  stats(): IndexStats {
    return this.data.stats;
  }

  /** Analysis config frozen at build time — pass to `analyze()` for queries. */
  get analysis() {
    return this.data.analysis;
  }

  getTermId(term: string): number | undefined {
    return this.data.termIndex.get(term);
  }

  hasTerm(term: string): boolean {
    return this.data.termIndex.has(term);
  }

  postings(termId: number): TermPostingsView {
    return new TermPostingsView(this.data, termId);
  }

  /** Convenience: postings for a term string (empty view semantics: null if absent). */
  postingsForTerm(term: string): TermPostingsView | null {
    const termId = this.getTermId(term);
    return termId === undefined ? null : this.postings(termId);
  }

  docLength(docId: number): number {
    const len = this.data.docLengths[docId];
    if (len === undefined) throw new RangeError(`docId ${docId} out of range`);
    return len;
  }

  docMeta(docId: number): DocMeta {
    const doc = this.data.docs[docId];
    if (doc === undefined) throw new RangeError(`docId ${docId} out of range`);
    return doc;
  }

  numDocs(): number {
    return this.data.stats.numDocs;
  }
}
