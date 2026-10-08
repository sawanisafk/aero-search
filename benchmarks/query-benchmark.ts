/**
 * Query latency benchmark. Measures per-query wall time for:
 *
 *   candidates   parse + analyze + Boolean candidate retrieval (no scoring)
 *   boolean      candidates + boolean strategy (full e2e)
 *   tfidf        e2e, mode A
 *   bm25         e2e, mode B
 *   bm25-phrase  e2e, mode C (bm25 + phrase bonus)
 *   bm25-phrase-proximity e2e, mode C (+ proximity term)
 *   bm25-pr      e2e, mode D (BM25 + PageRank fusion) — when a citation
 *                graph exists for the corpus (default
 *                data/eval/<corpus>-citations.json or --linkgraph <file>;
 *                PageRank is computed once, OUTSIDE the timed loop)
 *
 * e2e = parseQuery -> analyzeQuery -> retrieveBoolean -> strategy.rank ->
 * top-k id mapping, exactly what the experiment runner executes per query.
 *
 * Queries: --queries <BEIR queries.jsonl> uses that file (e.g. scifact);
 * otherwise a deterministic template set derived from the index's top-df
 * terms (singles, AND, OR, phrase, AND-NOT) — same bytes every run.
 *
 *   npx tsx benchmarks/query-benchmark.ts --corpus static-v1
 *   npx tsx benchmarks/query-benchmark.ts --corpus scifact \
 *     --queries data/eval/scifact-queries.jsonl
 *
 * Artifact: benchmarks/results/<timestamp>-query-benchmark.json with the
 * required evidence fields ({config, git_sha, corpus_hash, timestamp}).
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseQuery } from '../src/core/query/index.js';
import { analyzeQuery, retrieveBoolean } from '../src/core/retrieval/index.js';
import { createStrategy, RANKING_STRATEGIES } from '../src/core/ranking/index.js';
import { parseQueriesJsonl } from '../src/eval/index.js';
import { getGitInfo, hashFile, latencyStats, writeJson, type LatencyStats } from '../scripts/lib/dataset.js';
import { loadIndexBundle, runQuerySet } from '../scripts/lib/retrieval-run.js';
import { loadCitationGraph, pageRankForBundle } from '../scripts/lib/pagerank-scores.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  const pref = `${flag}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit?.slice(pref.length);
}

/** Top-df terms first (ties broken by dictionary order) — fully deterministic. */
function deriveQueries(bundle: ReturnType<typeof loadIndexBundle>): Map<string, string> {
  const data = bundle.reader.raw;
  const ranked = data.terms
    .map((term, i) => ({ term, df: data.dfs[i]! }))
    .sort((a, b) => b.df - a.df || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0))
    .map((e) => e.term);
  const at = (i: number): string => ranked[Math.min(i, ranked.length - 1)]!;

  const queries = new Map<string, string>();
  let n = 1;
  const add = (text: string): void => {
    queries.set(`derived-${String(n).padStart(3, '0')}`, text);
    n++;
  };
  for (let i = 0; i < 20 && i < ranked.length; i++) add(at(i));
  for (let i = 0; i < 10; i++) add(`${at(i)} AND ${at(i + 20)}`);
  for (let i = 0; i < 10; i++) add(`${at(i)} OR ${at(i + 40)}`);
  for (let i = 0; i < 10; i++) add(`"${at(i)} ${at(i + 30)}"`);
  for (let i = 0; i < 10; i++) add(`${at(i)} AND NOT ${at(i + 50)}`);
  return queries;
}

