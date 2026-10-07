import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Crawler, type CrawlerConfig } from '../src/crawler/crawler.js';
import { HttpFetcher } from '../src/crawler/fetcher.js';
import { InMemoryCrawlStore } from './helpers/in-memory-store.js';

const USER_AGENT = 'AeroSearchBot-Test/0.1';

const HOME = `<!doctype html><html><head><title>Home</title></head><body>
  <h1>Fixture home</h1><p>Welcome to the fixture site used by crawler tests.</p>
  <a href="/page-a">A</a>
  <a href="/page-a#again">A again</a>
  <a href="/page-b">B</a>
  <a href="/blocked">Blocked</a>
  <a href="/plain.txt">Plain</a>
  <a href="/redirect">Redirect</a>
  <a href="/missing">Missing</a>
  <a href="/big">Big</a>
  <a href="http://outside.invalid/x">External</a>
  <a href="#self">Self</a>
</body></html>`;

const SAME_BODY =
  '<h1>Same</h1><p>Identical body text for duplicate detection across two urls.</p>';

const PAGE_A = `<!doctype html><html><head><title>Page A</title></head><body>${SAME_BODY}
  <a href="/page-c">Deeper</a>
</body></html>`;

const PAGE_B = `<!doctype html><html><head><title>Page B (other title)</title></head><body>${SAME_BODY}
  <a href="/page-c">Deeper</a>
</body></html>`;

const ROBOTS = 'User-agent: *\nDisallow: /blocked\n';

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

let server: http.Server;
let base: string;
const hits: string[] = [];

function route(url: string, res: http.ServerResponse): void {
  hits.push(url);
  const send = (status: number, type: string, body: string): void => {
    res.writeHead(status, { 'content-type': type, 'content-length': String(Buffer.byteLength(body)) });
    res.end(body);
  };
  switch (url) {
    case '/':
      return send(200, 'text/html; charset=utf-8', HOME);
    case '/robots.txt':
      return send(200, 'text/plain; charset=utf-8', ROBOTS);
    case '/page-a':
      return send(200, 'text/html; charset=utf-8', PAGE_A);
    case '/page-b':
      return send(200, 'text/html; charset=utf-8', PAGE_B);
    case '/redirect':
      res.writeHead(302, { location: '/page-a' });
      res.end();
      return;
    case '/plain.txt':
      return send(200, 'text/plain; charset=utf-8', 'plain text here');
    case '/blocked':
      return send(200, 'text/html; charset=utf-8', '<html><body>should never be fetched</body></html>');
    case '/big': {
      const body = Buffer.alloc(100_000, 0x61); // content-length exceeds fetcher cap
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    case '/missing':
    default:
      send(404, 'text/html; charset=utf-8', '<html><body>nope</body></html>');
      return;
  }
}

function makeConfig(overrides: Partial<CrawlerConfig> = {}): CrawlerConfig {
  return {
    seeds: [`${base}/`],
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
  server = http.createServer((req, res) => route(req.url ?? '/', res));
  server.on('error', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('Crawler against a fixture site', () => {
  it('crawls the fixture site honoring robots, budgets, allowlist and dedupe', async () => {
    hits.length = 0;
    const { crawler, store, clock } = makeCrawler();
    const report = await crawler.run();

    // Budgets and traversal
    expect(report.pagesFetched).toBe(7); // /, page-a, page-b, plain, redirect, missing, big
    expect(report.newUrls).toBe(8); // seed + 7 unique children

    // robots.txt: fetched once for the host, /blocked never requested
    expect(hits.filter((h) => h === '/robots.txt')).toHaveLength(1);
    expect(hits).not.toContain('/blocked');
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
    const redirectRow = await store.get(`${base}/redirect`);
    expect(redirectRow?.redirectChain).toEqual([`${base}/redirect`, `${base}/page-a`]);
    const homeRow = await store.get(`${base}/`);
    expect(homeRow?.redirectChain).toEqual([]);
    expect(homeRow?.status).toBe('fetched');

    // Documents + duplicate detection
    expect(await store.count()).toBe(4);
    expect(await store.countIndexable()).toBe(2);
    const dup = await store.getByUrl(`${base}/page-b`);
    expect(dup?.duplicateOf).toBe(`${base}/page-a`);

    // Link graph: external and fragment links kept as edges; children recorded
    const stats = await store.stats();
    expect(stats).toEqual({ edgeCount: 13, sourceCount: 4, targetCount: 10 });
    const edges = await store.edges();
    expect(edges.some((e) => e.toUrl === 'http://outside.invalid/x')).toBe(true);
    expect(edges.some((e) => e.fromUrl === `${base}/` && e.toUrl === `${base}/`)).toBe(true);
    expect(edges.some((e) => e.fromUrl === `${base}/redirect` && e.toUrl === `${base}/page-c`)).toBe(true);

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
    hits.length = 0;
    const { crawler, store } = makeCrawler({
      seeds: ['javascript:void(0)', 'https://outside.invalid/x'],
    });
    const report = await crawler.run();
    expect(report.pagesFetched).toBe(0);
    expect(report.events.filter((e) => e.type === 'seed-skipped')).toHaveLength(2);
    expect(hits).toHaveLength(0);
    expect(await store.count()).toBe(0);
  });

  it('fails fast on missing allowlist / seeds', () => {
    const deps = { fetcher: new HttpFetcher({ userAgent: USER_AGENT }), store: new InMemoryCrawlStore() };
    expect(() => new Crawler(makeConfig({ allowlist: [] }), deps)).toThrow(/allowlist/);
    expect(() => new Crawler(makeConfig({ seeds: [] }), deps)).toThrow(/seed/);
  });
});
