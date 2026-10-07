import { describe, expect, it } from 'vitest';
import { IndexWriter } from '../src/core/index/writer.js';
import { IndexReader } from '../src/core/index/reader.js';
import { parseQuery } from '../src/core/query/index.js';
import { matchPhrase, minimumWindow, proximityScore, retrieveBoolean } from '../src/core/retrieval/index.js';
import {
  bm25Strategy,
  bm25PhraseStrategy,
  bm25PhraseProximityStrategy,
  getRankingStrategy,
  RANKING_STRATEGIES,
} from '../src/core/ranking/index.js';
import { analyzeQuery } from '../src/core/retrieval/analyze-query.js';

/**
 * Phrase/proximity fixture (positions are post-analysis, stop-words removed):
 *
 *   doc | text           | (term@position)                         | dl
 *   ----|----------------|-----------------------------------------|---
 *   0   | red fox jumps  | red@0 fox@1 jump@2                      | 3
 *   1   | fox red        | fox@0 red@1                             | 2
 *   2   | red the fox    | red@0 fox@1    ('the' contributes none) | 2
 *   3   | red car        | red@0 car@1                             | 2
 *   4   | big red fox    | big@0 red@1 fox@2                       | 3
 *   5   | red big fox    | red@0 big@1 fox@2                       | 3
 */
function buildReader(): IndexReader {
  const writer = new IndexWriter();
  const texts = ['red fox jumps', 'fox red', 'red the fox', 'red car', 'big red fox', 'red big fox'];
  texts.forEach((text, i) =>
    writer.addDocument({ title: `doc${i}`, url: `https://example.com/${i}`, text }),
  );
  return IndexReader.fromData(writer.finalize());
}

describe('phrase matching (positional, not plain AND)', () => {
  it('matches only docs with consecutive positions, in order', () => {
    const reader = buildReader();
    expect([...matchPhrase(reader, ['red', 'fox'])]).toEqual([0, 2, 4]);
    // doc1 has both terms but reversed; doc5 has 'big' between them; doc3 lacks fox
  });

  it('is order-sensitive: "fox red" matches only doc1', () => {
    const reader = buildReader();
    expect([...matchPhrase(reader, ['fox', 'red'])]).toEqual([1]);
  });

  it('matches three-term chains and rejects broken chains', () => {
    const reader = buildReader();
    expect([...matchPhrase(reader, ['red', 'big', 'fox'])]).toEqual([5]);
    expect([...matchPhrase(reader, ['big', 'red', 'fox'])]).toEqual([4]);
    expect([...matchPhrase(reader, ['red', 'fox', 'jump'])]).toEqual([0]);
  });

  it('stop-words consume no position, so "red the fox" still matches "red fox"', () => {
    const reader = buildReader();
    expect([...matchPhrase(reader, ['red', 'fox'])]).toContain(2);
  });

  it('degrades to term lookup for one term; empty/missing terms give nothing', () => {
    const reader = buildReader();
    expect([...matchPhrase(reader, ['red'])]).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...matchPhrase(reader, ['red', 'purple'])]).toEqual([]);
    expect([...matchPhrase(reader, [])]).toEqual([]);
    expect([...matchPhrase(reader, ['red', 'car'])]).toEqual([3]);
  });

  it('works through the full parse -> analyze -> retrieve pipeline', () => {
    const reader = buildReader();
    expect([...retrieveBoolean(reader, parseQuery('"red fox"'))]).toEqual([0, 2, 4]);
    // surface stop-word inside the phrase analyzes away identically
    expect([...retrieveBoolean(reader, parseQuery('"red the fox"'))]).toEqual([0, 2, 4]);
    expect([...retrieveBoolean(reader, parseQuery('"red fox" OR car'))]).toEqual([0, 2, 3, 4]);
    expect([...retrieveBoolean(reader, parseQuery('"red fox" AND NOT big'))]).toEqual([0, 2]);
  });
});

describe('proximity windows', () => {
  it('computes the smallest covering window', () => {
    const reader = buildReader();
    expect(minimumWindow(reader, ['red', 'fox'], 0)).toBe(2); // red@0 fox@1
    expect(minimumWindow(reader, ['red', 'fox'], 4)).toBe(2); // red@1 fox@2
    expect(minimumWindow(reader, ['red', 'fox'], 5)).toBe(3); // red@0 big@1 fox@2
    expect(minimumWindow(reader, ['fox', 'red'], 1)).toBe(2); // fox@0 red@1
    expect(minimumWindow(reader, ['red', 'jump'], 0)).toBe(3); // red@0 jump@2
  });

  it('returns null when a term is absent or the term list is empty', () => {
    const reader = buildReader();
    expect(minimumWindow(reader, ['red', 'car'], 0)).toBeNull(); // no 'car' in doc0
    expect(minimumWindow(reader, ['purple', 'fox'], 0)).toBeNull();
    expect(minimumWindow(reader, [], 0)).toBeNull();
  });

  it('scores k/(1+(window−|q|)): adjacent = k, one gap costs half', () => {
    expect(proximityScore(2, 2, 1)).toBe(1); // window = |q| -> 1/(1+0)
    expect(proximityScore(3, 2, 1)).toBe(0.5); // 1/(1+1)
    expect(proximityScore(4, 2, 1)).toBeCloseTo(1 / 3, 10);
    expect(proximityScore(3, 2, 2)).toBe(1); // k scales the signal
    expect(proximityScore(null, 2, 1)).toBe(0); // no window
    expect(proximityScore(1, 1, 5)).toBe(0); // single term carries no signal
  });
});

