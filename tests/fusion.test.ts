import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IndexWriter } from '../src/core/index/writer.js';
import { IndexReader } from '../src/core/index/reader.js';
import { parseQuery } from '../src/core/query/index.js';
import { analyzeQuery, retrieveBoolean } from '../src/core/retrieval/index.js';
import {
  bm25Strategy,
  bm25PageRankStrategy,
  bm25TermScore,
  createStrategy,
  normalizeScores,
  resolveBm25,
  resolveStrategyParams,
} from '../src/core/ranking/index.js';
import {
  loadCitationGraph,
  pageRankForBundle,
  type LinkGraphBundle,
} from '../scripts/lib/pagerank-scores.js';

describe('normalizeScores (min-max with outlier guard)', () => {
  it('maps candidates to [0, 1] and leaves non-candidates at 0', () => {
    const raw = Float64Array.from([5, 1, 9, 0]);
    const out = normalizeScores(raw, Uint32Array.from([0, 2]));
    expect([...out]).toEqual([0, 0, 1, 0]); // min=5 max=9 → 5↦0, 9↦1
  });

  it('outlier guard confines a runaway candidate to the top band, order intact', () => {
    const n = 100;
    const raw = new Float64Array(n);
    for (let i = 0; i < n; i++) raw[i] = i;
    raw[50] = 1000; // outlier replaces value 50
    const candidates = new Uint32Array(n);
    for (let i = 0; i < n; i++) candidates[i] = i;

    // sorted = [0..49, 51..99, 1000]; p95 nearest-rank → index 94 → anchor 95.
    // v ≤ 95 spreads over [0, 0.95]; the tail {96..99, 1000} gets [0.95, 1].
    const guarded = normalizeScores(raw, candidates, { guardPercentile: 0.95 });
    expect(guarded[50]).toBe(1); // the outlier tops out at 1, nothing above it
    expect(guarded[51]!).toBeCloseTo(0.95 * 51 / 95, 6); // = 0.51
    expect(guarded[90]!).toBeCloseTo(0.95 * 90 / 95, 6); // = 0.90
    expect(guarded[95]!).toBeCloseTo(0.95, 6); // exactly at the anchor
    expect(guarded[96]!).toBeCloseTo(0.95 + 0.05 * 1 / 905, 6);
    expect(guarded[99]!).toBeCloseTo(0.95 + 0.05 * 4 / 905, 6);

    // strictly monotone on distinct inputs — no two raw scores collapse into
    // a tie (clamping to 1 would docId-order the whole top 5% band)
    const byValue = [...candidates].sort((a, b) => raw[a]! - raw[b]!);
    for (let i = 1; i < byValue.length; i++) {
      expect(guarded[byValue[i]!]!).toBeGreaterThan(guarded[byValue[i - 1]!]!);
    }

    // without the guard (percentile 1 = plain min-max) the outlier owns the
    // whole scale and value 99 collapses to 99/1000
    const plain = normalizeScores(raw, candidates, { guardPercentile: 1 });
    expect(plain[99]!).toBeCloseTo(99 / 1000, 6);
    expect(plain[51]!).toBeCloseTo(51 / 1000, 6);
    expect(plain[50]).toBe(1);
  });

  it('degenerate ranges normalize to 0 (no NaN), empty candidates stay 0', () => {
    const raw = Float64Array.from([7, 7, 7, 3]);
    expect([...normalizeScores(raw, Uint32Array.from([0, 1, 2]))]).toEqual([0, 0, 0, 0]);
    expect([...normalizeScores(raw, new Uint32Array(0))]).toEqual([0, 0, 0, 0]);
  });

  it('rejects guard percentiles outside (0, 1]', () => {
    expect(() => normalizeScores(new Float64Array(2), Uint32Array.from([0]), { guardPercentile: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      normalizeScores(new Float64Array(2), Uint32Array.from([0]), { guardPercentile: 1.5 }),
    ).toThrow(RangeError);
  });

  it('never mutates its inputs and is deterministic', () => {
    const raw = Float64Array.from([3, 1, 2]);
    const candidates = Uint32Array.from([0, 1, 2]);
    const a = normalizeScores(raw, candidates);
    const b = normalizeScores(raw, candidates);
    expect([...raw]).toEqual([3, 1, 2]);
    expect([...a]).toEqual([...b]);
  });
});

/**
 * Same hand-computable fixture as ranking.test.ts:
 *   N=4, avgdl=13/4; query `alpha` → candidates {0,1,2}:
 *   bm25 raw: doc0 = 0.368265, doc1 = 0.423260, doc2 = 0.501273
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

function rankAlpha(reader: IndexReader, pagerank: Float64Array, prWeight: number) {
  const parsed = parseQuery('alpha');
  return createStrategy('bm25-pr', { pagerank, prWeight }).rank(
    reader,
    analyzeQuery(parsed, reader.analysis),
    retrieveBoolean(reader, parsed),
  );
}

describe('bm25-pr (mode D fusion)', () => {
  const pagerank = Float64Array.from([0.1, 0.4, 0.2, 0.3]);

  it('w=0 reproduces the bm25 ordering exactly (monotone transform)', () => {
    const reader = buildReader();
    const parsed = parseQuery('alpha');
    const analyzed = analyzeQuery(parsed, reader.analysis);
    const candidates = retrieveBoolean(reader, parsed);
    const bm25 = bm25Strategy().rank(reader, analyzed, candidates).map((s) => s.docId);
    const fused = createStrategy('bm25-pr', { pagerank, prWeight: 0 }).rank(
      reader,
      analyzed,
      candidates,
    );
    expect(fused.map((s) => s.docId)).toEqual(bm25); // [2, 1, 0]
    expect(fused[0]!.breakdown.pagerank).toBe(0); // no PR contribution at w=0
  });

  it('w=1 orders candidates by PageRank alone', () => {
    const reader = buildReader();
    // candidates {0,1,2}: PR = 0.1, 0.4, 0.2 → doc1 > doc2 > doc0
    expect(rankAlpha(reader, pagerank, 1).map((s) => s.docId)).toEqual([1, 2, 0]);
  });

  it('w=0.5 matches the hand-computed fused scores and flips the top hit', () => {
    const reader = buildReader();
    const result = rankAlpha(reader, pagerank, 0.5);

    // Expected values derived from the M2-tested primitives (bm25TermScore
    // is hand-verified in ranking.test.ts) plus the explicit fusion formula:
    // candidates {0,1,2}: (tf, df=3, N=4, dl/avgdl) for query `alpha`.
    const p = resolveBm25();
    const raw = [
      bm25TermScore(1, 3, 4, 3 / 3.25, p),
      bm25TermScore(1, 3, 4, 2 / 3.25, p),
      bm25TermScore(2, 3, 4, 3 / 3.25, p),
    ];
    const min = Math.min(...raw);
    const max = Math.max(...raw);
    const sb = raw.map((r) => (r - min) / (max - min)); // n=3, p95 anchor = max
    const sp = [0, 1, 1 / 3]; // PR {0.1, 0.4, 0.2} min-maxed
    const expected = [0, 1, 2].map((i) => 0.5 * sb[i]! + 0.5 * sp[i]!);
    // PR flips bm25's [2, 1, 0] because doc1 holds max PageRank
    expect(result.map((s) => s.docId)).toEqual([1, 2, 0]);
    expect(result[0]!.score).toBeCloseTo(expected[1]!, 12);
    expect(result[1]!.score).toBeCloseTo(expected[2]!, 12);
    expect(result[2]!.score).toBeCloseTo(expected[0]!, 12);
    expect(result[2]!.score).toBe(0); // doc0 is min on BOTH signals
  });

  it('breakdown components sum to the score for every candidate', () => {
    const reader = buildReader();
    for (const w of [0, 0.25, 0.5, 1]) {
      for (const r of rankAlpha(reader, pagerank, w)) {
        expect(r.breakdown.bm25! + r.breakdown.pagerank!).toBeCloseTo(r.score, 12);
        expect(r.breakdown).toEqual({ bm25: expect.any(Number), pagerank: expect.any(Number) });
      }
    }
  });

  it('is deterministic across runs', () => {
    const reader = buildReader();
    const a = rankAlpha(reader, pagerank, 0.3).map((s) => `${s.docId}:${s.score}`);
    const b = rankAlpha(reader, pagerank, 0.3).map((s) => `${s.docId}:${s.score}`);
    expect(a).toEqual(b);
  });

  it('scores in [0, 1] — a convex combination of two normalized signals', () => {
    const reader = buildReader();
    for (const r of rankAlpha(reader, pagerank, 0.2)) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('validates options at construction and scores at rank time', () => {
    expect(() => createStrategy('bm25-pr')).toThrow(/pagerank/);
    expect(() => createStrategy('bm25-pr', { pagerank, prWeight: -0.1 })).toThrow(RangeError);
    expect(() => createStrategy('bm25-pr', { pagerank, prWeight: 1.5 })).toThrow(RangeError);
    expect(() => createStrategy('bm25-pr', { pagerank, normGuard: 0 })).toThrow(RangeError);

    const reader = buildReader();
    const short = Float64Array.from([1, 2]); // index has 4 docs
    const parsed = parseQuery('alpha');
    expect(() =>
      createStrategy('bm25-pr', { pagerank: short }).rank(
        reader,
        analyzeQuery(parsed, reader.analysis),
        retrieveBoolean(reader, parsed),
      ),
    ).toThrow(/4 docs/);
  });

  it('exposes mode D + resolved params for run artifacts', () => {
    const strategy = createStrategy('bm25-pr', { pagerank, prWeight: 0.25 });
    expect(strategy.mode).toBe('D');
    expect(strategy.id).toBe('bm25-pr-w0.25'); // weight in the id (bm25 convention)
    expect(resolveStrategyParams('bm25-pr')).toEqual({
      k1: 1.2,
      b: 0.75,
      prWeight: 0.2,
      normBm25: 'minmax-query',
      normPr: 'minmax-corpus',
      normGuard: 1, // plain min-max: the p95 guard hurts fusion (see EXPERIMENTS.md)
    });
    expect(resolveStrategyParams('bm25-pr', { prWeight: 0.5, normGuard: 0.95 })).toEqual({
      k1: 1.2,
      b: 0.75,
      prWeight: 0.5,
      normBm25: 'minmax-query',
      normPr: 'minmax-corpus',
      normGuard: 0.95,
    });
  });

  it('pure PageRank constructor does not need the static registry', () => {
    expect(bm25PageRankStrategy({ pagerank }).mode).toBe('D');
  });
});

describe('citation graph loader (scifact-citations.json)', () => {
  const graphFile = 'data/eval/scifact-citations.json';

  it('loads the committed graph with 2015 edges and a 64-hex graphHash', () => {
    const graph = loadCitationGraph(graphFile);
    expect(graph.edges.length).toBe(2015);
    expect(graph.graphHash).toMatch(/^[0-9a-f]{64}$/);
    expect(graph.kind).not.toBe('unknown');
    for (const [u, v] of graph.edges) {
      expect(Number.isInteger(u)).toBe(true);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('maps every endpoint to a synthetic node set and PageRank sums to 1', () => {
    const graph = loadCitationGraph(graphFile);
    const endpointSet = new Set<number>();
    for (const [u, v] of graph.edges) {
      endpointSet.add(u);
      endpointSet.add(v);
    }
    const ids = [...endpointSet].sort((a, b) => a - b).map(String);
    const docIdByCorpusId = new Map(ids.map((id, docId) => [id, docId]));
    const bundle: LinkGraphBundle = { ids, docIdByCorpusId };

    const first = pageRankForBundle(bundle, graph);
    const second = pageRankForBundle(bundle, graph);
    expect(first.scores.length).toBe(ids.length);
    expect(first.meta.converged).toBe(true);
    expect(first.meta.graphHash).toBe(graph.graphHash);
    expect(first.meta.nodeCount).toBe(ids.length);
    expect(first.meta.edgeCount).toBe(2015);
    expect([...first.scores].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    // deterministic: identical inputs → identical outputs
    expect([...first.scores]).toEqual([...second.scores]);
  });

  it('refuses to drop edges whose endpoints are missing from the id map', () => {
    const graph = loadCitationGraph(graphFile);
    const partial: LinkGraphBundle = {
      ids: ['5836'],
      docIdByCorpusId: new Map([['5836', 0]]),
    };
    expect(() => pageRankForBundle(partial, graph)).toThrow(/not in index id map/);
  });

  it('rejects files without edges or graphHash', () => {
    const tmp = 'data/eval/.tmp-bad-graph.json';
    fs.writeFileSync(tmp, JSON.stringify({ edges: [[1, 2]] }), 'utf8');
    try {
      expect(() => loadCitationGraph(tmp)).toThrow(/graphHash/);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    expect(() => loadCitationGraph('data/eval/does-not-exist.json')).toThrow(/not found/);
  });
});
