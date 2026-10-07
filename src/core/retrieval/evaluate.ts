/**
 * Boolean candidate generation: analyzed query AST -> sorted doc-id list.
 *
 * This is the candidate layer for every ranking strategy: it answers "which
 * documents satisfy the query structure" without scoring anything. Ranking
 * (TF-IDF/BM25/phrase bonus) happens on top of these candidates in
 * src/core/ranking.
 *
 * Set semantics (docs/SEARCH.md):
 *   - unknown term or stop-word-only leaf -> ∅ (empty candidate set)
 *   - AND = intersect, OR = union, NOT = universe \ operand
 *   - NOT ∅ = universe (strict Boolean algebra, no special cases)
 *
 * Phrase leaves are evaluated by positional matching (Phase 4).
 */

import type { IndexReader } from '../index/reader.js';
import type { Query } from '../query/ast.js';
import { analyzeQuery, type AnalyzedQuery } from './analyze-query.js';
import { difference, intersect, union, universe } from './boolean.js';
import { matchPhrase } from './phrase.js';

function evalAnalyzed(node: AnalyzedQuery, reader: IndexReader): Uint32Array {
  switch (node.kind) {
    case 'term': {
      if (node.terms.length === 0) return new Uint32Array(0);
      // A surface term is a single word, so analyze yields at most one token.
      const view = reader.postingsForTerm(node.terms[0]!);
      return view === null ? new Uint32Array(0) : view.docIds();
    }
    case 'phrase':
      return matchPhrase(reader, node.terms);
    case 'and':
      return intersect(evalAnalyzed(node.left, reader), evalAnalyzed(node.right, reader));
    case 'or':
      return union(evalAnalyzed(node.left, reader), evalAnalyzed(node.right, reader));
    case 'not':
      return difference(universe(reader.numDocs()), evalAnalyzed(node.operand, reader));
  }
}

/** Analyze `query` with the index's frozen config and return matching docIds (ascending). */
export function retrieveBoolean(reader: IndexReader, query: Query): Uint32Array {
  return evalAnalyzed(analyzeQuery(query, reader.analysis), reader);
}

/** Same, but from an already-analyzed query (avoids re-analysis when scoring). */
export function retrieveAnalyzed(reader: IndexReader, analyzed: AnalyzedQuery): Uint32Array {
  return evalAnalyzed(analyzed, reader);
}
