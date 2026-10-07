import { describe, expect, it } from 'vitest';
import { intersect, union, difference, universe } from '../src/core/retrieval/boolean.js';
import { analyzeQuery, analyzedLeafTerms } from '../src/core/retrieval/analyze-query.js';
import { retrieveBoolean, retrieveAnalyzed } from '../src/core/retrieval/evaluate.js';
import { parseQuery } from '../src/core/query/index.js';
import { IndexWriter } from '../src/core/index/writer.js';
import { IndexReader } from '../src/core/index/reader.js';
import { DEFAULT_ANALYSIS } from '../src/core/text/analyze.js';

const u = (...ids: number[]) => Uint32Array.from(ids);

function buildReader(): IndexReader {
  const writer = new IndexWriter();
  const texts = [
    'red fox jumps',
    'blue fox sleeps',
    'red car drives',
    'green fox red car',
  ];
  texts.forEach((text, i) =>
    writer.addDocument({ title: `doc${i}`, url: `https://example.com/${i}`, text }),
  );
  return IndexReader.fromData(writer.finalize());
}

describe('boolean set operations', () => {
  it('intersect keeps ids present in both, ascending', () => {
    expect(intersect(u(1, 3, 5, 7), u(3, 4, 5, 8))).toEqual(u(3, 5));
    expect(intersect(u(1, 2), u(3, 4))).toEqual(u());
    expect(intersect(u(), u(1))).toEqual(u());
    expect(intersect(u(1, 2), u(1, 2))).toEqual(u(1, 2));
  });

  it('union merges and deduplicates', () => {
    expect(union(u(1, 3), u(2, 3, 4))).toEqual(u(1, 2, 3, 4));
    expect(union(u(), u(2))).toEqual(u(2));
    expect(union(u(), u())).toEqual(u());
    // contract: inputs are canonical (ascending, duplicate-free posting lists)
    expect(union(u(1, 3), u(3, 5))).toEqual(u(1, 3, 5));
  });

  it('difference removes ids of b from a', () => {
    expect(difference(u(1, 2, 3, 4), u(2, 4))).toEqual(u(1, 3));
    expect(difference(u(1, 2), u())).toEqual(u(1, 2));
    expect(difference(u(), u(1))).toEqual(u());
    expect(difference(u(1, 2), u(1, 2))).toEqual(u());
  });

  it('universe produces {0..n-1} and handles n = 0', () => {
    expect(universe(3)).toEqual(u(0, 1, 2));
    expect(universe(0)).toEqual(u());
  });
});

describe('analyzeQuery', () => {
  it('stems query terms with the frozen config so they match the index', () => {
    expect(analyzeQuery({ kind: 'term', term: 'Darcy' }, DEFAULT_ANALYSIS)).toEqual({
      kind: 'term',
      terms: ['darci'],
    });
    expect(analyzeQuery({ kind: 'term', term: 'learning' }, DEFAULT_ANALYSIS)).toEqual({
      kind: 'term',
      terms: ['learn'],
    });
  });

  it('analyzes stop-words away to an empty term list', () => {
    expect(analyzeQuery({ kind: 'term', term: 'the' }, DEFAULT_ANALYSIS)).toEqual({
      kind: 'term',
      terms: [],
    });
  });

  it('analyzes phrase words individually, preserving order', () => {
    expect(
      analyzeQuery({ kind: 'phrase', terms: ['machine', 'and', 'learning'] }, DEFAULT_ANALYSIS),
    ).toEqual({ kind: 'phrase', terms: ['machin', 'learn'] });
  });

  it('recurses through boolean structure unchanged', () => {
    const surface = parseQuery('fox AND NOT car');
    expect(analyzeQuery(surface, DEFAULT_ANALYSIS)).toEqual({
      kind: 'and',
      left: { kind: 'term', terms: ['fox'] },
      right: { kind: 'not', operand: { kind: 'term', terms: ['car'] } },
    });
  });

  it('collects distinct leaf terms in order of appearance', () => {
    const analyzed = analyzeQuery(parseQuery('red fox OR red NOT car "blue fox"'), DEFAULT_ANALYSIS);
    expect(analyzedLeafTerms(analyzed)).toEqual(['red', 'fox', 'car', 'blue']);
  });
});

