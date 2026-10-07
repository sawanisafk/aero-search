/**
 * Query analysis: surface AST -> analyzed AST.
 *
 * The single most important correctness rule in the whole engine (ADR-009):
 * query terms MUST pass through the same analyze() pipeline as documents,
 * with the config frozen in the segment header — otherwise "Darcy" (surface)
 * would look for a term the index stored as "darci" (stemmed) and silently
 * return nothing.
 *
 * Semantics of empty leaves:
 *   - a term that analyzes to nothing (stop-word like "the") yields an EMPTY
 *     term list; as a candidate set that is the empty set ∅.
 *   - a phrase whose words all analyze away is likewise ∅.
 *   Boolean algebra stays strict: AND with ∅ is ∅, OR ignores ∅, and
 *   NOT ∅ = universe (documented in docs/SEARCH.md).
 */

import { analyze, type AnalysisConfig } from '../text/analyze.js';
import type { Query } from '../query/ast.js';

export type AnalyzedQuery =
  | { readonly kind: 'term'; readonly terms: readonly string[] }
  | { readonly kind: 'phrase'; readonly terms: readonly string[] }
  | { readonly kind: 'and'; readonly left: AnalyzedQuery; readonly right: AnalyzedQuery }
  | { readonly kind: 'or'; readonly left: AnalyzedQuery; readonly right: AnalyzedQuery }
  | { readonly kind: 'not'; readonly operand: AnalyzedQuery };

function analyzedTerms(surface: readonly string[], config: AnalysisConfig): string[] {
  // Surface words are joined back into a string because analyze() operates on
  // text; single words are the common case and joining keeps one code path.
  return analyze(surface.join(' '), config).map((token) => token.term);
}

/** Analyze every leaf of the query AST with the index's frozen config. */
export function analyzeQuery(query: Query, config: AnalysisConfig): AnalyzedQuery {
  switch (query.kind) {
    case 'term':
      return { kind: 'term', terms: analyzedTerms([query.term], config) };
    case 'phrase':
      return { kind: 'phrase', terms: analyzedTerms(query.terms, config) };
    case 'and':
      return {
        kind: 'and',
        left: analyzeQuery(query.left, config),
        right: analyzeQuery(query.right, config),
      };
    case 'or':
      return {
        kind: 'or',
        left: analyzeQuery(query.left, config),
        right: analyzeQuery(query.right, config),
      };
    case 'not':
      return { kind: 'not', operand: analyzeQuery(query.operand, config) };
  }
}

/** All distinct analyzed leaf terms in document order of appearance (deduped). */
export function analyzedLeafTerms(query: AnalyzedQuery): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (node: AnalyzedQuery): void => {
    switch (node.kind) {
      case 'term':
      case 'phrase':
        for (const term of node.terms) {
          if (!seen.has(term)) {
            seen.add(term);
            out.push(term);
          }
        }
        return;
      case 'and':
      case 'or':
        walk(node.left);
        walk(node.right);
        return;
      case 'not':
        walk(node.operand);
    }
  };
  walk(query);
  return out;
}
