import { describe, expect, it } from 'vitest';
import { IndexWriter } from '../src/core/index/writer.js';
import { IndexReader } from '../src/core/index/reader.js';
import { parseQuery } from '../src/core/query/index.js';
import { analyzeQuery, retrieveAnalyzed, positiveQueryTerms } from '../src/core/retrieval/index.js';
import {
  boundedEditDistance,
  edit1Variants,
  expandFuzzyQuery,
  resolveFuzzy,
  DEFAULT_FUZZY,
  MIN_LENGTH_FOR_EDITS_2,
} from '../src/core/retrieval/fuzzy.js';
import { bm25Strategy, booleanStrategy } from '../src/core/ranking/index.js';
import type { AnalyzedQuery } from '../src/core/retrieval/analyze-query.js';

/**
 * Fuzzy fixture — a dense region of dictionary terms that are mutually
 * within edit distance 1, so expansion caps are observable:
 *
 *   doc | text                  | note
 *   ----|-----------------------|------------------------------------------
 *   0   | search engine ranking | typo `seach` recovers `search`
 *   1   | full text retrieval   | unrelated
 *   2   | aaaaab alpha          | dense region: aaaaa* (df: b=1,c=1,d=1,e=2)
 *   3   | aaaaac alpha          |
 *   4   | aaaaad alpha          |
 *   5   | aaaaae alpha         |
 *   6   | aaaaae alpha beta     | df(aaaaae) = 2
 *   7   | quorum consensus      | NOT / exact-match checks
 *
 * `aaaaax` (absent) has four distance-1 neighbors: aaaaab/c/d/e.
 * `aaaxxb` (absent, length 6) is distance 2 from `aaaaab` and distance > 1
 * from everything else — the maxEdits=2 gate.
 */
function buildFuzzyReader(): IndexReader {
  const writer = new IndexWriter();
  const texts = [
    'search engine ranking',
    'full text retrieval',
    'aaaaab alpha',
    'aaaaac alpha',
    'aaaaad alpha',
    'aaaaae alpha',
    'aaaaae alpha beta',
    'quorum consensus',
  ];
  texts.forEach((text, i) =>
    writer.addDocument({ title: `doc${i}`, url: `https://example.com/${i}`, text }),
  );
  return IndexReader.fromData(writer.finalize());
}

const termLeaf = (terms: string[]): AnalyzedQuery => ({ kind: 'term', terms });

describe('boundedEditDistance', () => {
  it('identical strings are distance 0', () => {
    expect(boundedEditDistance('search', 'search', 2)).toBe(0);
    expect(boundedEditDistance('', '', 2)).toBe(0);
  });

  it('hand-computed classic values', () => {
    expect(boundedEditDistance('cat', 'car', 1)).toBe(1); // one substitution
    expect(boundedEditDistance('seach', 'search', 1)).toBe(1); // one insertion
    expect(boundedEditDistance('search', 'seach', 1)).toBe(1); // one deletion
    expect(boundedEditDistance('flaw', 'lawn', 2)).toBe(2); // sub f->l, sub w->n
    expect(boundedEditDistance('kitten', 'sitting', 3)).toBe(3);
  });

  it('returns maxEdits + 1 sentinel when the distance exceeds the bound', () => {
    expect(boundedEditDistance('seach', 'search', 0)).toBe(1);
    expect(boundedEditDistance('kitten', 'sitting', 2)).toBe(3);
    expect(boundedEditDistance('kitten', 'sitting', 0)).toBe(1);
  });

  it('length gap alone can exceed the bound', () => {
    expect(boundedEditDistance('ab', 'abcd', 1)).toBe(2); // |4-2| > 1
    expect(boundedEditDistance('ab', 'abcd', 2)).toBe(2);
    expect(boundedEditDistance('abc', 'x', 5)).toBe(3);
  });

  it('empty-string distances', () => {
    expect(boundedEditDistance('', 'abc', 5)).toBe(3);
    expect(boundedEditDistance('abc', '', 5)).toBe(3);
    expect(boundedEditDistance('', 'abcd', 3)).toBe(4); // 4 > 3 -> sentinel
  });

  it('rejects invalid bounds', () => {
    expect(() => boundedEditDistance('a', 'b', -1)).toThrow(RangeError);
    expect(() => boundedEditDistance('a', 'b', 1.5)).toThrow(RangeError);
  });
});

