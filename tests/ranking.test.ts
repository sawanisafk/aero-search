import { describe, expect, it } from 'vitest';
import { IndexWriter } from '../src/core/index/writer.js';
import { IndexReader } from '../src/core/index/reader.js';
import { parseQuery } from '../src/core/query/index.js';
import { analyzeQuery, retrieveBoolean } from '../src/core/retrieval/index.js';
import {
  idf,
  tfWeight,
  maxTermFrequencies,
  bm25Idf,
  bm25TermScore,
  resolveBm25,
  booleanStrategy,
  tfidfStrategy,
  bm25Strategy,
  getRankingStrategy,
  createStrategy,
  resolveStrategyParams,
} from '../src/core/ranking/index.js';

/**
 * Ranking fixture with hand-computable statistics:
 *
 *   doc | text                          | terms (post-analysis)      | dl
 *   ----|-------------------------------|----------------------------|----
 *   0   | alpha beta gamma              | alpha, beta, gamma         | 3
 *   1   | alpha delta                   | alpha, delta               | 2
 *   2   | beta alpha alpha              | alpha, alpha, beta         | 3
 *   3   | gamma gamma gamma gamma delta | gamma×4, delta             | 5
 *
 *   N = 4, avgdl = 13/4 = 3.25
 *   df(alpha) = 3  (docs 0,1,2; tf 1,1,2)
 *   df(beta)  = 2  (docs 0,2)
 *   df(gamma) = 2  (docs 0,3)
 *   df(delta) = 2  (docs 1,3)
 *   maxtf per doc: [1, 1, 2, 4]
 */
function buildReader(): IndexReader {
  const writer = new IndexWriter();
  const texts = [
    'alpha beta gamma',
    'alpha delta',
    'beta alpha alpha',
    'gamma gamma gamma gamma delta',
  ];
  texts.forEach((text, i) =>
    writer.addDocument({ title: `doc${i}`, url: `https://example.com/${i}`, text }),
  );
  return IndexReader.fromData(writer.finalize());
}

describe('TF-IDF primitives', () => {
  it('idf = ln(N/df) with hand-computed values', () => {
    // ln(4/3) = 0.28768207
    expect(idf(4, 3)).toBeCloseTo(0.28768207, 7);
    // ln(4/4) = 0 — every doc matches, term carries no information
    expect(idf(4, 4)).toBe(0);
    // ln(4/1) = 1.38629436
    expect(idf(4, 1)).toBeCloseTo(1.38629436, 7);
  });

  it('raw / log / augmented tf weightings match their formulas', () => {
    expect(tfWeight(0, 4, 'raw')).toBe(0);
    expect(tfWeight(3, 4, 'raw')).toBe(3);

    expect(tfWeight(1, 4, 'log')).toBe(1);
    // 1 + ln(2) = 1.69314718
    expect(tfWeight(2, 4, 'log')).toBeCloseTo(1.69314718, 7);
    expect(tfWeight(0, 4, 'log')).toBe(0);

    // 0.5 + 0.5·2/4 = 0.75
    expect(tfWeight(2, 4, 'augmented')).toBeCloseTo(0.75, 10);
    // tf equal to maxtf -> 1.0
    expect(tfWeight(2, 2, 'augmented')).toBeCloseTo(1.0, 10);
    expect(tfWeight(0, 4, 'augmented')).toBe(0);
  });

  it('computes per-document max tf once and caches it per reader', () => {
    const reader = buildReader();
    const first = maxTermFrequencies(reader);
    expect([...first]).toEqual([1, 1, 2, 4]);
    expect(maxTermFrequencies(reader)).toBe(first);
  });
});

