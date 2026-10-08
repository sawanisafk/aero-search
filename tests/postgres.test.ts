import fs from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDatabase, type ManagedDatabase } from '../scripts/lib/embedded-pg.js';
import { createPool } from '../src/storage/postgres/pool.js';
import { runMigrations } from '../src/storage/postgres/migrate.js';
import { PostgresStore } from '../src/storage/postgres/store.js';
import type { EnqueuedUrl, PageRankRun, StoredDocument, StoredLink } from '../src/storage/repositories.js';

const DB_DIR = path.join(process.cwd(), 'data', 'pgtest');

let managed: ManagedDatabase;
let pool: Pool;
let store: PostgresStore;
let firstMigration: string[];
let secondMigration: string[];

function seedUrl(n: number, depth = 0): EnqueuedUrl {
  const url = `https://example.org/page-${n}`;
  return { url, originalUrl: `${url}/?ref=seed`, host: 'example.org', depth, discoveredFrom: null };
}

function sampleDoc(url: string, overrides: Partial<StoredDocument> = {}): StoredDocument {
  return {
    url,
    title: 'Sample',
    headings: [{ level: 'h1', text: 'Sample' }],
    meta: { description: 'a page' },
    text: 'alpha beta gamma delta alpha',
    wordCount: 6,
    uniqueTerms: 4,
    contentHash: 'hash-default',
    canonicalUrl: null,
    bytes: 1024,
    httpStatus: 200,
    contentType: 'text/html; charset=utf-8',
    fetchedAt: new Date('2026-10-07T12:00:00Z'),
    duplicateOf: null,
    ...overrides,
  };
}

beforeAll(async () => {
  managed = await startDatabase({
    databaseDir: DB_DIR,
    port: 5433,
    database: 'aero_search_test',
    fresh: true,
  });
  pool = createPool(managed.url, 3);
  store = new PostgresStore(pool);
  firstMigration = await runMigrations(pool);
  secondMigration = await runMigrations(pool);
}, 60_000);

afterAll(async () => {
  await pool.end();
  await managed.stop();
  fs.rmSync(DB_DIR, { recursive: true, force: true });
}, 30_000);

describe('migrations', () => {
  it('applies each migration exactly once', () => {
    expect(firstMigration).toEqual(['001_init.sql', '002_pagerank.sql']);
    expect(secondMigration).toEqual([]);
  });

  it('creates the crawl and pagerank tables', async () => {
    const res = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    expect(res.rows.map((r) => r.tablename)).toEqual([
      'documents', 'links', 'pagerank_runs', 'pagerank_scores', 'schema_migrations', 'urls',
    ]);
  });
});

describe('frontier repository', () => {
  it('enqueues idempotently and counts by status', async () => {
    expect(await store.enqueue([seedUrl(1), seedUrl(2)])).toBe(2);
    expect(await store.enqueue([seedUrl(2), seedUrl(3)])).toBe(1);
    expect(await store.counts()).toEqual({ pending: 3, fetched: 0, failed: 0, skipped: 0 });
  });

  it('transitions status and records fetch metadata', async () => {
    const s = seedUrl(1);
    await store.markFetched(s.url, {
      httpStatus: 200,
      contentType: 'text/html',
      bytes: 4096,
      redirectChain: ['https://example.org/page-1'],
    });
    const state = await store.get(s.url);
    expect(state).not.toBeNull();
    expect(state?.status).toBe('fetched');
    expect(state?.httpStatus).toBe(200);
    expect(state?.bytes).toBe(4096);
    expect(state?.redirectChain).toEqual(['https://example.org/page-1']);
    expect(state?.fetchedAt).toBeInstanceOf(Date);

    await store.markFailed(seedUrl(2).url, 'connection reset', 503);
    expect((await store.get(seedUrl(2).url))?.status).toBe('failed');
    await store.markSkipped(seedUrl(3).url, 'robots disallow');
    expect((await store.get(seedUrl(3).url))?.status).toBe('skipped');
    expect(await store.counts()).toEqual({ pending: 0, fetched: 1, failed: 1, skipped: 1 });
  });

  it('returns null for unknown urls', async () => {
    expect(await store.get('https://example.org/nope')).toBeNull();
  });

  it('resumes pending rows in BFS order after a crash', async () => {
    await store.enqueue([seedUrl(10, 2), seedUrl(11, 0), seedUrl(12, 1), seedUrl(13, 2)]);
    const pending = await store.loadPending(10);
    expect(pending.map((p) => p.depth)).toEqual([0, 1, 2, 2]);
    expect(pending[0]?.url).toBe('https://example.org/page-11');
  });

  it('loads every row regardless of status (resume seen-set)', async () => {
    const all = await store.loadAll();
    expect(all).toHaveLength(7);
    expect(new Set(all.map((u) => u.status))).toEqual(
      new Set(['pending', 'fetched', 'failed', 'skipped']),
    );
  });
});