describe('edit1Variants', () => {
  it('contains deletions, substitutions and insertions', () => {
    const variants = edit1Variants('ab');
    expect(variants.has('b')).toBe(true); // delete a
    expect(variants.has('a')).toBe(true); // delete b
    expect(variants.has('cb')).toBe(true); // substitute a
    expect(variants.has('ax')).toBe(true); // substitute b
    expect(variants.has('xab')).toBe(true); // insert x at 0
    expect(variants.has('abx')).toBe(true); // insert x at end
    expect(variants.has('ab')).toBe(false); // never returns the input itself
  });

  it('every variant is exactly at distance 1', () => {
    for (const v of edit1Variants('seach')) {
      expect(boundedEditDistance('seach', v, 1)).toBe(1);
    }
  });

  it('is bounded: at most 27·len + 26 candidates (plus dedupe)', () => {
    // len 5: 5 deletes + 5·25 subs + 6·26 inserts = 130 + 156 - dupes
    expect(edit1Variants('seach').size).toBeLessThanOrEqual(5 + 125 + 156);
    expect(edit1Variants('').size).toBe(26); // insertions only
  });
});

describe('resolveFuzzy', () => {
  it('applies documented defaults', () => {
    expect(resolveFuzzy()).toEqual(DEFAULT_FUZZY);
    expect(resolveFuzzy({}).maxEdits).toBe(1);
    expect(DEFAULT_FUZZY).toEqual({
      maxEdits: 1,
      minTermLength: 3,
      maxExpansionsPerTerm: 10,
      maxFuzzyTermsPerQuery: 10,
      maxExpansionsPerQuery: 20,
    });
  });

  it('rejects invalid values with RangeError', () => {
    expect(() => resolveFuzzy({ maxEdits: 0 })).toThrow(RangeError);
    expect(() => resolveFuzzy({ maxEdits: 3 })).toThrow(RangeError);
    expect(() => resolveFuzzy({ maxEdits: 1.5 })).toThrow(RangeError);
    expect(() => resolveFuzzy({ minTermLength: 0 })).toThrow(RangeError);
    expect(() => resolveFuzzy({ maxExpansionsPerTerm: 0 })).toThrow(RangeError);
    expect(() => resolveFuzzy({ maxFuzzyTermsPerQuery: -1 })).toThrow(RangeError);
    expect(() => resolveFuzzy({ maxExpansionsPerQuery: 0 })).toThrow(RangeError);
  });
});

