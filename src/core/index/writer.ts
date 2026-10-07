/**
 * IndexWriter — builds an inverted + positional index from documents.
 *
 * Two-phase construction (sort-based indexing, the classic pipeline):
 *
 *   PHASE 1 — staging (per document, append order):
 *     for each document: analyze text -> group terms -> append one staging
 *     posting (termId, docId, position run) per distinct term of that doc.
 *
 *   PHASE 2 — finalize (counting sort by termId):
 *     stable counting sort clusters all postings of a term contiguously
 *     (docIds are already ascending because documents are added in order),
 *     then delta-encodes doc ids and positions into packed typed arrays.
 *
 * Counting sort costs O(postings + vocab) — linear, no comparison sort —
 * and yields the classic layout: for term t, postings live in
 * docDeltas[docOffsets[t] .. docOffsets[t+1]).
 *
 * The writer also runs the shared analyzer, so term production is identical
 * for documents now and queries later (docs/ARCHITECTURE.md module rules).
 */

import { analyze, DEFAULT_ANALYSIS, type AnalysisConfig } from '../text/analyze.js';
import { GrowableUint32 } from './growable.js';
import type {
  AddDocumentInput,
  DocMeta,
  IndexBuilderOptions,
  IndexData,
  IndexStats,
} from './types.js';

const MAX_TF = 65535; // tfs is Uint16Array

export class IndexWriter {
  private readonly config: AnalysisConfig;
  private readonly corpusHash: string;

  private readonly termIds = new Map<string, number>();
  private readonly terms: string[] = [];
  private readonly docs: DocMeta[] = [];
  private readonly docLengths: number[] = [];

  private readonly stageTerm = new GrowableUint32();
  private readonly stageDoc = new GrowableUint32();
  private readonly stagePosStart = new GrowableUint32();
  private readonly stagePos = new GrowableUint32();

  private finalized = false;

  constructor(options: IndexBuilderOptions = {}) {
    this.config = options.analysis ?? DEFAULT_ANALYSIS;
    this.corpusHash = options.corpusHash ?? '';
  }

  get analysis(): AnalysisConfig {
    return this.config;
  }

  get numDocs(): number {
    return this.docs.length;
  }

  /** Analyze and index one document. Returns the assigned document id. */
  addDocument(doc: AddDocumentInput): number {
    if (this.finalized) throw new Error('IndexWriter already finalized');
    const docId = this.docs.length;
    const tokens = analyze(doc.text, this.config);

    // Group this document's tokens by termId (posting = one term + positions).
    const byTerm = new Map<number, number[]>();
    for (const token of tokens) {
      let termId = this.termIds.get(token.term);
      if (termId === undefined) {
        termId = this.terms.length;
        this.terms.push(token.term);
        this.termIds.set(token.term, termId);
      }
      let positions = byTerm.get(termId);
      if (positions === undefined) {
        positions = [];
        byTerm.set(termId, positions);
      }
      positions.push(token.position);
    }

    for (const [termId, positions] of byTerm) {
      if (positions.length > MAX_TF) {
        throw new Error(
          `term frequency ${positions.length} exceeds Uint16 capacity in doc ${docId}`,
        );
      }
      this.stageTerm.push(termId);
      this.stageDoc.push(docId);
      this.stagePosStart.push(this.stagePos.length);
      for (const p of positions) this.stagePos.push(p);
    }

    this.docs.push({ docId, title: doc.title, url: doc.url, wordCount: tokens.length });
    this.docLengths.push(tokens.length);
    return docId;
  }

