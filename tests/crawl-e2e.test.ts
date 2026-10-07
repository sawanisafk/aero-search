import fs from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDatabase, type ManagedDatabase } from '../scripts/lib/embedded-pg.js';
import { Crawler, type CrawlerConfig } from '../src/crawler/crawler.js';
import { HttpFetcher } from '../src/crawler/fetcher.js';
import { createPool } from '../src/storage/postgres/pool.js';
import { runMigrations } from '../src/storage/postgres/migrate.js';
import { PostgresStore } from '../src/storage/postgres/store.js';
import { startFixtureServer, USER_AGENT, type FixtureServer } from './helpers/fixture-server.js';

/**
 * End-to-end: fixture site → real crawler → real PostgreSQL (embedded) →
 * resume from persisted state. Ordered scenario — the three tests form the
 * partial → resume → idempotent-re-run story of persistent crawl state.
 */

const DB_DIR = path.join(process.cwd(), 'data', 'pgtest-e2e');

let pg: ManagedDatabase;
let pool: Pool;
let store: PostgresStore;
let fixture: FixtureServer;

function makeCrawler(overrides: Partial<CrawlerConfig> = {}): Crawler {
  const config: CrawlerConfig = {
    seeds: [`${fixture.base}/`],
    allowlist: ['127.0.0.1'],
    maxPages: 50,
    maxDepth: 1,
    delayMs: 0,
    userAgent: USER_AGENT,
    respectRobots: true,
    ...overrides,
  };
  const fetcher = new HttpFetcher({ userAgent: USER_AGENT, maxBytes: 4_096 });
  return new Crawler(config, { fetcher, store });
}

beforeAll(async () => {
  fixture = await startFixtureServer();
  pg = await startDatabase({ databaseDir: DB_DIR, port: 5434, database: 'aero_crawl_e2e', fresh: true });
  pool = createPool(pg.url, 3);
  store = new PostgresStore(pool);
  await runMigrations(pool);
}, 60_000);

afterAll(async () => {
  await pool.end();
  await pg.stop();
  await fixture.close();
  fs.rmSync(DB_DIR, { recursive: true, force: true });
}, 30_000);

describe('crawl persisted in PostgreSQL (E2E)', () => {
  it('1. persists a partial crawl with honest frontier state', async () => {
    const report = await makeCrawler({ maxPages: 3 }).run();
    expect(report.pagesFetched).toBe(3); // '/', page-a, page-b
    expect(await store.counts()).toEqual({ pending: 5, fetched: 3, failed: 0, skipped: 0 });
    expect(await store.count()).toBe(3); // the three fetched docs are stored
    expect((await store.stats()).edgeCount).toBe(12); // links from the three fetched pages
  });

  it('2. resumes from PostgreSQL and finishes without refetching processed urls', async () => {
    fixture.hits.length = 0;
    const report = await makeCrawler().run({ resume: true });
    // Only the five pending urls remain: 4 attempts (blocked is robots-skipped).
    expect(report.pagesFetched).toBe(4);
    expect(fixture.hits.filter((h) => h === '/robots.txt')).toHaveLength(1); // new instance, new cache
    expect(fixture.hits).not.toContain('/'); // already-fetched home page
    expect(fixture.hits).not.toContain('/page-b');
    expect(fixture.hits).toContain('/plain.txt');

    // Same end state as a single full crawl (in-memory parity).
    expect(await store.counts()).toEqual({ pending: 0, fetched: 4, failed: 2, skipped: 2 });
    expect(await store.count()).toBe(4);
    expect(await store.countIndexable()).toBe(2);
    const dup = await store.getByUrl(`${fixture.base}/page-b`);
    expect(dup?.duplicateOf).toBe(`${fixture.base}/page-a`);
    const redirect = await store.get(`${fixture.base}/redirect`);
    expect(redirect?.redirectChain).toEqual([`${fixture.base}/redirect`, `${fixture.base}/page-a`]);
    expect(await store.stats()).toEqual({ edgeCount: 13, sourceCount: 4, targetCount: 10 });
  });

  it('3. re-running a completed crawl fetches nothing and changes nothing', async () => {
    fixture.hits.length = 0;
    const report = await makeCrawler().run({ resume: true });
    expect(report.pagesFetched).toBe(0);
    expect(fixture.hits).toHaveLength(0); // frontier empty → not even a robots.txt re-check
    expect(await store.counts()).toEqual({ pending: 0, fetched: 4, failed: 2, skipped: 2 });
    expect(await store.count()).toBe(4);
    expect(await store.stats()).toEqual({ edgeCount: 13, sourceCount: 4, targetCount: 10 });
  });
});
