/**
 * Experiment runner: executes one strategy over one corpus/query set against
 * committed qrels, computes the full metric suite, measures per-query e2e
 * latency, and writes a self-describing artifact under runs/.
 *
 *   npx tsx scripts/run-experiment.ts --corpus scifact --strategy bm25
 *
 * Options:
 *   --corpus <name>           data/index/<name>.aidx (default scifact)
 *   --strategy <id>           boolean|tfidf|bm25|bm25-phrase|bm25-phrase-proximity|bm25-pr
 *   --queries <file>          BEIR queries JSONL (default data/eval/scifact-queries.jsonl)
 *   --qrels <file>            BEIR qrels TSV (default data/eval/scifact-qrels.tsv)
 *   --topk <n>                retrieved docs kept per query (default 1000)
 *   --k <1,5,10,100>          cutoff values for P/R/F1/NDCG (default 1,5,10,100)
 *   --k1/--b/--tf/--phrase-bonus/--proximity-k   strategy parameters
 *   --pr-weight/--norm-guard  mode-D fusion parameters (bm25-pr only)
 *   --linkgraph <file>        citation graph for bm25-pr
 *                             (default data/eval/<corpus>-citations.json)
 *   --pr-damping/--pr-tolerance/--pr-max-iterations  PageRank parameters
 *   --fuzzy                   enable fuzzy (typo) expansion of absent terms
 *   --fuzzy-edits <1|2>       max edit distance (default 1)
 *   --fuzzy-min-len <n>       terms shorter than n are never expanded (default 3)
 *   --fuzzy-max-per-term <n>  variants kept per fuzzy term (default 10)
 *   --fuzzy-max-terms <n>     absent terms attempted per query (default 10)
 *   --fuzzy-max-per-query <n> total variants added per query (default 20)
 *
 * Every artifact records: experiment id, timestamp, git sha + worktree state,
 * corpus id + sha256, query/qrels file hashes + counts, strategy id/mode/params,
 * metrics, latency stats, parse failures. Runs are evaluated against the
 * qrels query set (evaluation iterates qrels — a missing/failed query scores
 * zeros; it is never dropped silently).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  createStrategy,
  resolveStrategyParams,
  STRATEGY_IDS,
} from '../src/core/ranking/index.js';
import { evaluateRun, parseQrelsTsv, parseQueriesJsonl } from '../src/eval/index.js';
import type { Run } from '../src/eval/index.js';
import { resolveFuzzy, type FuzzyOptions } from '../src/core/retrieval/index.js';
import { getGitInfo, hashFile, latencyStats } from './lib/dataset.js';
import { loadIndexBundle, runQuerySet } from './lib/retrieval-run.js';
import { loadCitationGraph, pageRankForBundle } from './lib/pagerank-scores.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  const pref = `${flag}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit?.slice(pref.length);
}

function argNumber(flag: string): number | undefined {
  const v = argValue(flag);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${flag}: expected a number, got "${v}"`);
  return n;
}

function main(): void {
  const corpus = argValue('--corpus') ?? 'scifact';
  const strategyId = argValue('--strategy');
  if (strategyId === undefined) throw new Error('missing --strategy');
  if (!STRATEGY_IDS.includes(strategyId)) {
    throw new Error(
      `unknown strategy "${strategyId}" (available: ${STRATEGY_IDS.join(', ')})`,
    );
  }

  const queriesFile =
    argValue('--queries') ?? path.join('data', 'eval', `${corpus}-queries.jsonl`);
  const qrelsFile = argValue('--qrels') ?? path.join('data', 'eval', `${corpus}-qrels.tsv`);
  const topk = argNumber('--topk') ?? 1000;
  const kValues = (argValue('--k') ?? '1,5,10,100').split(',').map((s) => {
    const k = Number(s.trim());
    if (!Number.isInteger(k) || k <= 0) throw new Error(`invalid --k entry "${s.trim()}"`);
    return k;
  });
  const outDir = argValue('--out') ?? 'runs';

  const bundle = loadIndexBundle(corpus);

  // mode D: PageRank scores come from an offline citation graph, computed
  // once here — the query loop never touches graph data (ADR-003 spirit).
  let linkGraph: Record<string, unknown> | undefined;
  let pagerank: Float64Array | undefined;
  if (strategyId === 'bm25-pr') {
    const graphFile =
      argValue('--linkgraph') ?? path.join('data', 'eval', `${corpus}-citations.json`);
    const graph = loadCitationGraph(graphFile);
    const damping = argNumber('--pr-damping');
    const tolerance = argNumber('--pr-tolerance');
    const maxIterations = argNumber('--pr-max-iterations');
    const pr = pageRankForBundle(bundle, graph, {
      ...(damping === undefined ? {} : { dampingFactor: damping }),
      ...(tolerance === undefined ? {} : { tolerance }),
      ...(maxIterations === undefined ? {} : { maxIterations }),
    });
    if (!pr.meta.converged) {
      throw new Error(
        `PageRank did not converge in ${pr.meta.iterations} iterations (residual ${pr.meta.residual}) — refusing to run with partial scores`,
      );
    }
    pagerank = pr.scores;
    linkGraph = {
      file: graphFile,
      sha256: hashFile('sha256', graphFile),
      graph_hash: graph.graphHash,
      edges_in_file: graph.edges.length,
      pagerank: pr.meta,
    };
  }
  const strategyOptions = {
    k1: argNumber('--k1'),
    b: argNumber('--b'),
    tf: argValue('--tf') as 'raw' | 'log' | 'augmented' | undefined,
    phraseBonus: argNumber('--phrase-bonus'),
    proximityK: argNumber('--proximity-k'),
    pagerank,
    prWeight: argNumber('--pr-weight'),
    normGuard: argNumber('--norm-guard'),
  };
  const strategy = createStrategy(strategyId, strategyOptions);
  const resolvedParams = resolveStrategyParams(strategyId, strategyOptions);

  // fuzzy (M4-C): expanded before retrieval, inside the timed query loop.
  const fuzzyEnabled = process.argv.includes('--fuzzy');
  const fuzzy = fuzzyEnabled ? resolveFuzzy(readFuzzyOptions()) : undefined;

  const allQueries = parseQueriesJsonl(fs.readFileSync(queriesFile, 'utf8'));
  const qrels = parseQrelsTsv(fs.readFileSync(qrelsFile, 'utf8'));

  const evalQueries = new Map<string, string>();
  for (const queryId of qrels.keys()) {
    const text = allQueries.get(queryId);
    if (text === undefined) {
      throw new Error(`qrels query ${queryId} has no text in ${queriesFile}`);
    }
    evalQueries.set(queryId, text);
  }

  const t0 = performance.now();
  const { run, latencyMs, parseFailures, fuzzy: fuzzyStats } = runQuerySet(
    bundle,
    strategy,
    evalQueries,
    topk,
    undefined,
    fuzzy,
  );
  const wallMs = performance.now() - t0;
  const summary = evaluateRun(run as Run, qrels, kValues);

  const git = getGitInfo();
  const timestamp = new Date().toISOString();
  const artifact = {
    experiment_id: `${corpus}-${strategy.id}`,
    timestamp,
    git,
    corpus: {
      name: corpus,
      hash: bundle.corpusHash,
      numDocs: bundle.reader.numDocs(),
    },
    query_set: {
      file: queriesFile,
      sha256: hashFile('sha256', queriesFile),
      evaluated_queries: evalQueries.size,
      parse_failures: parseFailures,
    },
    qrels: {
      file: qrelsFile,
      sha256: hashFile('sha256', qrelsFile),
      judged_queries: qrels.size,
      rows: [...qrels.values()].reduce((n, j) => n + j.size, 0),
    },
    strategy: { id: strategy.id, mode: strategy.mode, params: resolvedParams },
    ...(linkGraph === undefined ? {} : { link_graph: linkGraph }),
    ...(fuzzy === undefined || fuzzyStats === undefined
      ? {}
      : { fuzzy: { enabled: true, params: fuzzy, stats: fuzzyStats } }),
    topk,
    k_values: kValues,
    metrics: {
      map: summary.map,
      precision: summary.precision,
      recall: summary.recall,
      f1: summary.f1,
      ndcg: summary.ndcg,
    },
    latency_ms: latencyStats(latencyMs),
    wall_ms: wallMs,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = timestamp.replace(/[:.]/g, '-');
  const suffix = fuzzyEnabled ? '-fuzzy' : '';
  const artifactPath = path.join(outDir, `${stamp}-${corpus}-${strategy.id}${suffix}.json`);
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  const fmt = (n: number): string => n.toFixed(4);
  console.log(`[experiment] ${corpus} · ${strategy.id} (mode ${strategy.mode})`);
  console.log(`  queries    ${summary.queries} evaluated, ${parseFailures.length} parse failures`);
  console.log(`  MAP        ${fmt(summary.map)}`);
  for (const k of kValues) {
    console.log(
      `  @${String(k).padEnd(3)}        P ${fmt(summary.precision[k]!)}` +
        `  R ${fmt(summary.recall[k]!)}` +
        `  F1 ${fmt(summary.f1[k]!)}` +
        `  NDCG ${fmt(summary.ndcg[k]!)}`,
    );
  }
  const lat = artifact.latency_ms;
  console.log(
    `  latency    avg ${lat.avg.toFixed(3)} ms · median ${lat.median.toFixed(3)} ms · p95 ${lat.p95.toFixed(3)} ms`,
  );
  if (fuzzyStats !== undefined) {
    console.log(
      `  fuzzy      ${fuzzyStats.termsExpanded}/${fuzzyStats.termsAttempted} terms expanded` +
        ` · ${fuzzyStats.variantsAdded} variants · ${fuzzyStats.queriesExpanded}/${evalQueries.size} queries`,
    );
  }
  console.log(`  git        ${git.sha.slice(0, 12)}${git.clean ? '' : ' (dirty worktree)'}`);
  console.log(`  artifact   ${artifactPath}`);
}

/** --fuzzy-* flags -> FuzzyOptions (only defined entries; resolveFuzzy validates). */
function readFuzzyOptions(): FuzzyOptions {
  const edits = argNumber('--fuzzy-edits');
  const minLen = argNumber('--fuzzy-min-len');
  const perTerm = argNumber('--fuzzy-max-per-term');
  const maxTerms = argNumber('--fuzzy-max-terms');
  const perQuery = argNumber('--fuzzy-max-per-query');
  return {
    ...(edits === undefined ? {} : { maxEdits: edits }),
    ...(minLen === undefined ? {} : { minTermLength: minLen }),
    ...(perTerm === undefined ? {} : { maxExpansionsPerTerm: perTerm }),
    ...(maxTerms === undefined ? {} : { maxFuzzyTermsPerQuery: maxTerms }),
    ...(perQuery === undefined ? {} : { maxExpansionsPerQuery: perQuery }),
  };
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
