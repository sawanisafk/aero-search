/**
 * PageRank over the crawled link graph (ARCHITECTURE §6, M4-A):
 *
 *   npx tsx scripts/build-pagerank.ts [--d 0.85] [--tolerance 1e-6] [--max 100]
 *
 * Graph source (offline path — PostgreSQL is allowed here, ADR-003):
 *   nodes = content-owning documents (duplicate_of IS NULL, url order);
 *   edges = links rows with BOTH endpoints in the node set (targets that were
 *   never crawled as owners — pending/failed/off-allowlist — are dropped and
 *   counted); dangling nodes are redistributed per the formula.
 *
 * Outputs:
 *   pagerank_runs + pagerank_scores rows (via PageRankRepository)
 *   benchmarks/results/<timestamp>-pagerank.json  (committed evidence)
 */

import fs from 'node:fs';
import path from 'node:path';
import { pageRank, DEFAULT_DAMPING, DEFAULT_MAX_ITERATIONS, DEFAULT_TOLERANCE } from '../src/core/link/pagerank.js';
import { startDatabase } from './lib/embedded-pg.js';
import { runMigrations } from '../src/storage/postgres/migrate.js';
import { createPool } from '../src/storage/postgres/pool.js';
import { PostgresStore } from '../src/storage/postgres/store.js';
import { getGitInfo, sha256, writeJson } from './lib/dataset.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return undefined;
}

function readCrawlCorpusHash(): string | null {
  const file = path.join(process.cwd(), 'data', 'eval', 'crawled.manifest.json');
  if (!fs.existsSync(file)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8')) as { index?: { corpusHash?: string } };
    return m.index?.corpusHash ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const damping = Number(argValue('--d') ?? DEFAULT_DAMPING);
  const tolerance = Number(argValue('--tolerance') ?? DEFAULT_TOLERANCE);
  const maxIterations = Number(argValue('--max') ?? DEFAULT_MAX_ITERATIONS);

  const managed = await startDatabase();
  const pool = createPool(managed.url);
  try {
    await runMigrations(pool);
    const store = new PostgresStore(pool);

    // Nodes: indexable documents in deterministic url order → stable ids.
    const urls: string[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await store.listIndexable(500, offset);
      if (page.length === 0) break;
      urls.push(...page.map((d) => d.url));
      if (page.length < 500) break;
    }
    const nodeId = new Map(urls.map((u, i) => [u, i]));

    // Edges: keep pairs whose endpoints are both nodes; count what was dropped.
    const raw = await store.edges();
    const pairSet = new Set<string>();
    let dropped = 0;
    for (const e of raw) {
      const u = nodeId.get(e.fromUrl);
      const v = nodeId.get(e.toUrl);
      if (u === undefined || v === undefined) {
        dropped++;
        continue;
      }
      pairSet.add(`${u},${v}`);
    }
    const pairs: [number, number][] = [...pairSet].map((p) => {
      const [u, v] = p.split(',');
      return [Number(u), Number(v)];
    });
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    const graphHash = sha256(`${urls.length}\n${pairs.map(([u, v]) => `${u},${v}`).join('\n')}\n`);
    const dangling = new Set(urls.map((_, i) => i));
    for (const [u] of pairs) dangling.delete(u);

    const trace: { iteration: number; residual: number }[] = [];
    const t0 = performance.now();
    const result = pageRank(urls.length, pairs, {
      dampingFactor: damping,
      tolerance,
      maxIterations,
      onIteration: (info) => trace.push(info),
    });
    const wallMs = performance.now() - t0;

    let sum = 0;
    for (const s of result.scores) sum += s;

    const top = urls
      .map((url, i) => ({ url, value: result.scores[i]! }))
      .sort((a, b) => b.value - a.value || (a.url < b.url ? -1 : 1))
      .slice(0, 10);

    const runId = await store.savePageRank(
      {
        damping, tolerance, maxIterations,
        iterations: result.iterations,
        converged: result.converged,
        residual: result.residual,
        nodeCount: urls.length,
        edgeCount: pairs.length,
        graphHash,
        gitSha: getGitInfo().sha,
      },
      new Map(urls.map((u, i) => [u, result.scores[i]!])),
    );

    const timestamp = new Date().toISOString();
    const artifact = {
      kind: 'pagerank',
      timestamp,
      git: getGitInfo(),
      config: {
        algorithm: 'power-iteration',
        dampingFactor: damping,
        tolerance,
        maxIterations,
        node_set: 'indexable documents (duplicate_of IS NULL, url order)',
        edge_policy: 'both endpoints in node set; duplicates collapsed; self-loops kept',
        source: { crawl_config: 'configs/crawl.json', migrations: ['001_init.sql', '002_pagerank.sql'] },
      },
      corpus: { hash: readCrawlCorpusHash() },
      graph: {
        nodes: urls.length,
        uniqueEdges: pairs.length,
        rawLinkRows: raw.length,
        droppedEdges: dropped,
        danglingNodes: dangling.size,
        graphHash,
      },
      convergence: {
        iterations: result.iterations,
        converged: result.converged,
        residual: result.residual,
        wallMs: Number(wallMs.toFixed(3)),
        trace,
      },
      scores: { sum: Number(sum.toFixed(12)), top },
      runId,
    };
    const stamp = timestamp.replace(/[:.]/g, '-');
    const outPath = path.join('benchmarks', 'results', `${stamp}-pagerank.json`);
    writeJson(outPath, artifact);

    console.log(`[pagerank] run ${runId}`);
    console.log(`  graph      ${urls.length} nodes, ${pairs.length} unique edges (${raw.length} rows, ${dropped} dropped, ${dangling.size} dangling)`);
    console.log(`  graphHash  ${graphHash}`);
    console.log(`  converge   ${result.iterations} iterations, residual ${result.residual.toExponential(3)}, ${result.converged ? 'CONVERGED' : 'NOT CONVERGED'} in ${wallMs.toFixed(1)} ms`);
    console.log(`  score sum  ${sum}`);
    console.log(`  top        `);
    for (const t of top.slice(0, 5)) {
      console.log(`    ${t.value.toFixed(6)}  ${t.url}`);
    }
    console.log(`  artifact   ${outPath}`);
  } finally {
    await pool.end();
    await managed.stop();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
