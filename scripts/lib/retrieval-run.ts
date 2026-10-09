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
  tryParseQueryLenient,
  type QueryParseErrorCode,
  type LenientRepair,
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

/** Where a query failed — distinct from category (WHAT went wrong). */
export type FailureStage = 'lexer' | 'parser';

/**
 * Non-internal query failures, written to `query_set.parse_failures`.
 * - `syntax`: strict-parser error the lenient path could not repair
 * - `empty_query`: no searchable terms after analysis (never repaired)
 * - `unsupported_syntax`: strict error codes the lenient policy deliberately
 *   does not repair (MISSING_OPERAND / UNEXPECTED_TOKEN — no evidence base)
 * Internal engine errors are NOT recorded here (see InternalQueryError).
 */
export interface ParseFailure {
  readonly queryId: string;
  readonly corpus: string;
  readonly text: string;
  readonly code: string;
  readonly category: 'syntax' | 'empty_query' | 'unsupported_syntax';
  readonly stage: FailureStage;
  readonly position: number;
  /** minimal source edits applied before the final error (0 = strict failed as-is) */
  readonly repairsApplied: number;
  readonly disposition: string;
  /** retrieval is never executed for a failed query */
  readonly retrievalExecuted: false;
}

/**
 * Non-QueryParseError exceptions — written to `query_set.internal_errors`,
 * never re-labelled as parse failures (Plan A reporting rule).
 */
export interface InternalQueryError {
  readonly queryId: string;
  readonly corpus: string;
  readonly text: string;
  readonly phase: 'parse' | 'analyze' | 'retrieve' | 'rank';
  readonly message: string;
  readonly disposition: string;
  readonly retrievalExecuted: boolean;
}

/** Queries where lenient repair had to edit the source — written to `query_set.lenient_repairs`. */
export interface LenientRepairRecord {
  readonly queryId: string;
  readonly corpus: string;
  readonly text: string;
  readonly repairs: readonly LenientRepair[];
}

export interface QueryRunResult {
  readonly run: Run;
  /** per-query wall time of parse+analyze+retrieve+rank, milliseconds */
  readonly latencyMs: number[];
  readonly parseFailures: ParseFailure[];
  readonly internalErrors: InternalQueryError[];
  readonly lenientRepairs: LenientRepairRecord[];
  /** valid queries whose retrieval ran and returned nothing (not failures) */
  readonly zeroResultQueries: { readonly count: number; readonly queryIds: readonly string[] };
  /** aggregated fuzzy expansion counters (present only when fuzzy was enabled) */
  readonly fuzzy?: FuzzyRunStats;
}

const LEXER_CODES: ReadonlySet<string> = new Set<QueryParseErrorCode>([
  'UNBALANCED_QUOTE',
  'EMPTY_PHRASE',
]);

function failureCategory(
  code: QueryParseErrorCode,
): 'syntax' | 'empty_query' | 'unsupported_syntax' {
  if (code === 'EMPTY_QUERY') return 'empty_query';
  if (code === 'MISSING_OPERAND' || code === 'UNEXPECTED_TOKEN') return 'unsupported_syntax';
  return 'syntax';
}

function failureDisposition(
  category: ParseFailure['category'],
  code: string,
  position: number,
  repairsApplied: number,
): string {
  const repairs = `${repairsApplied} repair${repairsApplied === 1 ? '' : 's'} applied`;
  switch (category) {
    case 'empty_query':
      return `no searchable terms after analysis (${repairs}) -> retrieval not executed -> scored 0 on every metric`;
    case 'unsupported_syntax':
      return `unsupported query syntax (${code}@${position}) - not repaired by lenient policy (documented) -> ranked [] -> scored 0 on every metric`;
    case 'syntax':
      return `lenient repair unavailable for ${code}@${position} (${repairs}) -> ranked [] -> scored 0 on every metric`;
  }
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
 * Failures are recorded with full context (never silently dropped) and rank
 * empty — they stay in the eval denominator, scoring zeros.
 *
 * Parsing uses the STRICT-FIRST LENIENT PATH (src/core/query/lenient.ts):
 * valid queries get the exact strict AST; only strict failures trigger
 * minimal position-targeted repairs. Repaired queries are reported in
 * `lenientRepairs`; unrepairable failures in `parseFailures`; non-parse
 * exceptions in `internalErrors` (never re-labelled).
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
  const internalErrors: InternalQueryError[] = [];
  const lenientRepairs: LenientRepairRecord[] = [];
  const zeroResultIds: string[] = [];
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
    let phase: 'parse' | 'analyze' | 'retrieve' | 'rank' = 'parse';
    try {
      const parsed = tryParseQueryLenient(text, parseOptions);
      if (!parsed.ok) {
        const e = parsed.error;
        const category = failureCategory(e.code);
        parseFailures.push({
          queryId,
          corpus: bundle.corpus,
          text,
          code: e.code,
          category,
          stage: LEXER_CODES.has(e.code) ? 'lexer' : 'parser',
          position: e.position,
          repairsApplied: parsed.repairs.length,
          disposition: failureDisposition(category, e.code, e.position, parsed.repairs.length),
          retrievalExecuted: false,
        });
        run.set(queryId, []);
        latencyMs.push(performance.now() - t0);
        continue;
      }
      if (parsed.repairs.length > 0) {
        lenientRepairs.push({ queryId, corpus: bundle.corpus, text, repairs: parsed.repairs });
      }
      phase = 'analyze';
      let analyzed = analyzeQuery(parsed.query, bundle.reader.analysis);
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
      phase = 'retrieve';
      const candidates = retrieveAnalyzed(bundle.reader, analyzed);
      phase = 'rank';
      const scored = strategy.rank(bundle.reader, analyzed, candidates);
      run.set(
        queryId,
        scored.slice(0, topK).map((s) => bundle.ids[s.docId]!),
      );
      if (scored.length === 0) zeroResultIds.push(queryId);
    } catch (e) {
      const retrievalExecuted = phase === 'retrieve' || phase === 'rank';
      internalErrors.push({
        queryId,
        corpus: bundle.corpus,
        text,
        phase,
        message: e instanceof Error ? e.message : String(e),
        disposition:
          `internal ${phase} error - recorded separately, never converted into a parse failure` +
          ` -> ${retrievalExecuted ? 'partial' : 'no'} retrieval -> scored 0 on every metric`,
        retrievalExecuted,
      });
      run.set(queryId, []);
    }
    latencyMs.push(performance.now() - t0);
  }
  return {
    run,
    latencyMs,
    parseFailures,
    internalErrors,
    lenientRepairs,
    zeroResultQueries: { count: zeroResultIds.length, queryIds: zeroResultIds },
    ...(fuzzyAgg === undefined ? {} : { fuzzy: fuzzyAgg }),
  };
}
