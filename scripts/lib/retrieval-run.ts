/**
 * Shared experiment plumbing: load a built index bundle, execute a query set
 * through parse -> analyze -> retrieve -> rank while timing each query, and
 * convert results into eval-module structures (Run) with corpus-id mapping.
 */

import fs from 'node:fs';
import path from 'node:path';
import { IndexReader } from '../../src/core/index/reader.js';
import { readSegment } from '../../src/storage/segment.js';
import {
  parseQuery,
  QueryParseError,
  type QueryParseOptions,
} from '../../src/core/query/index.js';
import {
  analyzeQuery,
  retrieveAnalyzed,
  expandFuzzyQuery,
  type FuzzyOptions,
} from '../../src/core/retrieval/index.js';
import type { RankingStrategy } from '../../src/core/ranking/index.js';
import type { Run } from '../../src/eval/index.js';

export interface IndexBundle {
  readonly corpus: string;
  readonly reader: IndexReader;
  /** docId -> corpus document id (line order of the source corpus) */
  readonly ids: readonly string[];
  readonly docIdByCorpusId: ReadonlyMap<string, number>;
  readonly corpusHash: string;
}

export interface ParseFailure {
  readonly queryId: string;
  readonly code: string;
}

export interface QueryRunResult {
  readonly run: Run;
  /** per-query wall time of parse+analyze+retrieve+rank, milliseconds */
  readonly latencyMs: number[];
  readonly parseFailures: ParseFailure[];
  /** aggregated fuzzy expansion counters (present only when fuzzy was enabled) */
  readonly fuzzy?: FuzzyRunStats;
}

export interface FuzzyRunStats {
  readonly termsAttempted: number;
  readonly termsExpanded: number;
  readonly variantsAdded: number;
  /** queries where at least one term was expanded */
  readonly queriesExpanded: number;
  /** every strict limit that fired, summed across queries */
  readonly caps: {
    readonly tooShort: number;
    readonly fuzzyTermsPerQuery: number;
    readonly expansionsPerTerm: number;
    readonly expansionsPerQuery: number;
    readonly edits2SkippedLength: number;
  };
}

/** Load data/index/<corpus>.aidx + its id map (built by build-eval-index.ts). */
export function loadIndexBundle(corpus: string, root = process.cwd()): IndexBundle {
  const segmentPath = path.join(root, 'data', 'index', `${corpus}.aidx`);
  const idsPath = path.join(root, 'data', 'index', `${corpus}.ids.json`);
  if (!fs.existsSync(segmentPath)) {
    throw new Error(
      `missing index: ${segmentPath} — run: npm run index:build -- --corpus ${corpus}`,
    );
  }
  if (!fs.existsSync(idsPath)) {
    throw new Error(`missing id map: ${idsPath} — rebuild with build-eval-index.ts`);
  }
  const data = readSegment(segmentPath);
  const ids = JSON.parse(fs.readFileSync(idsPath, 'utf8')) as string[];
  if (ids.length !== data.stats.numDocs) {
    throw new Error(`id map has ${ids.length} entries but index has ${data.stats.numDocs} docs`);
  }
  const docIdByCorpusId = new Map<string, number>();
  ids.forEach((id, docId) => docIdByCorpusId.set(id, docId));
  return {
    corpus,
    reader: IndexReader.fromData(data),
    ids,
    docIdByCorpusId,
    corpusHash: data.corpusHash,
  };
}

/**
 * Run every query through the full pipeline, timing each one.
 * Unparseable queries are recorded (never silently dropped) and ranked empty.
 *
 * Default parse mode is disjunctive (`implicitOperator: 'or'`): evaluation
 * and latency runs treat each query as a bag of words joined by OR — the
 * standard IR convention behind BEIR/TREC BM25 baselines. Explicit
 * operators/quotes in a query are honored as written either way.
 *
 * With `fuzzy` supplied, absent query terms are expanded against the
 * dictionary (bounded edit distance) before retrieval — inside the timed
 * loop, because expansion is part of query cost.
 */
export function runQuerySet(
  bundle: IndexBundle,
  strategy: RankingStrategy,
  queries: ReadonlyMap<string, string>,
  topK: number,
  parseOptions: QueryParseOptions = { implicitOperator: 'or' },
  fuzzy?: FuzzyOptions,
): QueryRunResult {
  const run = new Map<string, string[]>();
  const latencyMs: number[] = [];
  const parseFailures: ParseFailure[] = [];
  const fuzzyAgg =
    fuzzy === undefined
      ? undefined
      : {
          termsAttempted: 0,
          termsExpanded: 0,
          variantsAdded: 0,
          queriesExpanded: 0,
          caps: {
            tooShort: 0,
            fuzzyTermsPerQuery: 0,
            expansionsPerTerm: 0,
            expansionsPerQuery: 0,
            edits2SkippedLength: 0,
          },
        };

  for (const [queryId, text] of queries) {
    const t0 = performance.now();
    try {
      const parsed = parseQuery(text, parseOptions);
      let analyzed = analyzeQuery(parsed, bundle.reader.analysis);
      if (fuzzyAgg !== undefined && fuzzy !== undefined) {
        const expanded = expandFuzzyQuery(bundle.reader, analyzed, fuzzy);
        analyzed = expanded.query;
        const s = expanded.stats;
        fuzzyAgg.termsAttempted += s.termsAttempted;
        fuzzyAgg.termsExpanded += s.termsExpanded;
        fuzzyAgg.variantsAdded += s.variantsAdded;
        if (s.termsExpanded > 0) fuzzyAgg.queriesExpanded++;
        fuzzyAgg.caps.tooShort += s.caps.tooShort;
        fuzzyAgg.caps.fuzzyTermsPerQuery += s.caps.fuzzyTermsPerQuery;
        fuzzyAgg.caps.expansionsPerTerm += s.caps.expansionsPerTerm;
        fuzzyAgg.caps.expansionsPerQuery += s.caps.expansionsPerQuery;
        fuzzyAgg.caps.edits2SkippedLength += s.caps.edits2SkippedLength;
      }
      const candidates = retrieveAnalyzed(bundle.reader, analyzed);
      const scored = strategy.rank(bundle.reader, analyzed, candidates);
      run.set(
        queryId,
        scored.slice(0, topK).map((s) => bundle.ids[s.docId]!),
      );
    } catch (e) {
      const code = e instanceof QueryParseError ? e.code : 'INTERNAL';
      parseFailures.push({ queryId, code });
      run.set(queryId, []);
    }
    latencyMs.push(performance.now() - t0);
  }
  return {
    run,
    latencyMs,
    parseFailures,
    ...(fuzzyAgg === undefined ? {} : { fuzzy: fuzzyAgg }),
  };
}