describe('BM25 primitives', () => {
  it('idf uses the smoothed formula and stays positive at df = N', () => {
    // ln(1 + (4−3+0.5)/(3+0.5)) = ln(1 + 1.5/3.5) = ln(1.428571) = 0.35667494
    expect(bm25Idf(4, 3)).toBeCloseTo(0.35667494, 7);
    // ln(1 + 0.5/4.5) = ln(1.111111) = 0.10536052 > 0
    expect(bm25Idf(4, 4)).toBeCloseTo(0.10536052, 7);
  });

  it('scores a term/doc pair exactly as the hand calculation says', () => {
    const params = resolveBm25(); // k1=1.2, b=0.75
    // doc0: tf=1, dl=3, dl/avgdl = 3/3.25 = 0.9230769
    //   lengthNorm = 1 − 0.75 + 0.75·0.9230769 = 0.9423077
    //   denom = 1 + 1.2·0.9423077 = 2.1307692
    //   score = 0.35667494 · (1·2.2)/2.1307692 = 0.35667494 · 1.0324920 = 0.368265
    expect(bm25TermScore(1, 3, 4, 3 / 3.25, params)).toBeCloseTo(0.368265, 4);

    // doc1: tf=1, dl=2, ratio = 0.6153846
    //   lengthNorm = 0.25 + 0.75·0.6153846 = 0.7115385
    //   denom = 1 + 1.2·0.7115385 = 1.8538462
    //   score = 0.35667494 · 2.2/1.8538462 = 0.35667494 · 1.1866866 = 0.423260
    expect(bm25TermScore(1, 3, 4, 2 / 3.25, params)).toBeCloseTo(0.423260, 4);

    // doc2: tf=2, dl=3, ratio = 0.9230769
    //   denom = 2 + 1.2·0.9423077 = 3.1307692
    //   score = 0.35667494 · 4.4/3.1307692 = 0.35667494 · 1.4054054 = 0.501273
    expect(bm25TermScore(2, 3, 4, 3 / 3.25, params)).toBeCloseTo(0.501273, 4);
  });

  it('saturates tf: doubling tf does not double the score', () => {
    const params = resolveBm25();
    const one = bm25TermScore(1, 3, 4, 1, params);
    const two = bm25TermScore(2, 3, 4, 1, params);
    expect(two).toBeGreaterThan(one);
    expect(two).toBeLessThan(2 * one);
  });

  it('k1 = 0 collapses every matching doc to the same idf score', () => {
    const params = resolveBm25({ k1: 0 });
    const expected = bm25Idf(4, 3);
    expect(bm25TermScore(1, 3, 4, 1, params)).toBeCloseTo(expected, 10);
    expect(bm25TermScore(9, 3, 4, 5, params)).toBeCloseTo(expected, 10);
  });

  it('b = 0 turns length normalization off', () => {
    const params = resolveBm25({ b: 0 });
    // score = idf · tf(k1+1)/(tf + k1) — depends on tf only, not on dl
    expect(bm25TermScore(1, 3, 4, 1, params)).toBeCloseTo(
      bm25TermScore(1, 3, 4, 3, params),
      12,
    );
  });

  it('validates k1 and b ranges', () => {
    expect(() => resolveBm25({ k1: -1 })).toThrow(RangeError);
    expect(() => resolveBm25({ b: 1.5 })).toThrow(RangeError);
    expect(resolveBm25({ k1: 2, b: 0.5 })).toEqual({ k1: 2, b: 0.5 });
  });
});

describe('ranking strategies', () => {
  it('boolean strategy returns candidates unranked in docId order', () => {
    const reader = buildReader();
    const parsed = parseQuery('alpha');
    const result = booleanStrategy.rank(
      reader,
      analyzeQuery(parsed, reader.analysis),
      retrieveBoolean(reader, parsed),
    );
    expect(result.map((s) => s.docId)).toEqual([0, 1, 2]);
    expect(result[0]).toEqual({ docId: 0, score: 0, breakdown: { boolean: 0 } });
  });

  it('tfidf (raw) ranks by tf·ln(N/df) with hand-computed scores', () => {
    const reader = buildReader();
    const parsed = parseQuery('alpha');
    const analyzed = analyzeQuery(parsed, reader.analysis);
    const result = tfidfStrategy().rank(
      reader,
      analyzed,
      retrieveBoolean(reader, parsed),
    );
    // doc2: 2·ln(4/3) = 0.57536414 > doc0 = doc1 = ln(4/3) = 0.28768207 (tie -> docId)
    expect(result.map((s) => s.docId)).toEqual([2, 0, 1]);
    expect(result[0]!.score).toBeCloseTo(0.57536414, 5);
    expect(result[1]!.score).toBeCloseTo(0.28768207, 5);
    expect(result[0]!.breakdown).toEqual({ tfidf: result[0]!.score });
  });

  it('tfidf (log) damps tf: doc2 scores (1+ln2)·ln(4/3) = 0.487088', () => {
    const reader = buildReader();
    const result = tfidfStrategy({ tf: 'log' }).rank(
      reader,
      analyzeQuery(parseQuery('alpha'), reader.analysis),
      retrieveBoolean(reader, parseQuery('alpha')),
    );
    expect(result.map((s) => s.docId)).toEqual([2, 0, 1]);
    expect(result[0]!.score).toBeCloseTo(0.487088, 5);
    expect(result[1]!.score).toBeCloseTo(0.28768207, 5);
  });

  it('tfidf (augmented) normalizes by maxtf and ties these docs', () => {
    const reader = buildReader();
    const result = tfidfStrategy({ tf: 'augmented' }).rank(
      reader,
      analyzeQuery(parseQuery('alpha'), reader.analysis),
      retrieveBoolean(reader, parseQuery('alpha')),
    );
    // doc0: 0.5+0.5·1/1 = 1; doc2: 0.5+0.5·2/2 = 1 — identical weights
    for (const r of result) expect(r.score).toBeCloseTo(0.28768207, 5);
    expect(result.map((s) => s.docId)).toEqual([0, 1, 2]);
  });

  it('bm25 (defaults) reproduces the hand-computed ranking', () => {
    const reader = buildReader();
    const result = bm25Strategy().rank(
      reader,
      analyzeQuery(parseQuery('alpha'), reader.analysis),
      retrieveBoolean(reader, parseQuery('alpha')),
    );
    expect(result.map((s) => s.docId)).toEqual([2, 1, 0]);
    expect(result[0]!.score).toBeCloseTo(0.501273, 4); // doc2 tf=2
    expect(result[1]!.score).toBeCloseTo(0.423260, 4); // doc1 short doc beats doc0
    expect(result[2]!.score).toBeCloseTo(0.368265, 4); // doc0 longer doc, same tf
    expect(result[0]!.breakdown).toEqual({ bm25: result[0]!.score });
  });

  it('bm25 scores every candidate for a multi-term query', () => {
    const reader = buildReader();
    const parsed = parseQuery('alpha OR delta'); // candidates = union = {0,1,2,3}
    const result = bm25Strategy().rank(
      reader,
      analyzeQuery(parsed, reader.analysis),
      retrieveBoolean(reader, parsed),
    );
    // doc1 matches both terms (0.423 + 0.823 ≈ 1.246) and wins; then
    // doc3 (delta in a long doc), doc2 (alpha tf=2), doc0 (alpha tf=1)
    expect(result.map((s) => s.docId)).toEqual([1, 3, 2, 0]);
    expect(result[0]!.score).toBeCloseTo(1.245805, 3);
    expect(result[1]!.score).toBeCloseTo(0.568021, 3);
  });

  it('not-scoring terms under NOT: query `alpha NOT delta` scores alpha only', () => {
    const reader = buildReader();
    const parsed = parseQuery('alpha NOT delta');
    const analyzed = analyzeQuery(parsed, reader.analysis);
    const candidates = retrieveBoolean(reader, parsed); // alpha \ delta = {0,2}
    const result = bm25Strategy().rank(reader, analyzed, candidates);
    expect(result.map((s) => s.docId)).toEqual([2, 0]);
    expect(result[0]!.score).toBeCloseTo(0.501273, 4); // pure alpha contribution
    expect(result[1]!.score).toBeCloseTo(0.368265, 4);
  });

  it('registry resolves strategies and rejects unknown ids', () => {
    expect(getRankingStrategy('boolean').mode).toBe('BOOL');
    expect(getRankingStrategy('tfidf').mode).toBe('A');
    expect(getRankingStrategy('bm25').mode).toBe('B');
    expect(() => getRankingStrategy('pagerank')).toThrow(/unknown ranking strategy/);
  });

  it('ranking is deterministic: equal scores order by docId', () => {
    const reader = buildReader();
    const parsed = parseQuery('beta'); // docs 0 and 2, tf=1 each, different dl
    const run = () =>
      tfidfStrategy({ tf: 'raw' })
        .rank(reader, analyzeQuery(parsed, reader.analysis), retrieveBoolean(reader, parsed))
        .map((s) => s.docId);
    expect(run()).toEqual(run());
  });
});

