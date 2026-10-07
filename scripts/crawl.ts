/**
 * Controlled crawl CLI (ADR-006): committed config → PostgreSQL (documents,
 * frontier state, link graph), resumable across runs.
 *
 *   npx tsx scripts/crawl.ts --config configs/crawl.json
 *   npx tsx scripts/crawl.ts --config configs/crawl.json --resume
 *
 * DATABASE_URL is honored when reachable (compose / system PostgreSQL);
 * otherwise the embedded cluster under data/pg/ is used (ADR-011).
 */

import fs from 'node:fs';
import path from 'node:path';
import { Crawler, type CrawlerConfig } from '../src/crawler/crawler.js';
import { HttpFetcher } from '../src/crawler/fetcher.js';
import { runMigrations } from '../src/storage/postgres/migrate.js';
import { createPool } from '../src/storage/postgres/pool.js';
import { PostgresStore } from '../src/storage/postgres/store.js';
import { startDatabase } from './lib/embedded-pg.js';

interface CrawlConfigFile {
  seeds: string[];
  allowlist: string[];
  maxPages: number;
  maxDepth: number;
  delayMs: number;
  userAgent?: string;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return undefined;
}

function loadConfig(file: string): CrawlerConfig {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as CrawlConfigFile;
  for (const key of ['seeds', 'allowlist', 'maxPages', 'maxDepth', 'delayMs'] as const) {
    if (parsed[key] === undefined) throw new Error(`${file}: missing "${key}"`);
  }
  if (!Array.isArray(parsed.seeds) || !Array.isArray(parsed.allowlist)) {
    throw new Error(`${file}: seeds and allowlist must be arrays`);
  }
  return {
    seeds: parsed.seeds,
    allowlist: parsed.allowlist,
    maxPages: parsed.maxPages,
    maxDepth: parsed.maxDepth,
    delayMs: parsed.delayMs,
    userAgent: parsed.userAgent ?? 'AeroSearchBot/0.1 (university final-year research project)',
    respectRobots: true,
  };
}

async function main(): Promise<void> {
  const configPath = argValue('--config') ?? path.join('configs', 'crawl.json');
  const resume = process.argv.includes('--resume');
  const config = loadConfig(configPath);

  const managed = await startDatabase();
  const pool = createPool(managed.url);
  try {
    await runMigrations(pool);
    const store = new PostgresStore(pool);
    const fetcher = new HttpFetcher({ userAgent: config.userAgent ?? 'AeroSearchBot/0.1' });

    console.log(`[crawl] config  ${configPath}`);
    console.log(`[crawl] db      ${managed.embedded ? 'embedded' : 'external'} ${resume ? '(resume)' : ''}`);
    console.log(`[crawl] seeds   ${config.seeds.length}, allowlist: ${config.allowlist.join(', ')}`);
    console.log(`[crawl] budget  maxPages=${config.maxPages} maxDepth=${config.maxDepth} delay=${config.delayMs}ms`);

    const crawler = new Crawler(config, {
      fetcher,
      store,
      onEvent: (e) => {
        const detail = e.detail !== undefined ? ` (${e.detail})` : '';
        const status = e.status !== undefined ? ` [${e.status}]` : '';
        console.log(`  [${e.type}] ${e.url}${status}${detail}`);
      },
    });
    const report = await crawler.run({ resume });

    console.log('[crawl] report');
    console.log(`  pagesFetched   ${report.pagesFetched}`);
    console.log(`  stored         ${report.stored}`);
    console.log(`  duplicates     ${report.duplicates}`);
    console.log(`  robotsSkipped  ${report.robotsSkipped}`);
    console.log(`  contentSkipped ${report.contentTypeSkipped}`);
    console.log(`  failed         ${report.failed}`);
    console.log(`  newUrls        ${report.newUrls}`);
    console.log(`  depthDropped   ${report.depthDropped}`);
    console.log(`  offAllowlist   ${report.offAllowlistDropped}`);
    console.log(`  duration       ${report.durationMs} ms`);

    const counts = await store.counts();
    const docCount = await store.count();
    const indexable = await store.countIndexable();
    const stats = await store.stats();
    console.log('[crawl] database state');
    console.log(`  urls           ${JSON.stringify(counts)}`);
    console.log(`  documents      ${docCount} (${indexable} indexable)`);
    console.log(`  link graph     ${stats.edgeCount} edges, ${stats.sourceCount} sources, ${stats.targetCount} targets`);
  } finally {
    await pool.end();
    await managed.stop();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
