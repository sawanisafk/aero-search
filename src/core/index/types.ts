/**
 * Index data structures (pure data — no I/O).
 *
 * Build layout vs final layout:
 *
 *   BUILD (IndexWriter staging)          FINAL (IndexData, persisted)
 *   --------------------------           --------------------------------
 *   stageTermIds  U32[]  per posting     (consumed by counting sort)
 *   stageDocIds   U32[]  per posting     docDeltas   U32[]  delta-encoded
 *   stagePosStarts U32[] per posting  -> docOffsets  U32[]  numTerms+1 (sentinel)
 *   stagePos      U32[]  positions       tfs         U16[]  one per posting
 *                                         posDeltas  U32[]  run-first-absolute
 *                                         posRunStarts U32[] postings+1 (sentinel)
 *                                         dfs         U32[]  per term
 *                                         docLengths  U32[]  per doc
 *
 * Why delta encoding: postings within a term are sorted by docId, so storing
 * gaps (typically small) instead of absolute ids shrinks the dominant index
 * component; positions within a run are likewise ascending.
 *
 * Why typed arrays: identical data as JS objects (one object per posting)
 * costs >= 2.5 GB at 100K docs; packed arrays cost a few hundred MB
 * (docs/INDEXING.md has the measured numbers).
 */

import type { AnalysisConfig } from '../text/analyze.js';

export interface DocMeta {
  docId: number;
  title: string;
  url: string;
  /** number of indexed terms (post-analysis) — BM25 document length */
  wordCount: number;
}

export interface IndexStats {
  numDocs: number;
  vocabSize: number;
  numPostings: number;
  totalTokens: number;
  avgDocLength: number;
}

export interface IndexData {
  /** termId -> term (dictionary order) */
  readonly terms: string[];
  /** term -> termId */
  readonly termIndex: ReadonlyMap<string, number>;
  /** per-term start offsets into docDeltas/tfs; length = vocabSize + 1 (sentinel) */
  readonly docOffsets: Uint32Array;
  /** document frequency per term; length = vocabSize */
  readonly dfs: Uint32Array;
  /** concatenated delta-encoded doc ids, grouped by termId; length = numPostings */
  readonly docDeltas: Uint32Array;
  /** term frequency per posting; length = numPostings */
  readonly tfs: Uint16Array;
  /** concatenated position runs (first element of each run absolute, then gaps) */
  readonly posDeltas: Uint32Array;
  /** per-posting start offset into posDeltas; length = numPostings + 1 (sentinel) */
  readonly posRunStarts: Uint32Array;
  /** indexed term count per document; length = numDocs */
  readonly docLengths: Uint32Array;
  readonly docs: readonly DocMeta[];
  readonly stats: IndexStats;
  /** analysis configuration frozen at build time — query side must reuse it */
  readonly analysis: AnalysisConfig;
}

export interface IndexBuilderOptions {
  analysis?: AnalysisConfig;
}

export interface AddDocumentInput {
  title: string;
  url: string;
  /** full text to index (single indexed field in M1; see docs/INDEXING.md) */
  text: string;
}