function main(): void {
  const corpus = argValue('--corpus') ?? 'static-v1';
  const queriesFile = argValue('--queries');
  const bundle = loadIndexBundle(corpus);

  let queries: Map<string, string>;
  let querySource: string;
  if (queriesFile !== undefined) {
    queries = parseQueriesJsonl(fs.readFileSync(queriesFile, 'utf8'));
    querySource = queriesFile;
  } else {
    queries = deriveQueries(bundle);
    querySource = 'derived-top-df-templates';
  }
  const texts = [...queries.values()];

  const stages: Record<string, LatencyStats> = {};
  const parseFailures: Record<string, number> = {};

  // candidates: parse + analyze + boolean retrieval only
  {
    const samples: number[] = [];
    let failures = 0;
    for (const text of texts) {
      const t0 = performance.now();
      try {
        const parsed = parseQuery(text, { implicitOperator: 'or' });
        analyzeQuery(parsed, bundle.reader.analysis);
        retrieveBoolean(bundle.reader, parsed);
      } catch {
        failures++;
      }
      samples.push(performance.now() - t0);
    }
    stages['candidates'] = latencyStats(samples);
    parseFailures['candidates'] = failures;
    if (failures > 0) {
      console.warn(`[bench] WARNING: ${failures} unparseable queries in candidates stage`);
    }
  }

  for (const [id, strategy] of Object.entries(RANKING_STRATEGIES)) {
    const { latencyMs, parseFailures: failures } = runQuerySet(bundle, strategy, queries, 100);
    stages[id] = latencyStats(latencyMs);
    parseFailures[id] = failures.length;
    if (failures.length > 0) {
      console.warn(`[bench] WARNING: ${failures.length} parse failures in ${id} stage`);
    }
  }

  // mode D: bm25-pr, only when a citation graph is available for this corpus
  let linkGraph: Record<string, unknown> | undefined;
  const graphFileFlag = argValue('--linkgraph');
  const graphFile = graphFileFlag ?? path.join('data', 'eval', `${corpus}-citations.json`);
  if (fs.existsSync(graphFile)) {
    const graph = loadCitationGraph(graphFile);
    const prWeight = Number(argValue('--pr-weight') ?? '0.2');
    const pr = pageRankForBundle(bundle, graph); // timed OUTSIDE the loop
    if (!pr.meta.converged) {
      throw new Error(`PageRank did not converge for ${graphFile} (residual ${pr.meta.residual})`);
    }
    const strategy = createStrategy('bm25-pr', { pagerank: pr.scores, prWeight });
    const { latencyMs, parseFailures: failures } = runQuerySet(bundle, strategy, queries, 100);
    stages['bm25-pr'] = latencyStats(latencyMs);
    parseFailures['bm25-pr'] = failures.length;
    linkGraph = {
      file: graphFile,
      sha256: hashFile('sha256', graphFile),
      pr_weight: prWeight,
      pagerank: pr.meta,
    };
  } else if (graphFileFlag !== undefined) {
    throw new Error(`citation graph not found: ${graphFile}`);
  }

  const git = getGitInfo();
  const timestamp = new Date().toISOString();
  const artifact = {
    kind: 'query-latency',
    timestamp,
    git,
    config: {
      corpus,
      query_source: querySource,
      queries: texts.length,
      topk: 100,
      pipeline:
        'candidates: parse+analyze+retrieve; strategies: + rank + top-k mapping (e2e)',
    },
    corpus: {
      name: corpus,
      hash: bundle.corpusHash,
      numDocs: bundle.reader.numDocs(),
      vocabSize: bundle.reader.stats().vocabSize,
    },
    parse_failures: parseFailures,
    ...(linkGraph === undefined ? {} : { link_graph: linkGraph }),
    stages,
  };

  const stamp = timestamp.replace(/[:.]/g, '-');
  const outPath = path.join('benchmarks', 'results', `${stamp}-query-benchmark.json`);
  writeJson(outPath, artifact);

  console.log(`[bench] ${corpus} · ${texts.length} queries · vocab ${bundle.reader.stats().vocabSize}`);
  console.log(`  stage                     avg      median     p95      min      max`);
  for (const [name, s] of Object.entries(stages)) {
    console.log(
      `  ${name.padEnd(24)} ${s.avg.toFixed(3).padStart(7)}  ${s.median.toFixed(3).padStart(7)}` +
        `  ${s.p95.toFixed(3).padStart(7)}  ${s.min.toFixed(3).padStart(7)}  ${s.max.toFixed(3).padStart(7)}  (ms)`,
    );
  }
  console.log(`  artifact ${outPath}`);
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
