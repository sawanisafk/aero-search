import { describe, expect, it } from 'vitest';
import {
  precisionAtK,
  recallAtK,
  f1AtK,
  averagePrecision,
  ndcgAtK,
  evaluateQuery,
  evaluateRun,
  parseQrelsTsv,
  parseQueriesJsonl,
} from '../src/eval/index.js';

describe('precision / recall / F1 (hand-calculated)', () => {
  // relevant: r1 r2 r3 ; ranked: x r1 y r2 z r3
  const ranked = ['x', 'r1', 'y', 'r2', 'z', 'r3'];
  const relevant = new Set(['r1', 'r2', 'r3']);

  it('P@K divides by K even when the run is shorter than K', () => {
    expect(precisionAtK(ranked, relevant, 1)).toBe(0); // x
    expect(precisionAtK(ranked, relevant, 3)).toBeCloseTo(1 / 3, 10); // r1
    expect(precisionAtK(ranked, relevant, 5)).toBeCloseTo(2 / 5, 10); // r1 r2
    expect(precisionAtK(ranked, relevant, 6)).toBeCloseTo(3 / 6, 10); // r1 r2 r3
    expect(precisionAtK(ranked, relevant, 10)).toBeCloseTo(3 / 10, 10); // only 6 returned
    expect(() => precisionAtK(ranked, relevant, 0)).toThrow(RangeError);
  });

  it('R@K divides by the total number of relevant docs', () => {
    expect(recallAtK(ranked, relevant, 1)).toBe(0);
    expect(recallAtK(ranked, relevant, 3)).toBeCloseTo(1 / 3, 10);
    expect(recallAtK(ranked, relevant, 5)).toBeCloseTo(2 / 3, 10);
    expect(recallAtK(ranked, relevant, 6)).toBe(1);
    expect(recallAtK(ranked, new Set(), 6)).toBe(0); // no judged relevant docs
  });

  it('F1@K is the harmonic mean (worked example: P=2/5, R=2/3 -> 0.5)', () => {
    expect(f1AtK(ranked, relevant, 1)).toBe(0); // P = R = 0
    // P = 1/3, R = 1/3 -> F1 = 1/3
    expect(f1AtK(ranked, relevant, 3)).toBeCloseTo(1 / 3, 10);
    // P = 0.4, R = 2/3: F1 = 2·0.4·(2/3) / (0.4 + 2/3) = 0.5333.../1.0666... = 0.5
    expect(f1AtK(ranked, relevant, 5)).toBeCloseTo(0.5, 10);
  });
});

describe('average precision (hand-calculated)', () => {
  it('averages precision at each relevant rank', () => {
    // relevant d2 d4 d5; ranked d1 d2 d3 d4 d5
    // AP = (P@2 + P@4 + P@5) / 3 = (1/2 + 2/4 + 3/5) / 3 = 1.6/3 = 0.533333...
    const ranked = ['d1', 'd2', 'd3', 'd4', 'd5'];
    const relevant = new Set(['d2', 'd4', 'd5']);
    expect(averagePrecision(ranked, relevant)).toBeCloseTo(1.6 / 3, 10);
  });

  it('missed relevant docs still count in the denominator', () => {
    // relevant d2 d9; ranked d1 d2 -> only P@2 = 1/2 is earned, /2 relevant
    expect(averagePrecision(['d1', 'd2'], new Set(['d2', 'd9']))).toBeCloseTo(0.25, 10);
  });

  it('is 0 when nothing relevant exists or nothing is retrieved', () => {
    expect(averagePrecision(['x'], new Set())).toBe(0);
    expect(averagePrecision([], new Set(['a']))).toBe(0);
  });
});

describe('NDCG@K (hand-calculated, graded)', () => {
  it('computes DCG/IDCG with gain 2^g − 1 and log2 discount', () => {
    // grades: d1 -> 2, d3 -> 1; ranked: d2(unjudged), d1, d3
    // DCG@3  = 0/log2(2) + 3/log2(3) + 1/log2(4) = 1.8927893 + 0.5 = 2.3927893
    // IDCG@3 = 3/log2(2) + 1/log2(3)            = 3 + 0.6309298 = 3.6309298
    // NDCG   = 2.3927893 / 3.6309298 = 0.659002
    const grades = new Map([
      ['d1', 2],
      ['d3', 1],
    ]);
    expect(ndcgAtK(['d2', 'd1', 'd3'], grades, 3)).toBeCloseTo(0.659002, 5);
  });

  it('perfect ranking scores exactly 1', () => {
    const grades = new Map([
      ['d1', 2],
      ['d3', 1],
    ]);
    expect(ndcgAtK(['d1', 'd3', 'd2'], grades, 3)).toBeCloseTo(1, 10);
    expect(ndcgAtK(['d1', 'd3', 'd2'], grades, 1)).toBeCloseTo(1, 10);
  });

  it('unjudged docs consume rank without contributing gain', () => {
    // ranked d9(unjudged), d1(grade 2)
    // DCG@2 = 0 + 3/log2(3) = 1.8927893; IDCG@2 = 3.6309298 -> 0.5213
    const grades = new Map([
      ['d1', 2],
      ['d3', 1],
    ]);
    expect(ndcgAtK(['d9', 'd1'], grades, 2)).toBeCloseTo(0.5213, 4);
  });

  it('returns 0 when the query has no positive judgments', () => {
    expect(ndcgAtK(['a', 'b'], new Map(), 5)).toBe(0);
    expect(ndcgAtK(['a'], new Map([['a', 0]]), 5)).toBe(0);
    expect(() => ndcgAtK(['a'], new Map(), 0)).toThrow(RangeError);
  });
});