describe('mode C strategies (ranking fixture from ranking.test)', () => {
  // alpha df=3 (0,1,2), beta df=2 (0,2); doc0: alpha@0 beta@1 gamma@2 (dl 3)
  // doc2: beta@0 alpha@1 alpha@2 (dl 3)
  function buildAlphaReader(): IndexReader {
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

  it('bm25-phrase equals bm25 when the query has no phrase', () => {
    const reader = buildAlphaReader();
    const parsed = parseQuery('alpha');
    const analyzed = analyzeQuery(parsed, reader.analysis);
    const candidates = retrieveBoolean(reader, parsed);
    const plain = bm25Strategy().rank(reader, analyzed, candidates);
    const withPhrase = bm25PhraseStrategy().rank(reader, analyzed, candidates);
    expect(withPhrase.map((s) => s.docId)).toEqual(plain.map((s) => s.docId));
    for (let i = 0; i < plain.length; i++) {
      expect(withPhrase[i]!.score).toBeCloseTo(plain[i]!.score, 10);
      expect(withPhrase[i]!.breakdown).toEqual({ bm25: plain[i]!.score, phrase: 0 });
    }
  });

  it('bm25-phrase adds the bonus on exactly-matched phrase leaves', () => {
    const reader = buildAlphaReader();
    const parsed = parseQuery('"alpha beta"');
    const result = bm25PhraseStrategy().rank(
      reader,
      analyzeQuery(parsed, reader.analysis),
      retrieveBoolean(reader, parsed),
    );
    // only doc0 contains alpha@0 beta@1; doc2 has them in reverse
    expect(result.map((s) => s.docId)).toEqual([0]);
    // bm25 = alpha(0.368265) + beta(0.715671) = 1.083935, phrase = +1.2
    expect(result[0]!.breakdown['bm25']).toBeCloseTo(1.083935, 3);
    expect(result[0]!.breakdown['phrase']).toBe(1.2);
    expect(result[0]!.score).toBeCloseTo(2.283935, 3);
  });

  it('proximity changes ranking: mode C flips bm25 order', () => {
    // Dedicated 2-doc fixture where the signals genuinely disagree:
    //   doc0 "alpha zeta beta"          alpha@0 beta@2 -> window 3 (far apart)
    //   doc1 "gamma gamma gamma alpha beta" alpha@3 beta@4 -> window 2 (adjacent)
    // bm25: doc0 is shorter (dl3 vs dl5, avgdl 4) -> wins on length
    // proximity: doc1 has adjacent terms -> wins on window
    const writer = new IndexWriter();
    ['alpha zeta beta', 'gamma gamma gamma alpha beta'].forEach((text, i) =>
      writer.addDocument({ title: `doc${i}`, url: `https://example.com/${i}`, text }),
    );
    const reader = IndexReader.fromData(writer.finalize());

    const parsed = parseQuery('alpha beta');
    const analyzed = analyzeQuery(parsed, reader.analysis);
    const candidates = retrieveBoolean(reader, parsed);
    expect([...candidates]).toEqual([0, 1]);

    const plain = bm25Strategy().rank(reader, analyzed, candidates);
    // doc0: 2 · 0.18232156 · 2.2/1.975 = 0.406185
    // doc1: 2 · 0.18232156 · 2.2/2.425 = 0.330810  (length penalty)
    expect(plain.map((s) => s.docId)).toEqual([0, 1]);
    expect(plain[0]!.score).toBeCloseTo(0.406185, 3);
    expect(plain[1]!.score).toBeCloseTo(0.330810, 3);

    const full = bm25PhraseProximityStrategy().rank(reader, analyzed, candidates);
    // doc1: 0.330810 + 1/(1+(2−2)) = 1.330810 > doc0: 0.406185 + 1/(1+(3−2)) = 0.906185
    expect(full.map((s) => s.docId)).toEqual([1, 0]);
    expect(full[0]!.breakdown).toEqual({ bm25: full[0]!.breakdown['bm25'], phrase: 0, proximity: 1 });
    expect(full[0]!.breakdown['proximity']).toBe(1);
    expect(full[1]!.breakdown['proximity']).toBe(0.5);
    expect(full[0]!.score).toBeCloseTo(1.330810, 3);
    expect(full[1]!.score).toBeCloseTo(0.906185, 3);
  });

  it('disables the proximity signal with proximityK = 0 (ablation arm)', () => {
    const reader = buildAlphaReader();
    const parsed = parseQuery('alpha beta');
    const analyzed = analyzeQuery(parsed, reader.analysis);
    const candidates = retrieveBoolean(reader, parsed);
    const ablated = bm25PhraseProximityStrategy({ proximityK: 0 }).rank(
      reader,
      analyzed,
      candidates,
    );
    expect(ablated.map((s) => s.docId)).toEqual([2, 0]); // back to pure bm25 order
    for (const r of ablated) expect(r.breakdown['proximity']).toBe(0);
  });

  it('validates phraseBonus and proximityK at construction', () => {
    expect(() => bm25PhraseStrategy({ phraseBonus: -1 })).toThrow(RangeError);
    expect(() => bm25PhraseProximityStrategy({ proximityK: -1 })).toThrow(RangeError);
    expect(() => bm25PhraseProximityStrategy({ k1: -1 })).toThrow(RangeError);
  });

  it('registers both mode-C strategies in the registry', () => {
    expect(getRankingStrategy('bm25-phrase').mode).toBe('C');
    expect(getRankingStrategy('bm25-phrase-proximity').mode).toBe('C');
    expect(Object.keys(RANKING_STRATEGIES)).toEqual([
      'boolean',
      'tfidf',
      'bm25',
      'bm25-phrase',
      'bm25-phrase-proximity',
    ]);
  });
});
