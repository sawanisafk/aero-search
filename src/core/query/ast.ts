/**
 * Typed query AST — the contract between the parser and retrieval (M2).
 *
 * Nodes hold SURFACE terms (tokenized + normalized, but not yet stop-worded
 * or stemmed): analysis happens later, at evaluation time, through the same
 * `analyze()` path the index used, with the config frozen in the segment
 * header. Keeping the AST pre-analysis means the parser is a pure
 * string -> structure function with no dependency on index state.
 *
 * And/Or are binary (left-associative) because that is what the
 * precedence-climbing parser produces; evaluators fold them with a stack —
 * no need for n-ary nodes until benchmarks say otherwise.
 */

export interface TermQuery {
  readonly kind: 'term';
  /** single surface term, e.g. "darcy" (still unstemmed) */
  readonly term: string;
}

export interface PhraseQuery {
  readonly kind: 'phrase';
  /** ordered surface terms inside the quotes, e.g. ["exact","phrase"] */
  readonly terms: readonly string[];
}

export interface AndQuery {
  readonly kind: 'and';
  readonly left: Query;
  readonly right: Query;
}

export interface OrQuery {
  readonly kind: 'or';
  readonly left: Query;
  readonly right: Query;
}

export interface NotQuery {
  readonly kind: 'not';
  readonly operand: Query;
}

export type Query = TermQuery | PhraseQuery | AndQuery | OrQuery | NotQuery;

/** True when the node is a leaf (term/phrase) — i.e. retrieves postings directly. */
export function isLeaf(node: Query): node is TermQuery | PhraseQuery {
  return node.kind === 'term' || node.kind === 'phrase';
}