describe('expandFuzzyQuery — typo recovery', () => {
  const reader = buildFuzzyReader();

  it('recovers a distance-1 typo: seach -> search', () => {
    const parsed = parseQuery('seach');
    const analyzed = analyzeQuery(parsed, reader.analysis);
    const result = expandFuzzyQuery(reader, analyzed);

    expect(result.stats.termsExpanded).toBe(1);
    expect(result.expansions).toHaveLength(1);
    expect(result.expansions[0]!.term).toBe('seach');
    expect(result.expansions[0]!.variants).toContain('search');
    expect(result.expansions[0]!.distance).toBe(1);

    // candidate layer: the typo alone returned the empty set before expansion
    expect(retrieveAnalyzed(reader, analyzed)).toEqual(new Uint32Array(0));
    const candidates = retrieveAnalyzed(reader, result.query);
    expect([...candidates]).toEqual([0]); // doc0 contains `search`
  });

  it('never expands terms that exist in the dictionary (exact match wins)', () => {
    const analyzed: AnalyzedQuery = termLeaf(['search']);
    const result = expandFuzzyQuery(reader, analyzed);
    expect(result.query).toBe(analyzed); // identity: untouched
    expect(result.expansions).toEqual([]);
    expect(result.stats.termsAttempted).toBe(0);
  });

  it('returns the identical tree when nothing is expandable (zero mutation)', () => {
    const analyzed: AnalyzedQuery = {
      kind: 'and',
      left: termLeaf(['search']),
      right: termLeaf(['quorum']),
    };
    const result = expandFuzzyQuery(reader, analyzed);
    expect(result.query).toBe(analyzed);
    expect(result.stats.variantsAdded).toBe(0);
  });

  it('expands inside AND — the typo behaves as its alternatives', () => {
    const analyzed: AnalyzedQuery = {
      kind: 'and',
      left: termLeaf(['alpha']),
      right: termLeaf(['aaaaax']), // absent; four neighbors a/b/c/d/e
    };
    const result = expandFuzzyQuery(reader, analyzed);
    expect(result.stats.termsExpanded).toBe(1);
    const candidates = retrieveAnalyzed(reader, result.query);
    expect([...candidates]).toEqual([2, 3, 4, 5, 6]); // alpha ∩ (aaaaa*)
  });

  it('leaves NOT subtrees alone (a negated typo must not exclude wrongly)', () => {
    const analyzed: AnalyzedQuery = { kind: 'not', operand: termLeaf(['seach']) };
    const result = expandFuzzyQuery(reader, analyzed);
    expect(result.query).toBe(analyzed);
    expect(result.expansions).toEqual([]);
    // NOT ∅ = universe, unchanged
    expect(retrieveAnalyzed(reader, result.query)).toHaveLength(8);
  });

  it('leaves phrase leaves alone (positional semantics are exact)', () => {
    const analyzed: AnalyzedQuery = { kind: 'phrase', terms: ['seach', 'engine'] };
    const result = expandFuzzyQuery(reader, analyzed);
    expect(result.query).toBe(analyzed);
    expect(result.expansions).toEqual([]);
  });
});