describe('evaluateQuery / evaluateRun', () => {
  const qrels = new Map([
    ['q1', new Map([['a', 1], ['b', 1]])],
    ['q2', new Map([['c', 1]])],
  ]);

  it('scores a single query and treats grade 0 as not relevant', () => {
    const judged = new Map([['a', 1], ['z', 0]]);
    const r = evaluateQuery('q1', ['x', 'a', 'y'], judged, [2]);
    expect(r.precision[2]).toBeCloseTo(0.5, 10); // 1 hit in top 2
    expect(r.recall[2]).toBeCloseTo(1, 10); // the only relevant doc is in top 2
    expect(r.averagePrecision).toBeCloseTo(0.5, 10); // only a@2 is a hit
  });

  it('aggregates over qrels; a missing run entry counts as empty ranking', () => {
    const run = new Map([['q1', ['x', 'a', 'y', 'b']]]);
    const summary = evaluateRun(run, qrels, [2]);
    expect(summary.queries).toBe(2);
    // q1: P@2 = 1/2, R@2 = 1/2, F1@2 = 1/2, AP = (1/2 + 2/4)/2 = 0.5
    // q2: empty -> 0 everywhere
    expect(summary.precision[2]).toBeCloseTo(0.25, 10); // (0.5 + 0)/2
    expect(summary.recall[2]).toBeCloseTo(0.25, 10);
    expect(summary.f1[2]).toBeCloseTo(0.25, 10);
    // q1 NDCG@2 = 0.6309298/1.6309298 = 0.386853; q2 NDCG = 0 (IDCG 1, DCG 0)
    expect(summary.ndcg[2]).toBeCloseTo(0.193426, 5); // (0.386853 + 0)/2
    expect(summary.map).toBeCloseTo(0.25, 10); // (0.5 + 0)/2
    expect(summary.kValues).toEqual([2]);
  });

  it('evaluates every k value requested', () => {
    const run = new Map([
      ['q1', ['a', 'b']],
      ['q2', ['c']],
    ]);
    const summary = evaluateRun(run, qrels, [1, 2]);
    expect(summary.precision[1]).toBeCloseTo(1, 10); // (1 + 1)/2
    expect(summary.ndcg[2]).toBeCloseTo(1, 10); // perfect on both
    expect(summary.map).toBeCloseTo(1, 10);
  });
});

describe('parseQrelsTsv (BEIR format)', () => {
  it('parses the SciFact-style header + rows', () => {
    const tsv = ['query-id\tcorpus-id\tscore', '1\t31715818\t1', '3\t14717500\t1', '', '5\t13734012\t1'].join('\n');
    const qrels = parseQrelsTsv(tsv);
    expect(qrels.size).toBe(3);
    expect(qrels.get('1')!.get('31715818')).toBe(1);
    expect(qrels.get('5')!.get('13734012')).toBe(1);
  });

  it('handles CRLF line endings and data-first files (no header)', () => {
    const qrels = parseQrelsTsv('q1\td1\t2\r\nq1\td2\t0\r\n');
    expect(qrels.get('q1')!.get('d1')).toBe(2);
    expect(qrels.get('q1')!.get('d2')).toBe(0);
  });

  it('rejects malformed rows with a line number', () => {
    expect(() => parseQrelsTsv('query-id\tcorpus-id\tscore\nq1\td1')).toThrow(
      /qrels line 2: expected 3/,
    );
    expect(() => parseQrelsTsv('query-id\tcorpus-id\tscore\nq1\td1\tnot-a-number')).toThrow(
      /qrels line 2: invalid score/,
    );
    expect(() => parseQrelsTsv('query-id\tcorpus-id\tscore\nq1\td1\t1\nq1\td1\t1')).toThrow(
      /qrels line 3: duplicate judgment/,
    );
    expect(() => parseQrelsTsv('query-id\tcorpus-id\tgrade\nq1\td1\t1')).toThrow(
      /unexpected header/,
    );
  });
});

describe('parseQueriesJsonl (BEIR format)', () => {
  it('parses id/text pairs and skips blank lines', () => {
    const queries = parseQueriesJsonl(
      '{"_id": "0", "text": "0-dimensional biomaterials.", "metadata": {}}\n\n{"_id": "2", "text": "PrP positivity."}\n',
    );
    expect(queries.size).toBe(2);
    expect(queries.get('0')).toBe('0-dimensional biomaterials.');
    expect(queries.get('2')).toBe('PrP positivity.');
  });

  it('rejects invalid JSON and missing fields with a line number', () => {
    expect(() => parseQueriesJsonl('{"_id": "0", "text": "ok"}\n{oops')).toThrow(
      /queries line 2: invalid JSON/,
    );
    expect(() => parseQueriesJsonl('{"_id": "0"}')).toThrow(
      /queries line 1: missing string fields/,
    );
    expect(() => parseQueriesJsonl('[1,2]')).toThrow(/expected a JSON object/);
  });
});
