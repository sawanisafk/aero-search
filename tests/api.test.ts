/**
 * M5 API tests — HTTP contract for the search service.
 *
 * Hermetic: read-only against the bundled static-v1 fixture corpus (plus the
 * committed crawled index and committed benchmark artifacts). No network,
 * no PostgreSQL (DATABASE_URL is removed for the crawled test). The
 * static-v1 index is built with the real index:build command only when the
 * gitignored artifact is absent (fresh clone / Docker).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.js';
import { loadConfig } from '../src/api/config.js';

const ROOT = process.cwd();

function ensureStaticIndex(): void {
  if (!fs.existsSync(path.join(ROOT, 'data', 'index', 'static-v1.aidx'))) {
    execSync('npm run index:build -- --corpus static-v1', { cwd: ROOT, stdio: 'inherit' });
  }
}

let app: FastifyInstance;

beforeAll(async () => {
  ensureStaticIndex();
  const cfg = { ...loadConfig(process.env, ROOT), defaultCorpus: 'static-v1' };
  app = buildApp({ config: cfg, logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('is alive without loading an index', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(body.corpora).toContain('static-v1');
    expect(Array.isArray(body.loadedCorpora)).toBe(true);
  });
});

describe('GET /api/search', () => {
  it('returns ranked results with full metadata and diagnostics', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=alice' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.query).toBe('alice');
    expect(body.strategy).toBe('bm25');
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.length).toBeLessThanOrEqual(10);
    expect(body.results[0].rank).toBe(1);
    expect(body.meta.corpus).toBe('static-v1');
    expect(body.meta.k).toBe(10);
    expect(body.meta.page).toBe(1);
    expect(body.meta.totalCandidates).toBeGreaterThanOrEqual(body.results.length);
    expect(body.meta.returned).toBe(body.results.length);
    expect(body.meta.latencyMs).toBeGreaterThan(0);
    expect(body.meta.timing.parseMs).toBeGreaterThanOrEqual(0);
    expect(body.meta.timing.rankMs).toBeGreaterThanOrEqual(0);
    expect(body.meta.strategyDetail.id).toBe('bm25');
    expect(body.meta.strategyDetail.engineId).toBe('bm25-k1.2-b0.75');
    expect(body.meta.strategyDetail.mode).toBeTruthy();
    expect(body.meta.strategyDetail.params.k1).toBe(1.2);
    expect(body.meta.diagnostics.implicitOperator).toBe('or');
    expect(body.meta.diagnostics.analyzedTerms).toContain('alic');
    expect(body.meta.diagnostics.positiveTerms).toContain('alic');
    expect(body.meta.fuzzy.applied).toBe(false);
    expect(body.meta.expandedTerms).toEqual([]);
    const hit = body.results[0];
    expect(typeof hit.docId).toBe('string');
    expect(hit.title).toBeTruthy();
    expect(hit.source).toBe('static-v1');
    expect(typeof hit.score).toBe('number');
    expect(hit.signals.bm25).toBeGreaterThan(0);
  });

  it('keeps results sorted by descending score', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=alice&k=10' });
    const scores: number[] = res.json().results.map((r: { score: number }) => r.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]! + 1e-12);
    }
  });

  it('produces snippets whose highlight offsets are consistent with the document text', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=alic&k=3' });
    const body = res.json();
    const matchedResult = body.results.find(
      (r: { snippet: { matched: boolean } | null }) => r.snippet !== null && r.snippet.matched,
    );
    expect(matchedResult).toBeDefined();
    const snip = matchedResult.snippet;
    expect(snip.highlights.length).toBeGreaterThan(0);
    for (const h of snip.highlights) {
      expect(h.start).toBeGreaterThanOrEqual(0);
      expect(h.end).toBeGreaterThan(h.start);
      expect(h.end).toBeLessThanOrEqual(snip.text.length);
      expect(typeof h.term).toBe('string');
    }
    expect(snip.sourceStart).toBeGreaterThanOrEqual(0);
    // The snippet must be a literal slice of the document text at sourceStart.
    const docRes = await app.inject({
      method: 'GET',
      url: `/api/documents/static-v1/${encodeURIComponent(matchedResult.docId)}`,
    });
    expect(docRes.statusCode).toBe(200);
    const text: string = docRes.json().text;
    expect(text.slice(snip.sourceStart, snip.sourceStart + snip.text.length)).toBe(snip.text);
  });

  it('pages deterministically without overlap', async () => {
    const p1 = await app.inject({ method: 'GET', url: '/api/search?q=alic&k=5&page=1' });
    const p2 = await app.inject({ method: 'GET', url: '/api/search?q=alic&k=5&page=2' });
    expect(p1.statusCode).toBe(200);
    expect(p2.statusCode).toBe(200);
    const ids1: string[] = p1.json().results.map((r: { docId: string }) => r.docId);
    const ids2: string[] = p2.json().results.map((r: { docId: string }) => r.docId);
    expect(ids1).toHaveLength(5);
    expect(ids2.length).toBeGreaterThan(0);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
    expect(p1.json().results[0].rank).toBe(1);
    expect(p2.json().results[0].rank).toBe(6);
    expect(p1.json().meta.totalPages).toBe(p2.json().meta.totalPages);
    expect(p1.json().meta.totalPages).toBeGreaterThanOrEqual(2);
  });

  it('returns an empty page past the end instead of failing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=alic&page=999' });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([]);
    expect(res.json().meta.page).toBe(999);
  });

  it('treats unknown query params as ignorable (coercion + removal)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=alic&junk=1' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects out-of-range and malformed params with VALIDATION', async () => {
    for (const url of [
      '/api/search',
      '/api/search?q=',
      '/api/search?q=alic&k=0',
      '/api/search?q=alic&k=51',
      '/api/search?q=alic&page=0',
      '/api/search?q=alic&fuzzyEdits=7',
      '/api/search?q=alic&implicit=maybe',
      `/api/search?q=${'x'.repeat(600)}`,
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION');
    }
  });

  it('rejects unknown strategies and corpora with typed 400s', async () => {
    const s = await app.inject({ method: 'GET', url: '/api/search?q=alic&strategy=l2r' });
    expect(s.statusCode).toBe(400);
    expect(s.json().error.code).toBe('INVALID_STRATEGY');
    const c = await app.inject({ method: 'GET', url: '/api/search?q=alic&corpus=nope' });
    expect(c.statusCode).toBe(400);
    expect(c.json().error.code).toBe('INVALID_CORPUS');
    expect(c.json().error.message).toContain('static-v1');
  });

  it('reports query parse failures as typed 400s with position', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=(' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('QUERY_PARSE');
    expect(res.json().error.message).toMatch(/at position \d+/);
  });

  it('finds nothing for an absent term but recovers it with fuzzy expansion', async () => {
    const plain = await app.inject({ method: 'GET', url: '/api/search?q=wonderlan' });
    expect(plain.statusCode).toBe(200);
    expect(plain.json().results).toEqual([]);

    const fuzzy = await app.inject({
      method: 'GET',
      url: '/api/search?q=wonderlan&fuzzy=true&fuzzyEdits=1',
    });
    expect(fuzzy.statusCode).toBe(200);
    const body = fuzzy.json();
    expect(body.meta.fuzzyApplied).toBe(true);
    expect(body.meta.fuzzy.expansions).toHaveLength(1);
    expect(body.meta.fuzzy.expansions[0].term).toBe('wonderlan');
    expect(body.meta.fuzzy.expansions[0].variants).toContain('wonderland');
    expect(body.meta.fuzzy.expansions[0].distance).toBe(1);
    expect(body.meta.expandedTerms).toContain('wonderland');
    expect(body.meta.diagnostics.positiveTerms).toContain('wonderland');
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0].title).toContain('Alice');
  });

  it('narrows results when implicit=and', async () => {
    const or = await app.inject({ method: 'GET', url: '/api/search?q=alic+wonderland&k=50' });
    const and = await app.inject({
      method: 'GET',
      url: '/api/search?q=alic+wonderland&k=50&implicit=and',
    });
    expect(or.statusCode).toBe(200);
    expect(and.statusCode).toBe(200);
    expect(or.json().results.length).toBeGreaterThan(0);
    expect(and.json().results.length).toBeLessThanOrEqual(or.json().results.length);
    expect(and.json().meta.diagnostics.implicitOperator).toBe('and');
  });

  it('serves every implemented strategy except unavailable bm25-pr', async () => {
    for (const strategy of ['boolean', 'tfidf', 'bm25', 'bm25-phrase', 'bm25-phrase-proximity']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/search?q=alice&strategy=${strategy}&k=5`,
      });
      expect(res.statusCode, strategy).toBe(200);
      const body = res.json();
      expect(body.meta.strategyDetail.id).toBe(strategy);
      expect(typeof body.meta.strategyDetail.engineId).toBe('string');
      expect(body.results.length).toBeGreaterThan(0);
      if (strategy !== 'boolean') {
        expect(Object.keys(body.results[0].signals).length).toBeGreaterThan(0);
      }
    }
    const pr = await app.inject({ method: 'GET', url: '/api/search?q=alice&strategy=bm25-pr' });
    expect(pr.statusCode).toBe(400);
    expect(pr.json().error.code).toBe('STRATEGY_UNAVAILABLE');
    expect(pr.json().error.message).toContain('static-v1');
  });

  it('answers API 404s in the standard error shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('maps a corrupt on-disk index to 503 INDEX_UNAVAILABLE', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-api-'));
    try {
      fs.mkdirSync(path.join(tmp, 'data', 'index'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'data', 'index', 'fake.aidx'), 'not-an-index');
      const cfg = { ...loadConfig(process.env, ROOT), root: tmp, defaultCorpus: 'fake' };
      const broken = buildApp({ config: cfg, logger: false });
      await broken.ready();
      const res = await broken.inject({ method: 'GET', url: '/api/search?q=x' });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('INDEX_UNAVAILABLE');
      expect(res.json().error.message).not.toContain(tmp);
      expect(res.json().error.message).toContain('index:build');
      await broken.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('sends CORS headers for the Vite dev origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/search?q=alic',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});

describe('GET /api/documents/:corpus/*', () => {
  it('returns full document detail without query diagnostics when no q is given', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/static-v1/pride-prejudice-01',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.corpus).toBe('static-v1');
    expect(body.id).toBe('pride-prejudice-01');
    expect(body.title).toContain('Pride and Prejudice');
    expect(body.source).toBe('static-v1');
    expect(typeof body.text).toBe('string');
    expect(body.textTruncated).toBe(false);
    expect(body.pagerank).toBeNull(); // no citation graph for static-v1
    expect(body.matchedTerms).toBeNull();
    expect(body.phrases).toBeNull();
  });

  it('reports matched terms for a document against the query', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/static-v1/alice-01?q=alic+wonderland',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe('alice-01');
    expect(body.title).toContain('Alice');
    expect(Array.isArray(body.matchedTerms)).toBe(true);
    expect(body.matchedTerms.some((t: { term: string }) => t.term === 'alic')).toBe(true);
    for (const t of body.matchedTerms) {
      expect(t.tf).toBeGreaterThan(0);
      expect(t.df).toBeGreaterThan(0);
    }
    expect(body.phrases).toEqual([]); // unquoted query => no phrase leaves
  });

  it('reports quoted-phrase presence for a document', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/static-v1/alice-01?q=%22blue%20caterpillar%22',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.phrases)).toBe(true);
    expect(body.phrases).toHaveLength(1);
    expect(body.phrases[0].terms.length).toBeGreaterThan(1);
    expect(typeof body.phrases[0].matched).toBe('boolean');
  });

  it('404s unknown document ids', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/static-v1/does-not-exist',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('DOC_NOT_FOUND');
  });

  it('resolves multi-segment crawled URL ids encoded and raw alike', async () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const ids = JSON.parse(
        fs.readFileSync(path.join(ROOT, 'data', 'index', 'crawled.ids.json'), 'utf8'),
      ) as string[];
      const id = ids[0]!;
      expect(id).toMatch(/^https?:\/\//);
      const encoded = await app.inject({
        method: 'GET',
        url: `/api/documents/crawled/${encodeURIComponent(id)}`,
      });
      expect(encoded.statusCode).toBe(200);
      expect(encoded.json().id).toBe(id);
      expect(encoded.json().source).toBe('crawl');
      expect(encoded.json().text).toBeNull(); // PostgreSQL not configured in tests
      const raw = await app.inject({
        method: 'GET',
        url: `/api/documents/crawled/${id}`,
      });
      expect(raw.statusCode).toBe(200);
      expect(raw.json().id).toBe(id);
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
  });
});

describe('GET /api/stats', () => {
  it('reports index stats, strategy availability, and live counters', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.corpus.name).toBe('static-v1');
    expect(body.corpus.numDocs).toBe(84);
    expect(body.corpus.vocabSize).toBe(9145);
    expect(body.corpus.avgDocLength).toBeGreaterThan(0);
    expect(body.corpus.indexBytes).toBeGreaterThan(0);
    expect(body.corpus.corpusHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.corpus.metadataStore).toBe('fixture-corpus');
    expect(body.corpora.some((c: { name: string }) => c.name === 'static-v1')).toBe(true);
    expect(body.strategies).toHaveLength(6);
    const bm25 = body.strategies.find((s: { id: string }) => s.id === 'bm25');
    expect(bm25.available).toBe(true);
    expect(bm25.label).toBe('BM25');
    const pr = body.strategies.find((s: { id: string }) => s.id === 'bm25-pr');
    expect(pr.available).toBe(false);
    expect(pr.reason).toContain('PageRank');
    expect(body.pagerank.available).toBe(false);
    expect(body.fuzzy.supported).toBe(true);
    expect(body.fuzzy.defaults.maxEdits).toBe(1);
    expect(body.search.total).toBeGreaterThanOrEqual(1); // earlier tests ran
    expect(body.search.recent.avgMs).toBeGreaterThanOrEqual(0);
    expect(typeof body.uptimeMs).toBe('number');
  });

  it('loads PageRank from the committed scifact citation graph on demand', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stats?corpus=scifact' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.corpus.name).toBe('scifact');
    expect(body.corpus.numDocs).toBe(5183);
    expect(body.pagerank.available).toBe(true);
    expect(body.pagerank.converged).toBe(true);
    expect(body.pagerank.nodes).toBeGreaterThan(0);
    expect(body.pagerank.source).toBe('citation-graph:scifact');
    const pr = body.strategies.find((s: { id: string }) => s.id === 'bm25-pr');
    expect(pr.available).toBe(true);
  });

  it('includes the crawl manifest summary', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stats?corpus=crawled' });
    expect(res.statusCode).toBe(200);
    const crawl = res.json().crawl;
    expect(crawl).not.toBeNull();
    expect(crawl.documents).toBe(78);
    expect(crawl.indexable).toBe(77);
    expect(crawl.vocabSize).toBe(4151);
    expect(crawl.corpusHash).toMatch(/^4e5bf3b0/);
  });
});

describe('GET /api/config', () => {
  it('describes the runtime for the frontend', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.defaultCorpus).toBe('static-v1');
    expect(body.defaultStrategy).toBe('bm25');
    expect(body.maxK).toBe(50);
    expect(body.maxPage).toBe(1000);
    expect(body.implicitOperator).toBe('or');
    expect(body.strategies).toHaveLength(6);
    expect(body.strategies.map((s: { id: string }) => s.id)).toEqual([
      'boolean',
      'tfidf',
      'bm25',
      'bm25-phrase',
      'bm25-phrase-proximity',
      'bm25-pr',
    ]);
    const bm25 = body.strategies.find((s: { id: string }) => s.id === 'bm25');
    expect(bm25.label).toBe('BM25');
    expect(bm25.available).toBe(true);
    expect(typeof body.fuzzyDefaults.maxExpansionsPerQuery).toBe('number');
  });
});

describe('GET /api/benchmarks', () => {
  it('serves committed experiment artifacts without recomputing them', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/benchmarks' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.generatedAt).toBe('string');
    expect(body.note).toContain('not recomputed');
    expect(body.runs.length).toBeGreaterThanOrEqual(10);
    const bm25 = body.runs.find(
      (r: { strategy: string | null; fuzzy: boolean }) =>
        r.strategy === 'bm25-k1.2-b0.75' && r.fuzzy === false,
    );
    expect(bm25).toBeDefined();
    expect(bm25.map).toBeCloseTo(0.6436, 4);
    expect(bm25.ndcg10).toBeCloseTo(0.687552, 5);
    expect(typeof bm25.timestamp).toBe('string');
    expect(typeof bm25.gitSha).toBe('string');

    expect(body.fuzzyBenches.length).toBe(2);
    const k1 = body.fuzzyBenches.find((b: { maxEdits: number | null }) => b.maxEdits === 1);
    const k2 = body.fuzzyBenches.find((b: { maxEdits: number | null }) => b.maxEdits === 2);
    expect(k1).toBeDefined();
    expect(k2).toBeDefined();
    expect(k1.arms.clean.map).toBeCloseTo(0.6436, 4);
    expect(k1.arms.typo_exact.map).toBeCloseTo(0.5665, 4);
    expect(k1.arms.typo_fuzzy.map).toBeCloseTo(0.6386, 4);
    expect(k2.arms.typo_fuzzy.map).toBeCloseTo(0.6157, 4);

    expect(body.queryBenches.length).toBeGreaterThanOrEqual(4);
    expect(body.queryBenches[0].stages.length).toBeGreaterThan(0);
    expect(body.queryBenches[0].queries).toBeGreaterThan(0);

    expect(body.pagerankRuns.length).toBeGreaterThanOrEqual(1);
    const pr = body.pagerankRuns[0];
    expect(pr.convergence.iterations).toBe(52);
    expect(pr.convergence.converged).toBe(true);
    expect(pr.graph.nodes).toBe(77);
    expect(pr.sum).toBeCloseTo(1, 6);
    expect(pr.top[0].value).toBeGreaterThan(0);
  });
});
