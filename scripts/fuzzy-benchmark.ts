/**
 * Fuzzy typo-recovery benchmark (M4-C).
 *
 * Question: does bounded edit-distance expansion recover queries whose terms
 * were corrupted into dictionary misses?
 *
 * Three arms over the SAME judged query subset (qrels-driven, comparable to
 * the M2/M4 baselines), strategy bm25, all timed e2e through runQuerySet:
 *
 *   clean       original queries, no fuzzy     (reference ceiling)
 *   typo-exact  corrupted queries, no fuzzy    (the failure mode)
 *   typo-fuzzy  corrupted queries, fuzzy on    (recovery)
 *
 * Corruption is deterministic — no seeds, no randomness:
 *   for each judged query, take word tokens (len >= 4) in order; the first
 *   token whose analyzed form is indexed and that can be single-character
 *   substituted (position last->first, letter a->z) into an UNINDEXED
 *   analyzed form at edit distance exactly 1 is corrupted; the rest of the
 *   query text is untouched. Queries with no such token are excluded from
 *   every arm (recorded as skipped) so the arms stay comparable.
 *
 *   npx tsx scripts/fuzzy-benchmark.ts --corpus scifact
 *
 * Options: --corpus <name> --queries <file> --qrels <file> --topk <n>
 *          --fuzzy-edits <1|2> (default 1)
 *
 * Artifact: benchmarks/results/<timestamp>-fuzzy-benchmark.json with the
 * required evidence fields ({config, git_sha, corpus_hash, timestamp}).
 */

import fs from 'node:fs';
import path from 'node:path';
import { analyze } from '../src/core/text/index.js';
import {
  boundedEditDistance,
  resolveFuzzy,
  type FuzzyOptions,
} from '../src/core/retrieval/fuzzy.js';
import { createStrategy } from '../src/core/ranking/index.js';
import { evaluateRun, parseQrelsTsv, parseQueriesJsonl } from '../src/eval/index.js';
import type { EvaluationSummary, Qrels, Run } from '../src/eval/index.js';
import { getGitInfo, hashFile, latencyStats, writeJson } from './lib/dataset.js';
import {
  loadIndexBundle,
  runQuerySet,
  type FuzzyRunStats,
  type IndexBundle,
} from './lib/retrieval-run.js';

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

interface Correction {
  readonly queryId: string;
  readonly token: string;
  readonly tokenIndex: number;
  readonly corrupted: string;
  readonly originalTerm: string;
  readonly corruptedTerm: string;
  readonly distance: 1;
}

interface CorruptionResult {
  readonly text: string;
  readonly correction: Correction;
}

/**
 * Deterministically corrupt ONE eligible word of `text` (see header).
 * Returns null when no token qualifies (unindexed / stopword / no valid
 * substitution) — such queries are excluded from every arm.
 */
function corruptQuery(bundle: IndexBundle, queryId: string, text: string): CorruptionResult | null {
  const reader = bundle.reader;
  const words = [...text.matchAll(/[A-Za-z]{4,}/g)];
  for (const m of words) {
    const surface = m[0];
    const start = m.index!;
    const origTokens = analyze(surface, reader.analysis);
    if (origTokens.length !== 1) continue; // stopword or multi-token surface
    const originalTerm = origTokens[0]!.term;
    if (originalTerm.length < 4) continue;
    if (!reader.hasTerm(originalTerm)) continue; // target must be indexed

    const lower = surface.toLowerCase();
    for (let pos = lower.length - 1; pos >= 0; pos--) {
      for (let c = 0; c < 26; c++) {
        const letter = String.fromCharCode(97 + c);
        if (letter === lower[pos]) continue;
        const corruptedWord = lower.slice(0, pos) + letter + lower.slice(pos + 1);
        const ct = analyze(corruptedWord, reader.analysis);
        if (ct.length !== 1) continue; // corrupted into a stopword — skip
        const corruptedTerm = ct[0]!.term;
        if (corruptedTerm === originalTerm) continue;
        if (reader.hasTerm(corruptedTerm)) continue; // must be a dictionary miss
        if (boundedEditDistance(originalTerm, corruptedTerm, 1) !== 1) continue;
        const text0 = text.slice(0, start);
        const text1 = text.slice(start + surface.length);
        return {
          text: `${text0}${corruptedWord}${text1}`,
          correction: {
            queryId,
            token: surface,
            tokenIndex: words.indexOf(m),
            corrupted: corruptedWord,
            originalTerm,
            corruptedTerm,
            distance: 1,
          },
        };
      }
    }
  }
  return null;
}

interface ArmSummary {
  readonly metrics: EvaluationSummary;
  readonly latency_ms: ReturnType<typeof latencyStats>;
  readonly parse_failures: readonly { queryId: string; code: string }[];
  readonly fuzzy_stats?: FuzzyRunStats;
}

function summarize(
  result: ReturnType<typeof runQuerySet>,
  qrels: Qrels,
  kValues: readonly number[],
): ArmSummary {
  const summary = evaluateRun(result.run as Run, qrels, kValues);
  return {
    metrics: summary,
    latency_ms: latencyStats(result.latencyMs),
    parse_failures: result.parseFailures,
    ...(result.fuzzy === undefined ? {} : { fuzzy_stats: result.fuzzy }),
  };
}