describe('retrieveBoolean over a built index', () => {
  it('returns postings for a single term', () => {
    const reader = buildReader();
    expect([...retrieveBoolean(reader, parseQuery('red'))]).toEqual([0, 2, 3]);
    expect([...retrieveBoolean(reader, parseQuery('fox'))]).toEqual([0, 1, 3]);
  });

  it('AND intersects posting lists', () => {
    const reader = buildReader();
    expect([...retrieveBoolean(reader, parseQuery('red AND fox'))]).toEqual([0, 3]);
    expect([...retrieveBoolean(reader, parseQuery('red fox'))]).toEqual([0, 3]);
  });

  it('OR unions posting lists', () => {
    const reader = buildReader();
    expect([...retrieveBoolean(reader, parseQuery('red OR blue'))]).toEqual([0, 1, 2, 3]);
  });

  it('NOT complements against the whole corpus', () => {
    const reader = buildReader();
    expect([...retrieveBoolean(reader, parseQuery('NOT red'))]).toEqual([1]);
    expect([...retrieveBoolean(reader, parseQuery('fox NOT red'))]).toEqual([1]);
  });

  it('applies documented precedence: OR looser than AND, NOT tightest', () => {
    const reader = buildReader();
    // or(red, and(blue, fox)) = {0,2,3} ∪ ({1} ∩ {0,1,3}) = {0,1,2,3}
    expect([...retrieveBoolean(reader, parseQuery('red OR blue AND fox'))]).toEqual([0, 1, 2, 3]);
    // (red ∪ blue) ∩ fox = {0,1,2,3} ∩ {0,1,3} = {0,1,3}
    expect([...retrieveBoolean(reader, parseQuery('(red OR blue) AND fox'))]).toEqual([0, 1, 3]);
    // and(not(red), fox) = {1} ∩ {0,1,3} = {1}
    expect([...retrieveBoolean(reader, parseQuery('NOT red AND fox'))]).toEqual([1]);
  });

  it('unknown terms behave like the empty set', () => {
    const reader = buildReader();
    expect([...retrieveBoolean(reader, parseQuery('purple'))]).toEqual([]);
    expect([...retrieveBoolean(reader, parseQuery('red AND purple'))]).toEqual([]);
    expect([...retrieveBoolean(reader, parseQuery('red OR purple'))]).toEqual([0, 2, 3]);
    expect([...retrieveBoolean(reader, parseQuery('NOT purple'))]).toEqual([0, 1, 2, 3]);
  });

  it('stop-word-only queries retrieve nothing (empty analyzed leaf)', () => {
    const reader = buildReader();
    expect([...retrieveBoolean(reader, parseQuery('the'))]).toEqual([]);
    expect([...retrieveBoolean(reader, parseQuery('NOT the'))]).toEqual([0, 1, 2, 3]);
  });

  it('retrieveAnalyzed avoids re-analysis and matches retrieveBoolean', () => {
    const reader = buildReader();
    const query = parseQuery('red AND fox');
    const analyzed = analyzeQuery(query, reader.analysis);
    expect([...retrieveAnalyzed(reader, analyzed)]).toEqual(
      [...retrieveBoolean(reader, query)],
    );
  });

  it('stemmed query terms reach stemmed index terms (Darcy/darci class)', () => {
    const reader = buildReader();
    // "jumps" indexed as "jump"; the query must be analyzed the same way.
    expect([...retrieveBoolean(reader, parseQuery('jumping OR jumps'))]).toEqual([0]);
  });
});
