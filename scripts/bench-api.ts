/**
 * REST API latency benchmark — measures what a browser actually pays:
 * HTTP + JSON serialization + routing + the shared retrieval pipeline,
 * over loopback. Engine-internal stage timings (benchmarks/query-benchmark)
 * stay separate; this artifact is the API-level number.
 *
 * The server is started in-process on an ephemeral port, warmed up, then
 * each route is fetched N times with performance.now() around the full
 * request/response round trip (status + body read included).
 *
 *   npm run bench:api
 *   npm run bench:api -- --iterations 50 --warmup 10
 *
 * Artifact: benchmarks/results/<timestamp>-api-benchmark.json
 *   { kind, timestamp, git, config, routes[], overall }
 */

import { buildApp } from '../src/api/app.js';
import { loadConfig } from '../src/api/config.js';
import { getGitInfo, latencyStats, writeJson } from './lib/dataset.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  const pref = `${flag}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit?.slice(pref.length);
}

interface Route {
  readonly name: string;
  readonly path: string;
}

async function main(): Promise<void> {
  const iterations = Number(argValue('--iterations') ?? '30');
  const warmup = Number(argValue('--warmup') ?? '5');
  if (!Number.isFinite(iterations) || iterations < 1) throw new Error('--iterations must be >= 1');
  if (!Number.isFinite(warmup) || warmup < 0) throw new Error('--warmup must be >= 0');

  const cfg = loadConfig();
  const app = buildApp({ config: cfg, logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  if (port === 0) throw new Error('could not determine the ephemeral port');
  const base = `http://127.0.0.1:${port}`;

  try {
    // Identify a real document id so the document route measures a hit.
    const probe = await fetch(`${base}/api/search?q=stem%20cells&k=1`);
    const probeBody = (await probe.json()) as { results?: { docId?: string }[] };
    const docId = probeBody.results?.[0]?.docId;
    if (docId === undefined) throw new Error('preflight search returned no results');

    const routes: Route[] = [
      { name: 'health', path: '/health' },
      { name: 'config', path: '/api/config' },
      { name: 'stats', path: '/api/stats' },
      { name: 'search-bm25', path: '/api/search?q=stem%20cells' },
      { name: 'search-tfidf', path: '/api/search?q=stem%20cells&strategy=tfidf' },
      { name: 'search-phrase', path: '/api/search?q=%22stem%20cell%22&strategy=bm25-phrase' },
      {
        name: 'search-fuzzy-k1',
        path: '/api/search?q=wonderlan&corpus=static-v1&fuzzy=true&fuzzyEdits=1',
      },
      { name: 'search-page2', path: '/api/search?q=stem%20cells&page=2' },
      { name: 'document', path: `/api/documents/scifact/${encodeURIComponent(docId)}` },
      { name: 'benchmarks', path: '/api/benchmarks' },
    ];

    const all: number[] = [];
    const routeRows: unknown[] = [];
    let errors = 0;

    for (const route of routes) {
      for (let i = 0; i < warmup; i++) {
        const res = await fetch(base + route.path);
        await res.text();
        if (!res.ok) throw new Error(`warmup ${route.name} -> HTTP ${res.status}`);
      }
      const samples: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const t0 = performance.now();
        const res = await fetch(base + route.path);
        await res.text();
        samples.push(performance.now() - t0);
        if (!res.ok) errors++;
      }
      all.push(...samples);
      const stats = latencyStats(samples);
      routeRows.push({
        name: route.name,
        method: 'GET',
        path: route.path,
        status: 200,
        errors,
        latency_ms: stats,
      });
      console.log(
        `  ${route.name.padEnd(18)} avg ${stats.avg.toFixed(2).padStart(7)} ms · ` +
          `median ${stats.median.toFixed(2).padStart(7)} · p95 ${stats.p95.toFixed(2).padStart(7)} · ` +
          `min ${stats.min.toFixed(2).padStart(7)} · max ${stats.max.toFixed(2).padStart(7)}`,
      );
      errors = 0;
    }

    const overall = latencyStats(all);
    const timestamp = new Date().toISOString();
    const artifact = {
      kind: 'api-latency',
      timestamp,
      git: getGitInfo(),
      config: {
        transport: 'http/1.1 loopback + JSON',
        host: '127.0.0.1',
        port,
        iterations,
        warmup,
        corpus_default: cfg.defaultCorpus,
        node: process.version,
        note: 'full round trip (status + body read); engine-internal stages are in *-query-benchmark.json',
      },
      routes: routeRows,
      overall,
    };

    const stamp = timestamp.replace(/[:.]/g, '-');
    const outPath = `benchmarks/results/${stamp}-api-benchmark.json`;
    writeJson(outPath, artifact);

    console.log(
      `  ${'OVERALL'.padEnd(18)} avg ${overall.avg.toFixed(2).padStart(7)} ms · ` +
        `median ${overall.median.toFixed(2).padStart(7)} · p95 ${overall.p95.toFixed(2).padStart(7)} · ` +
        `${overall.count} requests`,
    );
    console.log(`  artifact ${outPath}`);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