describe('createStrategy (configured construction)', () => {
  it('builds every id with defaults matching the registry', () => {
    expect(createStrategy('boolean').mode).toBe('BOOL');
    expect(createStrategy('tfidf').id).toBe(getRankingStrategy('tfidf').id);
    expect(createStrategy('bm25').id).toBe(getRankingStrategy('bm25').id);
    expect(createStrategy('bm25-phrase').mode).toBe('C');
    expect(createStrategy('bm25-phrase-proximity').mode).toBe('C');
  });

  it('applies explicit parameter overrides to the id', () => {
    expect(createStrategy('bm25', { k1: 2, b: 0.5 }).id).toBe('bm25-k2-b0.5');
    expect(createStrategy('tfidf', { tf: 'log' }).id).toBe('tfidf-log');
  });

  it('treats explicit undefined as "use the default"', () => {
    expect(createStrategy('bm25', { k1: undefined, b: undefined }).id).toBe('bm25-k1.2-b0.75');
  });

  it('rejects invalid parameters and unknown ids at construction time', () => {
    expect(() => createStrategy('bm25', { k1: -1 })).toThrow(RangeError);
    expect(() => createStrategy('bm25-phrase', { phraseBonus: -1 })).toThrow(RangeError);
    expect(() => createStrategy('bm25-phrase-proximity', { proximityK: -1 })).toThrow(RangeError);
    expect(() => createStrategy('pagerank')).toThrow(/unknown ranking strategy/);
  });

  it('resolveStrategyParams reports fully-resolved values for artifacts', () => {
    expect(resolveStrategyParams('boolean')).toEqual({});
    expect(resolveStrategyParams('tfidf')).toEqual({ tf: 'raw' });
    expect(resolveStrategyParams('tfidf', { tf: 'log' })).toEqual({ tf: 'log' });
    expect(resolveStrategyParams('bm25')).toEqual({ k1: 1.2, b: 0.75 });
    expect(resolveStrategyParams('bm25', { k1: 2 })).toEqual({ k1: 2, b: 0.75 });
    expect(resolveStrategyParams('bm25-phrase')).toEqual({
      k1: 1.2,
      b: 0.75,
      phraseBonus: 1.2,
    });
    expect(resolveStrategyParams('bm25-phrase-proximity', { proximityK: 0 })).toEqual({
      k1: 1.2,
      b: 0.75,
      phraseBonus: 1.2,
      proximityK: 0,
    });
    expect(() => resolveStrategyParams('pagerank')).toThrow(/unknown ranking strategy/);
  });
});