function main(): void {
  const corpus = argValue('--corpus') ?? 'scifact';
  const queriesFile =
    argValue('--queries') ?? path.join('data', 'eval', `${corpus}-queries.jsonl`);
  const qrelsFile = argValue('--qrels') ?? path.join('data', 'eval', `${corpus}-qrels.tsv`);
  const topk = argNumber('--topk') ?? 1000;
  const kValues = [1, 5, 10, 100] as const;
  const fuzzyParams = resolveFuzzy(
    argNumber('--fuzzy-edits') === undefined ? {} : { maxEdits: argNumber('--fuzzy-edits')! },
  );

  const bundle = loadIndexBundle(corpus);
  const allQueries = parseQueriesJsonl(fs.readFileSync(queriesFile, 'utf8'));
  const qrels = parseQrelsTsv(fs.readFileSync(qrelsFile, 'utf8'));

  // judge-driven subset + deterministic single-word corruption
  const subsetQueries = new Map<string, string>();
  const corruptedQueries = new Map<string, string>();
  const corrections: Correction[] = [];
  const skipped: { queryId: string; reason: string }[] = [];
  for (const queryId of qrels.keys()) {
    const text = allQueries.get(queryId);
    if (text === undefined) throw new Error(`qrels query ${queryId} missing from ${queriesFile}`);
    const corrupted = corruptQuery(bundle, queryId, text);
    if (corrupted === null) {
      skipped.push({ queryId, reason: 'no eligible token for distance-1 substitution' });
      continue;
    }
    subsetQueries.set(queryId, text);
    corruptedQueries.set(queryId, corrupted.text);
    corrections.push(corrupted.correction);
  }
  if (subsetQueries.size === 0) throw new Error('no corruptible queries — nothing to benchmark');

  const subsetQrels: Qrels = new Map(
    [...qrels].filter(([queryId]) => subsetQueries.has(queryId)),
  );

  const strategy = createStrategy('bm25');
  const clean = runQuerySet(bundle, strategy, subsetQueries, topk);
  const typoExact = runQuerySet(bundle, strategy, corruptedQueries, topk);
  const typoFuzzy = runQuerySet(bundle, strategy, corruptedQueries, topk, undefined, fuzzyParams);

  const arms = {
    clean: summarize(clean, subsetQrels, kValues),
    typo_exact: summarize(typoExact, subsetQrels, kValues),
    typo_fuzzy: summarize(typoFuzzy, subsetQrels, kValues),
  };

  const git = getGitInfo();
  const timestamp = new Date().toISOString();
  const artifact = {
    kind: 'fuzzy-typo-benchmark',
    timestamp,
    git,
    config: {
      corpus,
      strategy: 'bm25',
      topk,
      k_values: kValues,
      fuzzy: fuzzyParams,
      corruption:
        'single deterministic substitution per query: first eligible word ' +
        '(len>=4, indexed, non-stopword), position last->first, letter a->z; ' +
        'accepted when the analyzed form is a dictionary miss at edit distance exactly 1; ' +
        'non-corruptible queries excluded from all arms',
    },
    corpus: {
      name: corpus,
      hash: bundle.corpusHash,
      numDocs: bundle.reader.numDocs(),
      vocabSize: bundle.reader.stats().vocabSize,
    },
    query_set: {
      file: queriesFile,
      sha256: hashFile('sha256', queriesFile),
      judged_queries: qrels.size,
      corruptible: subsetQueries.size,
      skipped,
    },
    qrels: { file: qrelsFile, sha256: hashFile('sha256', qrelsFile) },
    corrections,
    arms,
  };

  const stamp = timestamp.replace(/[:.]/g, '-');
  const outPath = path.join('benchmarks', 'results', `${stamp}-fuzzy-benchmark.json`);
  writeJson(outPath, artifact);

  const fmt = (n: number): string => n.toFixed(4);
  console.log(`[fuzzy-bench] ${corpus} · ${subsetQueries.size}/${qrels.size} corruptible queries`);
  for (const c of corrections.slice(0, 5)) {
    console.log(`  e.g. ${c.queryId}: "${c.token}" -> "${c.corrupted}" (${c.originalTerm} -> ${c.corruptedTerm})`);
  }
  if (corrections.length > 5) console.log(`  ... ${corrections.length - 5} more corrections`);
  console.log(`  arm            MAP      NDCG@10  R@100    avg ms`);
  for (const [name, arm] of Object.entries(arms)) {
    const mm = arm.metrics;
    console.log(
      `  ${name.padEnd(14)} ${fmt(mm.map).padStart(7)}  ${fmt(mm.ndcg[10] ?? 0).padStart(7)}` +
        `  ${fmt(mm.recall[100] ?? 0).padStart(7)}  ${arm.latency_ms.avg.toFixed(3).padStart(7)}`,
    );
  }
  const fuzzyM = arms.typo_fuzzy.metrics;
  const typoM = arms.typo_exact.metrics;
  const cleanM = arms.clean.metrics;
  console.log(
    `  recovery       MAP ${fmt(fuzzyM.map - typoM.map)} of ${fmt(cleanM.map - typoM.map)} gap` +
      ` · NDCG@10 ${fmt((fuzzyM.ndcg[10] ?? 0) - (typoM.ndcg[10] ?? 0))}` +
      ` of ${fmt((cleanM.ndcg[10] ?? 0) - (typoM.ndcg[10] ?? 0))} gap`,
  );
  console.log(`  git            ${git.sha.slice(0, 12)}${git.clean ? '' : ' (dirty worktree)'}`);
  console.log(`  artifact       ${outPath}`);
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
