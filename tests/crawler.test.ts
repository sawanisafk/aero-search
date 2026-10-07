import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Crawler, type CrawlerConfig } from '../src/crawler/crawler.js';
import { HttpFetcher } from '../src/crawler/fetcher.js';
import { startFixtureServer, USER_AGENT, type FixtureServer } from './helpers/fixture-server.js';
import { InMemoryCrawlStore } from './helpers/in-memory-store.js';

interface VirtualClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  sleeps: number[];
}

function virtualClock(): VirtualClock {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

let fixture: FixtureServer;

function makeConfig(overrides: Partial<CrawlerConfig> = {}): CrawlerConfig {
  return {
    seeds: [`${fixture.base}/`],
    allowlist: ['127.0.0.1'],
    maxPages: 50,
    maxDepth: 1,
    delayMs: 30,
    userAgent: USER_AGENT,
    respectRobots: true,
    ...overrides,
  };
}

function makeCrawler(overrides: Partial<CrawlerConfig> = {}) {
  const clock = virtualClock();
  const store = new InMemoryCrawlStore();
  const fetcher = new HttpFetcher({ userAgent: USER_AGENT, maxBytes: 4_096 });
  const crawler = new Crawler(makeConfig(overrides), { fetcher, store, now: clock.now, sleep: clock.sleep });
  return { crawler, store, clock };
}

beforeAll(async () => {
  fixture = await startFixtureServer();
});

afterAll(async () => {
  await fixture.close();
});

describe('Crawler against a fixture site', () => {
  it('crawls the fixture site honoring robots, budgets, allowlist and dedupe', async () => {
    fixture.hits.length = 0;
    const { crawler, store, clock } = makeCrawler();
    const report = await crawler.run();

    // Budgets and traversal
    expect(report.pagesFetched).toBe(7); // /, page-a, page-b, plain, redirect, missing, big
    expect(report.newUrls).toBe(8); // seed + 7 unique children

    // robots.txt: fetched once for the host, /blocked never requested
    expect(fixture.hits.filter((h) => h === '/robots.txt')).toHaveLength(1);
    expect(fixture.hits).not.toContain('/blocked');
    expect(report.robotsSkipped).toBe(1);

    // Outcomes
    expect(report.stored).toBe(2); // '/', page-a (content owner)
    expect(report.duplicates).toBe(2); // page-b (same body), redirect (lands on page-a)
    expect(report.contentTypeSkipped).toBe(1); // /plain.txt
    expect(report.failed).toBe(2); // 404 + oversize
    expect(report.depthDropped).toBe(3); // page-c from page-a, page-b, redirect (depth 2 > 1)
    expect(report.offAllowlistDropped).toBe(1); // outside.invalid

    // Persisted frontier state
    expect(await store.counts()).toEqual({ pending: 0, fetched: 4, failed: 2, skipped: 2 });
    const redirectRow = await store.get(`${fixture.base}/redirect`);
    expect(redirectRow?.redirectChain).toEqual([`${fixture.base}/redirect`, `${fixture.base}/page-a`]);
    const homeRow = await store.get(`${fixture.base}/`);
    expect(homeRow?.redirectChain).toEqual([]);
    expect(homeRow?.status).toBe('fetched');

    // Documents + duplicate detection
    expect(await store.count()).toBe(4);
    expect(await store.countIndexable()).toBe(2);
    const dup = await store.getByUrl(`${fixture.base}/page-b`);
    expect(dup?.duplicateOf).toBe(`${fixture.base}/page-a`);

    // Link graph: external and fragment links kept as edges; children recorded
    const stats = await store.stats();
    expect(stats).toEqual({ edgeCount: 13, sourceCount: 4, targetCount: 10 });
    const edges = await store.edges();
    expect(edges.some((e) => e.toUrl === 'http://outside.invalid/x')).toBe(true);
    expect(edges.some((e) => e.fromUrl === `${fixture.base}/` && e.toUrl === `${fixture.base}/`)).toBe(true);
    expect(edges.some((e) => e.fromUrl === `${fixture.base}/redirect` && e.toUrl === `${fixture.base}/page-c`)).toBe(true);

    // Events are logged data (ARCHITECTURE §7)
    const types = report.events.map((e) => e.type);
    expect(types).toContain('seed');
    expect(types).toContain('robots-fetched');
    expect(types).toContain('robots-skipped');
    expect(types).toContain('duplicate');
    expect(types).toContain('content-skipped');
    expect(types).toContain('failed');

    // Deterministic virtual-clock politeness: 30ms gap after robots and between
    // same-host fetches, never overlapping.
    expect(clock.sleeps).toEqual(Array(7).fill(30));
    expect(report.durationMs).toBe(210);
  });

  it('stops fetching at maxPages but keeps already-collected state', async () => {
    const { crawler, store } = makeCrawler({ maxPages: 2, delayMs: 0 });
    const report = await crawler.run();
    expect(report.pagesFetched).toBe(2); // '/' and page-a only
    expect(await store.count()).toBe(2);
    expect((await store.counts()).pending).toBe(6); // remaining depth-1 queue unprocessed
  });

  it('rejects seeds outside the allowlist without fetching anything', async () => {
    fixture.hits.length = 0;
    const { crawler, store } = makeCrawler({
      seeds: ['javascript:void(0)', 'https://outside.invalid/x'],
    });
    const report = await crawler.run();
    expect(report.pagesFetched).toBe(0);
    expect(report.events.filter((e) => e.type === 'seed-skipped')).toHaveLength(2);
    expect(fixture.hits).toHaveLength(0);
    expect(await store.count()).toBe(0);
  });

  it('fails fast on missing allowlist / seeds', () => {
    const deps = { fetcher: new HttpFetcher({ userAgent: USER_AGENT }), store: new InMemoryCrawlStore() };
    expect(() => new Crawler(makeConfig({ allowlist: [] }), deps)).toThrow(/allowlist/);
    expect(() => new Crawler(makeConfig({ seeds: [] }), deps)).toThrow(/seed/);
  });
});
