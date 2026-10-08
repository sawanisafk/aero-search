/**
 * Rebuilds the search index from the crawled PostgreSQL corpus and writes a
 * committed provenance manifest:
 *
 *   npx tsx scripts/build-crawl-index.ts [--name crawled]
 *
 * Outputs:
 *   data/index/<name>.aidx            segment (gitignored, rebuildable)
 *   data/index/<name>.ids.json        docId -> corpus id (normalized URL)
 *   data/eval/<name>.manifest.json    counts + config hash + git SHA (committed)
 *   data/eval/<name>.graph.json       full link-graph export (committed)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildCrawlIndex } from './lib/build-crawl-index.js';
import { getGitInfo } from './lib/dataset.js';
import { startDatabase } from './lib/embedded-pg.js';
import { runMigrations } from '../src/storage/postgres/migrate.js';
import { createPool } from '../src/storage/postgres/pool.js';
import { PostgresStore } from '../src/storage/postgres/store.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return undefined;
}

function configHash(): string | null {
  const file = path.join(process.cwd(), 'configs', 'crawl.json');
  if (!fs.existsSync(file)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main(): Promise<void> {
  const name = argValue('--name') ?? 'crawled';
  const managed = await startDatabase();
  const pool = createPool(managed.url);
  try {
    await runMigrations(pool);
    const store = new PostgresStore(pool);
    const t0 = performance.now();
    const { manifest, bytes, segmentPath, graphPath } = await buildCrawlIndex({
      store,
      outDir: path.join(process.cwd(), 'data', 'index'),
      manifestPath: path.join(process.cwd(), 'data', 'eval', `${name}.manifest.json`),
      git: getGitInfo(),
      configSha256: configHash(),
      name,
    });
    const elapsed = performance.now() - t0;

    console.log(`[index] ${name} (from PostgreSQL)`);
    console.log(`  documents    ${manifest.counts.documents} total, ${manifest.counts.indexable} indexable, ${manifest.counts.duplicates} duplicates`);
    console.log(`  urls         ${JSON.stringify(manifest.counts.urls)}`);
    console.log(`  link graph   ${manifest.counts.links.edgeCount} edges`);
    console.log(`  docs         ${manifest.index.numDocs}`);
    console.log(`  vocab        ${manifest.index.vocabSize} terms, ${manifest.index.numPostings} postings`);
    console.log(`  avgdl        ${manifest.index.avgDocLength.toFixed(1)} tokens`);
    console.log(`  corpusHash   ${manifest.index.corpusHash}`);
    console.log(`  segment      ${segmentPath} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`  manifest     data/eval/${name}.manifest.json`);
    console.log(`  link graph   ${graphPath} (${manifest.counts.links.edgeCount} edges)`);
    console.log(`  built in     ${elapsed.toFixed(0)} ms`);
  } finally {
    await pool.end();
    await managed.stop();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