  /**
   * Counting-sort staging into the final layout and freeze the index.
   * The writer cannot be used afterwards.
   */
  finalize(): IndexData {
    if (this.finalized) throw new Error('IndexWriter already finalized');
    this.finalized = true;

    const numTerms = this.terms.length;
    const totalPostings = this.stageTerm.length;
    const totalPositions = this.stagePos.length;

    // --- counting sort by termId (stable: preserves doc order within a term)
    const offsets = new Uint32Array(numTerms + 1);
    for (let p = 0; p < totalPostings; p++) {
      const t = this.stageTerm.at(p)!;
      offsets[t + 1] = offsets[t + 1]! + 1;
    }
    for (let t = 0; t < numTerms; t++) offsets[t + 1] = offsets[t + 1]! + offsets[t]!;

    const cursor = offsets.slice(0, numTerms);
    const sortedDocs = new Uint32Array(totalPostings);
    const tfs = new Uint16Array(totalPostings);
    // Where each posting's position run landed inside the (stage-ordered) copy.
    const runLoc = new Uint32Array(totalPostings);
    const sortedPos = new Uint32Array(totalPositions);
    let posWrite = 0;
    for (let p = 0; p < totalPostings; p++) {
      const termId = this.stageTerm.at(p)!;
      const slot = cursor[termId]!;
      cursor[termId] = slot + 1;
      sortedDocs[slot] = this.stageDoc.at(p)!;
      const runStart = this.stagePosStart.at(p)!;
      const runEnd = p + 1 < totalPostings ? this.stagePosStart.at(p + 1)! : totalPositions;
      const tf = runEnd - runStart;
      if (tf > MAX_TF) throw new Error(`tf ${tf} exceeds Uint16 capacity`);
      tfs[slot] = tf;
      runLoc[slot] = posWrite;
      for (let q = runStart; q < runEnd; q++) sortedPos[posWrite++] = this.stagePos.at(q)!;
    }

    // --- delta encode doc ids: within each term's slot range, first doc id is
    //     absolute, subsequent entries are ascending gaps.
    const docDeltas = new Uint32Array(totalPostings);
    let dp = 0;
    for (let t = 0; t < numTerms; t++) {
      const from = offsets[t]!;
      const to = offsets[t + 1]!;
      let prevDoc = 0;
      for (let i = from; i < to; i++) {
        const doc = sortedDocs[i]!;
        docDeltas[dp++] = i === from ? doc : doc - prevDoc;
        prevDoc = doc;
      }
    }

    // --- delta encode positions: rebuild runs in slot order so that
    //     posRunStarts is monotonic over posDeltas (first element of each run
    //     is the absolute position, the rest are gaps).
    const posDeltas = new Uint32Array(totalPositions);
    const posRunStarts = new Uint32Array(totalPostings + 1);
    let pp = 0;
    for (let i = 0; i < totalPostings; i++) {
      posRunStarts[i] = pp;
      const base = runLoc[i]!;
      const len = tfs[i]!;
      let prevPos = 0;
      for (let q = 0; q < len; q++) {
        const v = sortedPos[base + q]!;
        posDeltas[pp++] = q === 0 ? v : v - prevPos;
        prevPos = v;
      }
    }
    posRunStarts[totalPostings] = totalPositions;

    const totalTokens = this.docLengths.reduce((a, b) => a + b, 0);
    const stats: IndexStats = {
      numDocs: this.docs.length,
      vocabSize: numTerms,
      numPostings: totalPostings,
      totalTokens,
      avgDocLength: this.docs.length > 0 ? totalTokens / this.docs.length : 0,
    };

    return {
      corpusHash: this.corpusHash,
      terms: this.terms,
      termIndex: this.termIds,
      docOffsets: offsets,
      dfs: computeDfs(offsets),
      docDeltas,
      tfs,
      posDeltas,
      posRunStarts,
      docLengths: Uint32Array.from(this.docLengths),
      docs: this.docs,
      stats,
      analysis: this.config,
    };
  }
}

/** Compute dfs array for an IndexData-like layout (used by writer and reader). */
export function computeDfs(docOffsets: Uint32Array): Uint32Array {
  const dfs = new Uint32Array(docOffsets.length - 1);
  for (let t = 0; t < dfs.length; t++) dfs[t] = docOffsets[t + 1]! - docOffsets[t]!;
  return dfs;
}
