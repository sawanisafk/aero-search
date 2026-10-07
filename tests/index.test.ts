import { describe, expect, it } from 'vitest';
import { IndexWriter } from '../src/core/index/writer.js';
import { IndexReader } from '../src/core/index/reader.js';
import type { AddDocumentInput } from '../src/core/index/types.js';

const DOCS: AddDocumentInput[] = [
  {
    title: 'The Cat Sat',
    url: 'https://example.com/0',
    text: 'the cat sat on the mat',
  },
  {
    title: 'The Dog Sat',
    url: 'https://example.com/1',
    text: 'the dog sat on the log',
  },
  {
    title: 'Machine Learning',
    url: 'https://example.com/2',
    text: 'machine learning algorithms learn patterns from data',
  },
  {
    title: 'Learning Machines',
    url: 'https://example.com/3',
    text: 'the machine learned quickly and machines learn fast',
  },
];

function buildReader(): IndexReader {
  const writer = new IndexWriter();
  for (const d of DOCS) writer.addDocument(d);
  return IndexReader.fromData(writer.finalize());
}

describe('inverted index construction', () => {
  it('assigns sequential doc ids and records metadata', () => {
    const reader = buildReader();
    expect(reader.numDocs()).toBe(4);
    expect(reader.docMeta(2)).toEqual({
      docId: 2,
      title: 'Machine Learning',
      url: 'https://example.com/2',
      wordCount: 6,
    });
  });

  it('computes document lengths over indexed terms (stop-words excluded)', () => {
    const reader = buildReader();
    // "the cat sat on the mat" -> cat, sat, mat
    expect(reader.docLength(0)).toBe(3);
    expect(reader.docLength(1)).toBe(3);
    // "machine learning algorithms learn patterns from data" -> 6 terms
    expect(reader.docLength(2)).toBe(6);
  });

  it('does not index stop-words', () => {
    const reader = buildReader();
    expect(reader.getTermId('the')).toBeUndefined();
    expect(reader.getTermId('on')).toBeUndefined();
    expect(reader.hasTerm('cat')).toBe(true);
  });

  it('stems variants onto one term', () => {
    const reader = buildReader();
    const termId = reader.getTermId('learn');
    expect(termId).toBeDefined();
    // learning (doc2), learned + learn (doc3)
    const ids = [...reader.postings(termId!).docIds()];
    expect(ids).toEqual([2, 3]);
  });

  it('produces correct df, tf and sorted doc ids per term', () => {
    const reader = buildReader();
    const sat = reader.postingsForTerm('sat')!;
    expect(sat.df).toBe(2);
    expect([...sat.docIds()]).toEqual([0, 1]);

    const tfs: number[] = [];
    sat.forEach((_, docId, tf) => tfs.push(tf));
    expect(tfs).toEqual([1, 1]);
  });

  it('stores positions that are ready for phrase matching', () => {
    const reader = buildReader();
    // NOTE: "machine" stems to "machin" (final -e dropped by Porter step 5).
    const machine = reader.postingsForTerm('machin')!;
    const learn = reader.postingsForTerm('learn')!;

    // positions() takes the GLOBAL posting index (what forEach provides),
    // not a term-local ordinal.
    const globalIndexOf = (view: { forEach: (f: (i: number, d: number) => void) => void }, docId: number) => {
      let found = -1;
      view.forEach((i, d) => {
        if (d === docId) found = i;
      });
      return found;
    };

    // doc2: "machine learning algorithms learn ..." -> machin@0, learn@1,
    // algorithm@2, learn@3 — learn appears twice; machin@0/learn@1 are adjacent
    expect(machine.positions(globalIndexOf(machine, 2))).toEqual([0]);
    expect(learn.positions(globalIndexOf(learn, 2))).toEqual([1, 3]);

    // doc3: "the machine learned quickly and machines learn fast"
    // -> machin@0, learn@1, quickli@2, machin@3, learn@4, fast@5
    expect(machine.positions(globalIndexOf(machine, 3))).toEqual([0, 3]);
    expect(learn.positions(globalIndexOf(learn, 3))).toEqual([1, 4]);
  });

  it('keeps tf consistent with position counts', () => {
    const reader = buildReader();
    const learn = reader.postingsForTerm('learn')!;
    learn.forEach((index, _docId, tf) => {
      expect(learn.positions(index).length).toBe(tf);
    });
  });

  it('reports corpus statistics', () => {
    const reader = buildReader();
    const stats = reader.stats();
    expect(stats.numDocs).toBe(4);
    expect(stats.totalTokens).toBe(3 + 3 + 6 + 6);
    expect(stats.avgDocLength).toBeCloseTo(stats.totalTokens / stats.numDocs);
    expect(stats.vocabSize).toBeGreaterThan(0);
    expect(stats.numPostings).toBeGreaterThan(0);
  });

  it('freezes the analysis configuration for query-time reuse', () => {
    const writer = new IndexWriter();
    expect(writer.analysis.stopwords).toBe('english');
    expect(writer.analysis.stemming).toBe('porter');
  });
});

describe('writer lifecycle', () => {
  it('rejects documents after finalize', () => {
    const writer = new IndexWriter();
    writer.addDocument({ title: 'a', url: 'u', text: 'alpha' });
    writer.finalize();
    expect(() => writer.addDocument({ title: 'b', url: 'u', text: 'beta' })).toThrow(
      /finalized/,
    );
  });

  it('rejects double finalize', () => {
    const writer = new IndexWriter();
    writer.addDocument({ title: 'a', url: 'u', text: 'alpha' });
    writer.finalize();
    expect(() => writer.finalize()).toThrow(/finalized/);
  });

  it('handles an empty document and an empty corpus', () => {
    const writer = new IndexWriter();
    const id = writer.addDocument({ title: 'empty', url: 'u', text: '' });
    expect(id).toBe(0);
    const data = writer.finalize();
    expect(data.stats.numDocs).toBe(1);
    expect(data.stats.vocabSize).toBe(0);
    expect(data.stats.avgDocLength).toBe(0);
  });
});