describe('document repository', () => {
  it('upserts documents and detects exact content duplicates', async () => {
    await store.enqueue([seedUrl(20), seedUrl(21)]);

    const first = await store.upsert(sampleDoc('https://example.org/page-20', {
      contentHash: 'hash-unique',
    }));
    expect(first).toEqual({ url: 'https://example.org/page-20', inserted: true, duplicateOf: null });

    const dup = await store.upsert(sampleDoc('https://example.org/page-21', {
      contentHash: 'hash-unique',
    }));
    expect(dup.inserted).toBe(true);
    expect(dup.duplicateOf).toBe('https://example.org/page-20');

    const original = await store.findByContentHash('hash-unique');
    expect(original?.url).toBe('https://example.org/page-20');

    expect(await store.count()).toBe(2);
    expect(await store.countIndexable()).toBe(1);
    const indexable = await store.listIndexable(10, 0);
    expect(indexable.map((d) => d.url)).toEqual(['https://example.org/page-20']);
  });

  it('keeps duplicate status stable on re-upsert of the same content', async () => {
    const again = await store.upsert(sampleDoc('https://example.org/page-21', {
      contentHash: 'hash-unique',
    }));
    expect(again.inserted).toBe(false);
    expect(again.duplicateOf).toBe('https://example.org/page-20');
  });

  it('reads documents back with JSONB fields parsed', async () => {
    const doc = await store.getByUrl('https://example.org/page-20');
    expect(doc?.headings).toEqual([{ level: 'h1', text: 'Sample' }]);
    expect(doc?.meta).toEqual({ description: 'a page' });
    expect(doc?.wordCount).toBe(6);
    expect(doc?.httpStatus).toBe(200);
  });
});

describe('link repository', () => {
  it('inserts edges idempotently and exposes graph stats', async () => {
    const edges: StoredLink[] = [
      { fromUrl: 'https://example.org/page-20', toUrl: 'https://example.org/page-21', anchor: 'next', position: 0 },
      { fromUrl: 'https://example.org/page-20', toUrl: 'https://elsewhere.net/x', anchor: 'away', position: 1 },
    ];
    expect(await store.insert(edges)).toBe(2);
    expect(await store.insert(edges)).toBe(0);

    const stats = await store.stats();
    expect(stats).toEqual({ edgeCount: 2, sourceCount: 1, targetCount: 2 });

    const all = await store.edges();
    expect(all.map((e) => [e.fromUrl, e.toUrl, e.position])).toEqual([
      ['https://example.org/page-20', 'https://example.org/page-21', 0],
      ['https://example.org/page-20', 'https://elsewhere.net/x', 1],
    ]);
  });

  it('cascades link deletion when a source document is deleted', async () => {
    await pool.query(`DELETE FROM documents WHERE url = 'https://example.org/page-20'`);
    expect((await store.stats()).edgeCount).toBe(0);
  });
});

describe('pagerank repository', () => {
  const run = (over: Partial<PageRankRun> = {}): PageRankRun => ({
    damping: 0.85,
    tolerance: 1e-6,
    maxIterations: 100,
    iterations: 37,
    converged: true,
    residual: 4.2e-7,
    nodeCount: 3,
    edgeCount: 2,
    graphHash: 'a'.repeat(64),
    gitSha: '1fd7f42',
    ...over,
  });

  it('returns null when nothing has been computed', async () => {
    // run order matters: this suite owns the only saves in the test database
    expect(await store.loadLatestPageRank()).toBeNull();
  });

  it('persists run metadata and scores atomically, reloads in url order', async () => {
    const scores = new Map([
      ['https://example.org/c', 0.5],
      ['https://example.org/a', 0.25],
      ['https://example.org/b', 0.25],
    ]);
    const runId = await store.savePageRank(run(), scores);
    expect(runId).toBeGreaterThan(0);

    const loaded = await store.loadLatestPageRank();
    expect(loaded).not.toBeNull();
    expect(loaded?.runId).toBe(runId);
    expect(loaded?.run).toEqual(run());
    expect([...loaded!.scores.keys()]).toEqual([
      'https://example.org/a',
      'https://example.org/b',
      'https://example.org/c',
    ]);
    expect(loaded?.scores.get('https://example.org/c')).toBe(0.5);
  });

  it('a newer run supersedes the previous one', async () => {
    const second = await store.savePageRank(
      run({ iterations: 12, graphHash: 'b'.repeat(64), gitSha: null }),
      new Map([['https://example.org/a', 1]]),
    );
    const loaded = await store.loadLatestPageRank();
    expect(loaded?.runId).toBe(second);
    expect(loaded?.run.iterations).toBe(12);
    expect(loaded?.run.gitSha).toBeNull();
    expect(loaded?.scores.size).toBe(1);
  });

  it('handles score sets larger than one insert chunk', async () => {
    const big = new Map<string, number>();
    for (let i = 0; i < 1200; i++) big.set(`https://example.org/doc-${i}`, 1 / 1200);
    const id = await store.savePageRank(run({ nodeCount: 1200, edgeCount: 0 }), big);
    const loaded = await store.loadLatestPageRank();
    expect(loaded?.runId).toBe(id);
    expect(loaded?.scores.size).toBe(1200);
    expect([...loaded!.scores.keys()][0]).toBe('https://example.org/doc-0');
  });
});