describe('expandFuzzyQuery — strict limits', () => {
  const reader = buildFuzzyReader();

  it('minTermLength: short absent terms are not attempted', () => {
    const result = expandFuzzyQuery(reader, termLeaf(['xy']));
    expect(result.stats.termsAttempted).toBe(0);
    expect(result.stats.caps.tooShort).toBe(1);
    expect(result.query).toEqual(termLeaf(['xy']));
  });

  it('maxExpansionsPerTerm: keeps the best N by (distance, df desc, term asc)', () => {
    const result = expandFuzzyQuery(reader, termLeaf(['aaaaax']), {
      maxExpansionsPerTerm: 2,
    });
    // df(aaaaae)=2 outranks the df=1 terms; tie broken by term asc.
    expect(result.expansions[0]!.variants).toEqual(['aaaaae', 'aaaaab']);
    expect(result.stats.caps.expansionsPerTerm).toBe(1);
    expect(result.stats.variantsAdded).toBe(2);
  });

  it('maxFuzzyTermsPerQuery: budgets attempts across terms', () => {
    const analyzed: AnalyzedQuery = {
      kind: 'and',
      left: termLeaf(['aaaaax']),
      right: termLeaf(['seach']),
    };
    const result = expandFuzzyQuery(reader, analyzed, { maxFuzzyTermsPerQuery: 1 });
    expect(result.stats.termsAttempted).toBe(1);
    expect(result.stats.caps.fuzzyTermsPerQuery).toBe(1);
    expect(result.expansions).toHaveLength(1);
    expect(result.expansions[0]!.term).toBe('aaaaax'); // first in leaf order
  });

  it('maxExpansionsPerQuery: caps variants across the whole query', () => {
    const analyzed: AnalyzedQuery = {
      kind: 'and',
      left: termLeaf(['aaaaax']),
      right: termLeaf(['seach']),
    };
    const result = expandFuzzyQuery(reader, analyzed, { maxExpansionsPerQuery: 3 });
    expect(result.stats.variantsAdded).toBe(3);
    // term1 truncated by the query budget, term2 blocked by it (2 term-events)
    expect(result.stats.caps.expansionsPerQuery).toBe(2);
    expect(result.expansions[0]!.variants).toHaveLength(3);
    expect(result.expansions[1]).toBeUndefined(); // budget exhausted
  });

  it('maxEdits=1 refuses distance-2 neighbors', () => {
    const result = expandFuzzyQuery(reader, termLeaf(['aaaxxb']), { maxEdits: 1 });
    expect(result.stats.termsAttempted).toBe(1);
    expect(result.expansions).toEqual([]);
    expect(result.stats.termsExpanded).toBe(0);
  });

  it('maxEdits=2 recovers distance-2 neighbors (len >= 5)', () => {
    const result = expandFuzzyQuery(reader, termLeaf(['aaaxxb']), { maxEdits: 2 });
    expect(result.expansions[0]!.variants).toContain('aaaaab');
    expect(result.expansions[0]!.distance).toBe(2);
  });

  it('maxEdits=2 skips generation for short terms (edits2SkippedLength)', () => {
    // `aaax` (len 4 < MIN_LENGTH_FOR_EDITS_2=5) has no distance-1 neighbor
    const result = expandFuzzyQuery(reader, termLeaf(['aaax']), { maxEdits: 2 });
    expect(result.stats.termsAttempted).toBe(1);
    expect(result.expansions).toEqual([]);
    expect(result.stats.caps.edits2SkippedLength).toBe(1);
  });

  it('is deterministic across repeated runs', () => {
    const a = expandFuzzyQuery(reader, termLeaf(['aaaaax']), { maxExpansionsPerTerm: 3 });
    const b = expandFuzzyQuery(reader, termLeaf(['aaaaax']), { maxExpansionsPerTerm: 3 });
    expect(a).toEqual(b);
  });
});

describe('fuzzy expansion — scoring integration', () => {
  const reader = buildFuzzyReader();

  it('BM25 scores documents matched via expanded variants', () => {
    const analyzed = analyzeQuery(parseQuery('seach'), reader.analysis);
    const { query } = expandFuzzyQuery(reader, analyzed);
    const candidates = retrieveAnalyzed(reader, query);

    const results = bm25Strategy().rank(reader, query, candidates);
    expect(results).toHaveLength(1);
    expect(results[0]!.docId).toBe(0);
    expect(results[0]!.score).toBeGreaterThan(0); // variant contributes real idf
  });

  it('boolean strategy returns expanded candidates unranked (membership only)', () => {
    const analyzed = analyzeQuery(parseQuery('seach'), reader.analysis);
    const { query } = expandFuzzyQuery(reader, analyzed);
    const results = booleanStrategy.rank(reader, query, retrieveAnalyzed(reader, query));
    // boolean = candidate membership, score 0 for all (see ranking.test.ts)
    expect(results.map((r) => r.docId)).toEqual([0]);
    expect(results[0]).toEqual({ docId: 0, score: 0, breakdown: { boolean: 0 } });
  });

  it('positiveQueryTerms sees the expanded variants', () => {
    const analyzed = analyzeQuery(parseQuery('seach'), reader.analysis);
    const { query } = expandFuzzyQuery(reader, analyzed);
    expect(positiveQueryTerms(query)).toEqual(['seach', 'search']);
  });

  it('the unexpanded typo contributes no candidates and no score', () => {
    const analyzed = analyzeQuery(parseQuery('seach'), reader.analysis);
    expect(retrieveAnalyzed(reader, analyzed)).toEqual(new Uint32Array(0));
    expect(bm25Strategy().rank(reader, analyzed, retrieveAnalyzed(reader, analyzed))).toEqual([]);
  });
});
