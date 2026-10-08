/**
 * SearchService — the thin orchestration layer between HTTP and the engine.
 *
 * WHAT: one class that loads index bundles, runs a SINGLE query through the
 *   exact M0-M4 pipeline (parse -> analyze -> fuzzy -> retrieve -> rank),
 *   and serves document lookups, system stats, runtime config, and the
 *   recorded-benchmark feed.
 * WHY it exists (viva answer): the API must NOT contain a second search
 *   implementation. Every number this service returns comes from the same
 *   functions the evaluation harness uses (scripts/lib/retrieval-run.ts
 *   wires them for query SETS; we wire them for one query).
 * WHAT DATA ENTERS: plain params {q, k, page, strategy, corpus, fuzzy,
 *   fuzzyEdits, implicit}; data/index/<corpus>.aidx + corpus metadata files.
 * WHAT DATA LEAVES: JSON-safe response objects (SearchResponse, DocDetail,
 *   StatsResponse, ConfigResponse, BenchmarksResponse).
 * FAILURES: ServiceError carries {status, code, message} — app.ts maps it to
 *   HTTP; engine internals never leak (paths, SQL) to clients.
 * CONNECTS TO M0-M4: core/query, core/retrieval, core/ranking (incl. M4
 *   fusion + fuzzy), core/link (via citation-graph PageRank), storage/segment,
 *   scripts/lib/{retrieval-run,pagerank-scores}.
 */

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {
  loadIndexBundle,
  type IndexBundle,
} from '../../scripts/lib/retrieval-run.js';
import {
  loadCitationGraph,
  pageRankForBundle,
  type PageRankRunMeta,
} from '../../scripts/lib/pagerank-scores.js';
import { parseQuery, QueryParseError, type Query } from '../core/query/index.js';
import {
  analyzeQuery,
  analyzedLeafTerms,
  positiveQueryTerms,
  expandFuzzyQuery,
  matchPhrase,
  resolveFuzzy,
  retrieveAnalyzed,
  DEFAULT_FUZZY,
  type AnalyzedQuery,
  type FuzzyExpansion,
  type FuzzyOptions,
  type FuzzyStats,
} from '../core/retrieval/index.js';
import {
  getRankingStrategy,
  createStrategy,
  resolveStrategyParams,
  STRATEGY_IDS,
  type RankingStrategy,
} from '../core/ranking/index.js';
import type { Token } from '../core/text/analyze.js';
import { analyze } from '../core/text/analyze.js';
import type { ApiConfig } from './config.js';
import { createDocStore, type DocStore } from './doc-store.js';
import { makeSnippet, type Snippet } from './snippets.js';

/** Uniform service error — app.ts turns this into an HTTP response. */
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/** UI labels for implemented strategies — single source of truth (/api/config). */
export const STRATEGY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  boolean: 'Boolean',
  tfidf: 'TF-IDF',
  bm25: 'BM25',
  'bm25-phrase': 'BM25 + Phrase',
  'bm25-phrase-proximity': 'BM25 + Phrase + Proximity',
  'bm25-pr': 'Hybrid BM25 + PageRank',
});

export interface SearchParams {
  readonly q: string;
  readonly k?: number;
  readonly page?: number;
  readonly strategy?: string;
  readonly corpus?: string;
  readonly fuzzy?: boolean;
  readonly fuzzyEdits?: 1 | 2;
  readonly implicit?: 'and' | 'or';
}

export interface SearchHit {
  readonly rank: number;
  readonly docId: string;
  readonly title: string;
  readonly url: string | null;
  readonly source: string;
  readonly snippet: Snippet | null;
  readonly score: number;
  /** raw per-signal components — only keys the strategy actually produced */
  readonly signals: Readonly<Record<string, number>>;
}

export interface FuzzyFeedback {
  readonly applied: boolean;
  readonly edits: 1 | 2;
  readonly expansions: readonly FuzzyExpansion[];
  readonly stats: FuzzyStats | null;
}

export interface SearchResponse {
  readonly query: string;
  readonly strategy: string;
  readonly results: readonly SearchHit[];
  readonly meta: {
    readonly corpus: string;
    readonly k: number;
    readonly page: number;
    readonly totalPages: number;
    readonly totalCandidates: number;
    readonly returned: number;
    readonly latencyMs: number;
    readonly timing: Readonly<Record<string, number>>;
    readonly fuzzyApplied: boolean;
    readonly expandedTerms: readonly string[];
    readonly fuzzy: FuzzyFeedback;
    readonly strategyDetail: {
      /** API strategy key the caller requested (bm25, tfidf, ...) */
      readonly id: string;
      /** engine-internal strategy id (e.g. bm25-k1.2-b0.75) — the exact
       *  configuration recorded in the committed run artifacts */
      readonly engineId: string;
      readonly mode: string;
      readonly params: Readonly<Record<string, number | string>>;
    };
    readonly diagnostics: {
      readonly implicitOperator: 'and' | 'or';
      readonly parsed: Query;
      readonly analyzedTerms: readonly string[];
      readonly positiveTerms: readonly string[];
      readonly candidates: number;
    };
  };
}

export interface MatchedTerm {
  readonly term: string;
  readonly tf: number;
  readonly df: number;
}

export interface DocDetail {
  readonly corpus: string;
  readonly docId: number;
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly source: string;
  readonly text: string | null;
  readonly textTruncated: boolean;
  readonly pagerank: number | null;
  readonly matchedTerms: readonly MatchedTerm[] | null;
  readonly phrases: readonly { terms: readonly string[]; matched: boolean }[] | null;
}

export interface StatsResponse {
  readonly version: string;
  readonly node: string;
  readonly uptimeMs: number;
  readonly corpus: {
    readonly name: string;
    readonly numDocs: number;
    readonly vocabSize: number;
    readonly numPostings: number;
    readonly totalTokens: number;
    readonly avgDocLength: number;
    readonly indexBytes: number;
    readonly corpusHash: string;
    readonly metadataStore: string;
  };
  readonly corpora: readonly { readonly name: string; readonly indexBytes: number }[];
  readonly pagerank: PagerankStatus;
  readonly strategies: readonly {
    readonly id: string;
    readonly label: string;
    readonly mode: string;
    readonly available: boolean;
    readonly reason?: string;
  }[];
  readonly fuzzy: { readonly supported: true; readonly defaults: typeof DEFAULT_FUZZY };
  readonly crawl: Record<string, unknown> | null;
  readonly search: {
    readonly total: number;
    readonly recent: { readonly count: number; readonly avgMs: number; readonly p95Ms: number };
  };
}

export interface PagerankStatus {
  readonly available: boolean;
  readonly source?: string;
  readonly nodes?: number;
  readonly edges?: number;
  readonly iterations?: number;
  readonly residual?: number;
  readonly converged?: boolean;
  readonly damping?: number;
  readonly graphHash?: string;
}

export interface ConfigResponse {
  readonly version: string;
  readonly defaultCorpus: string;
  readonly defaultStrategy: string;
  readonly defaultK: number;
  readonly maxK: number;
  readonly maxPage: number;
  readonly implicitOperator: 'and' | 'or';
  readonly corpora: readonly string[];
  readonly strategies: readonly {
    readonly id: string;
    readonly label: string;
    readonly available: boolean;
    readonly reason?: string;
  }[];
  readonly fuzzyDefaults: typeof DEFAULT_FUZZY;
}

interface PagerankSource {
  readonly scores: Float64Array;
  readonly meta: PageRankRunMeta;
  readonly source: string;
}

interface CorpusRuntime {
  readonly name: string;
  readonly bundle: IndexBundle;
  readonly docStore: DocStore;
  readonly indexBytes: number;
  readonly strategies: Map<string, RankingStrategy>;
  readonly snippetTokens: Map<number, readonly Token[]>;
  pagerankTried: boolean;
  pagerank: PagerankSource | null;
}

const SNIPPET_TOKEN_CACHE_MAX = 400;
const DOC_TEXT_MAX = 20_000;

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function walkPositiveLeaves(query: Query, fn: (leaf: Query & { kind: 'phrase' }) => void): void {
  const walk = (node: Query): void => {
    switch (node.kind) {
      case 'phrase':
        fn(node);
        return;
      case 'not':
        return; // negated phrases constrain, never match-signal
      case 'and':
      case 'or':
        walk(node.left);
        walk(node.right);
        return;
      case 'term':
        return;
    }
  };
  walk(query);
}

export class SearchService {
  private readonly runtimes = new Map<string, CorpusRuntime>();
  private readonly availableCorpora: string[];
  private latencyRing: number[] = [];
  private totalSearches = 0;
  private readonly startedAt = Date.now();
  private readonly version: string;

  constructor(private readonly cfg: ApiConfig) {
    this.availableCorpora = this.discoverCorpora();
    this.version = this.readVersion();
  }

  /** Liveness probe — never loads an index, never touches the network. */
  health(): {
    status: 'ok';
    version: string;
    uptimeMs: number;
    corpora: readonly string[];
    loadedCorpora: readonly string[];
    searches: number;
  } {
    return {
      status: 'ok',
      version: this.version,
      uptimeMs: Date.now() - this.startedAt,
      corpora: [...this.availableCorpora],
      loadedCorpora: [...this.runtimes.keys()],
      searches: this.totalSearches,
    };
  }

  private readVersion(): string {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(this.cfg.root, 'package.json'), 'utf8'),
      ) as { version?: string };
      return pkg.version ?? '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  private discoverCorpora(): string[] {
    const dir = path.join(this.cfg.root, 'data', 'index');
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.aidx'))
        .map((f) => f.slice(0, -'.aidx'.length))
        .sort();
    } catch {
      return [];
    }
  }

  private runtime(corpus: string): CorpusRuntime {
    if (!this.availableCorpora.includes(corpus)) {
      throw new ServiceError(
        400,
        'INVALID_CORPUS',
        `corpus "${corpus}" is not available (have: ${this.availableCorpora.join(', ') || 'none'})`,
      );
    }
    const existing = this.runtimes.get(corpus);
    if (existing !== undefined) return existing;
    let bundle: IndexBundle;
    try {
      bundle = loadIndexBundle(corpus, this.cfg.root);
    } catch {
      // Never leak filesystem paths — give the rebuild command instead.
      throw new ServiceError(
        503,
        'INDEX_UNAVAILABLE',
        `index for corpus "${corpus}" is unavailable — rebuild with: npm run index:build -- --corpus ${corpus}`,
      );
    }
    const segmentPath = path.join(this.cfg.root, 'data', 'index', `${corpus}.aidx`);
    const runtime: CorpusRuntime = {
      name: corpus,
      bundle,
      docStore: createDocStore(corpus, bundle, this.cfg.root),
      indexBytes: fs.statSync(segmentPath).size,
      strategies: new Map(),
      snippetTokens: new Map(),
      pagerankTried: false,
      pagerank: null,
    };
    this.runtimes.set(corpus, runtime);
    return runtime;
  }

  /**
   * PageRank vector for mode D — lazy, per corpus, cached.
   * scifact: committed citation graph (same source as the M4-B ablation).
   * crawled: latest persisted run in PostgreSQL (M4-A job output), if reachable.
   * Everything else: null => hybrid strategy unavailable with a clear reason.
   */
  private async pagerankFor(rt: CorpusRuntime): Promise<PagerankSource | null> {
    if (rt.pagerankTried) return rt.pagerank;
    rt.pagerankTried = true;
    rt.pagerank = null;
    const graphFile = path.join(this.cfg.root, 'data', 'eval', `${rt.name}-citations.json`);
    if (fs.existsSync(graphFile)) {
      try {
        const graph = loadCitationGraph(graphFile);
        const pr = pageRankForBundle(rt.bundle, graph);
        if (pr.meta.converged) {
          rt.pagerank = { scores: pr.scores, meta: pr.meta, source: `citation-graph:${rt.name}` };
        }
      } catch {
        rt.pagerank = null; // mapping bug or corrupt graph -> hybrid off, loudly typed
      }
      return rt.pagerank;
    }
    if (rt.name === 'crawled' && process.env.DATABASE_URL !== undefined) {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
      try {
        const res = await pool.query(
          'SELECT url, value FROM pagerank_scores WHERE run_id = (SELECT MAX(run_id) FROM pagerank_runs)',
        );
        if (res.rows.length > 0) {
          const scores = new Float64Array(rt.bundle.ids.length);
          let mapped = 0;
          const indexOf = new Map<string, number>();
          rt.bundle.ids.forEach((id, i) => indexOf.set(id, i));
          for (const row of res.rows as { url: string; value: number }[]) {
            const docId = indexOf.get(row.url);
            if (docId !== undefined) {
              scores[docId] = row.value;
              mapped++;
            }
          }
          rt.pagerank = {
            scores,
            meta: {
              damping: 0.85,
              tolerance: 0,
              maxIterations: 0,
              iterations: 0,
              converged: true,
              residual: 0,
              nodeCount: mapped,
              edgeCount: 0,
              graphHash: '',
            },
            source: 'postgres:pagerank_scores',
          };
        }
      } catch {
        rt.pagerank = null;
      } finally {
        await pool.end().catch(() => undefined);
      }
    }
    return rt.pagerank;
  }

  private async strategyFor(
    rt: CorpusRuntime,
    id: string,
  ): Promise<RankingStrategy> {
    if (id !== 'bm25-pr') {
      // Static registry strategies are frozen singletons — share them.
      const cached = rt.strategies.get(id);
      if (cached !== undefined) return cached;
      const s = getRankingStrategy(id);
      rt.strategies.set(id, s);
      return s;
    }
    const cached = rt.strategies.get(id);
    if (cached !== undefined) return cached;
    const pr = await this.pagerankFor(rt);
    if (pr === null) {
      throw new ServiceError(
        400,
        'STRATEGY_UNAVAILABLE',
        `strategy "bm25-pr" has no PageRank source for corpus "${rt.name}"`,
      );
    }
    const s = createStrategy('bm25-pr', { pagerank: pr.scores });
    rt.strategies.set(id, s);
    return s;
  }

  private async strategyAvailability(
    rt: CorpusRuntime,
    id: string,
  ): Promise<{ available: boolean; reason?: string }> {
    if (id !== 'bm25-pr') return { available: true };
    const pr = await this.pagerankFor(rt);
    return pr === null
      ? { available: false, reason: `no PageRank source for corpus "${rt.name}"` }
      : { available: true };
  }

  /** Search one page of results — the same pipeline evaluation uses. */
  async search(params: SearchParams): Promise<SearchResponse> {
    const t0 = performance.now();
    const q = params.q.trim();
    if (q.length === 0) {
      throw new ServiceError(400, 'INVALID_QUERY', 'query must not be empty');
    }
    if (q.length > this.cfg.maxQueryLength) {
      throw new ServiceError(
        400,
        'INVALID_QUERY',
        `query exceeds ${this.cfg.maxQueryLength} characters`,
      );
    }
    const corpus = params.corpus ?? this.cfg.defaultCorpus;
    const rt = this.runtime(corpus);
    const strategyId = params.strategy ?? this.cfg.defaultStrategy;
    if (!STRATEGY_IDS.includes(strategyId)) {
      throw new ServiceError(
        400,
        'INVALID_STRATEGY',
        `unknown strategy "${strategyId}" (available: ${STRATEGY_IDS.join(', ')})`,
      );
    }
    const k = params.k ?? this.cfg.defaultK;
    const page = params.page ?? 1;
    if (!Number.isInteger(k) || k < 1 || k > this.cfg.maxK) {
      throw new ServiceError(400, 'INVALID_PARAMS', `k must be an integer in [1, ${this.cfg.maxK}]`);
    }
    if (!Number.isInteger(page) || page < 1 || page > this.cfg.maxPage) {
      throw new ServiceError(
        400,
        'INVALID_PARAMS',
        `page must be an integer in [1, ${this.cfg.maxPage}]`,
      );
    }
    const implicit = params.implicit ?? this.cfg.implicitOperator;
    const strategy = await this.strategyFor(rt, strategyId);

    const timing: Record<string, number> = {};
    const mark = (name: string, from: number): void => {
      timing[name] = round(performance.now() - from, 3);
    };

    // 1. parse (QueryParseError -> 400 with code + position)
    let t = performance.now();
    let parsed: Query;
    try {
      parsed = parseQuery(q, { implicitOperator: implicit });
    } catch (e) {
      if (e instanceof QueryParseError) {
        throw new ServiceError(
          400,
          'QUERY_PARSE',
          `${e.code} at position ${e.position}: ${e.message}`,
        );
      }
      throw e;
    }
    mark('parseMs', t);

    // 2. analyze with the index's frozen config (ADR-009)
    t = performance.now();
    let analyzed: AnalyzedQuery = analyzeQuery(parsed, rt.bundle.reader.analysis);
    mark('analyzeMs', t);

    // 3. optional fuzzy expansion of ABSENT terms (M4-C)
    t = performance.now();
    let expansions: readonly FuzzyExpansion[] = [];
    let fuzzyStats: FuzzyStats | null = null;
    const fuzzyEnabled = params.fuzzy === true;
    let fuzzyResolved: ReturnType<typeof resolveFuzzy> | null = null;
    if (fuzzyEnabled) {
      try {
        fuzzyResolved = resolveFuzzy(
          params.fuzzyEdits === undefined ? {} : { maxEdits: params.fuzzyEdits },
        );
      } catch (e) {
        throw new ServiceError(
          400,
          'INVALID_FUZZY',
          e instanceof Error ? e.message : 'invalid fuzzy configuration',
        );
      }
      const opts: FuzzyOptions = {
        ...(fuzzyResolved.maxEdits === undefined ? {} : { maxEdits: fuzzyResolved.maxEdits }),
        minTermLength: fuzzyResolved.minTermLength,
        maxExpansionsPerTerm: fuzzyResolved.maxExpansionsPerTerm,
        maxFuzzyTermsPerQuery: fuzzyResolved.maxFuzzyTermsPerQuery,
        maxExpansionsPerQuery: fuzzyResolved.maxExpansionsPerQuery,
      };
      const expanded = expandFuzzyQuery(rt.bundle.reader, analyzed, opts);
      analyzed = expanded.query;
      expansions = expanded.expansions;
      fuzzyStats = expanded.stats;
    }
    mark('fuzzyMs', t);

    // 4. boolean candidates
    t = performance.now();
    const candidates = retrieveAnalyzed(rt.bundle.reader, analyzed);
    mark('retrieveMs', t);

    // 5. rank (strategy already selected/validated)
    t = performance.now();
    const scored = strategy.rank(rt.bundle.reader, analyzed, candidates);
    mark('rankMs', t);

    // 6. page slice + presentation mapping
    t = performance.now();
    const offset = (page - 1) * k;
    const pageRows = scored.slice(offset, offset + k);
    const positive = new Set(positiveQueryTerms(analyzed));
    const results: SearchHit[] = pageRows.map((row, i) => {
      const id = rt.bundle.ids[row.docId];
      if (id === undefined) {
        throw new ServiceError(500, 'INTERNAL', 'docId out of range — id map mismatch');
      }
      const meta = rt.docStore.get(row.docId);
      return {
        rank: offset + i + 1,
        docId: id,
        title: meta?.title ?? id,
        url: meta?.url ?? null,
        source: meta?.source ?? corpus,
        snippet: this.snippetFor(rt, row.docId, meta?.text ?? null, positive),
        score: row.score,
        signals: row.breakdown,
      };
    });
    mark('mapMs', t);

    const totalMs = performance.now() - t0;
    this.totalSearches++;
    this.latencyRing.push(totalMs);
    if (this.latencyRing.length > 100) this.latencyRing = this.latencyRing.slice(-100);

    const totalPages = Math.max(1, Math.ceil(scored.length / k));
    const leafTerms = analyzedLeafTerms(analyzed);
    const paramsEcho = resolveStrategyParams(strategyId);

    return {
      query: q,
      strategy: strategyId,
      results,
      meta: {
        corpus,
        k,
        page,
        totalPages,
        totalCandidates: candidates.length,
        returned: results.length,
        latencyMs: round(totalMs, 3),
        timing,
        fuzzyApplied: fuzzyEnabled && expansions.length > 0,
        expandedTerms: [...new Set(expansions.flatMap((e) => e.variants))],
        fuzzy: {
          applied: fuzzyEnabled,
          edits: fuzzyResolved?.maxEdits ?? DEFAULT_FUZZY.maxEdits,
          expansions,
          stats: fuzzyStats,
        },
        strategyDetail: {
          id: strategyId,
          engineId: strategy.id,
          mode: strategy.mode,
          params: paramsEcho,
        },
        diagnostics: {
          implicitOperator: implicit,
          parsed,
          analyzedTerms: leafTerms,
          positiveTerms: positiveQueryTerms(analyzed),
          candidates: candidates.length,
        },
      },
    };
  }

  private snippetFor(
    rt: CorpusRuntime,
    docId: number,
    text: string | null,
    positive: ReadonlySet<string>,
  ): Snippet | null {
    if (text === null || text.length === 0) return null;
    let tokens = rt.snippetTokens.get(docId);
    if (tokens === undefined) {
      tokens = analyze(text, rt.bundle.reader.analysis);
      if (rt.snippetTokens.size >= SNIPPET_TOKEN_CACHE_MAX) {
        const oldest = rt.snippetTokens.keys().next().value;
        if (oldest !== undefined) rt.snippetTokens.delete(oldest);
      }
      rt.snippetTokens.set(docId, tokens);
    }
    return makeSnippet(text, tokens, positive);
  }

  /** Document detail — id is the corpus id (BEIR _id / URL / fixture id). */
  async document(
    corpus: string,
    id: string,
    opts: { q?: string; fuzzy?: boolean } = {},
  ): Promise<DocDetail> {
    const rt = this.runtime(corpus);
    const docId = rt.bundle.docIdByCorpusId.get(id);
    if (docId === undefined) {
      throw new ServiceError(404, 'DOC_NOT_FOUND', `document "${id}" not found in corpus "${corpus}"`);
    }
    await rt.docStore.resolve?.(docId);
    const meta = rt.docStore.get(docId);
    if (meta === null) {
      throw new ServiceError(404, 'DOC_NOT_FOUND', `document "${id}" not found in corpus "${corpus}"`);
    }

    let matchedTerms: MatchedTerm[] | null = null;
    let phrases: { terms: readonly string[]; matched: boolean }[] | null = null;
    if (opts.q !== undefined && opts.q.trim().length > 0) {
      const q = opts.q.trim().slice(0, this.cfg.maxQueryLength);
      let parsed: Query;
      try {
        parsed = parseQuery(q, { implicitOperator: this.cfg.implicitOperator });
      } catch (e) {
        if (e instanceof QueryParseError) {
          throw new ServiceError(400, 'QUERY_PARSE', `${e.code} at position ${e.position}: ${e.message}`);
        }
        throw e;
      }
      let analyzed = analyzeQuery(parsed, rt.bundle.reader.analysis);
      if (opts.fuzzy === true) {
        const expanded = expandFuzzyQuery(rt.bundle.reader, analyzed, {});
        analyzed = expanded.query;
      }
      matchedTerms = [];
      for (const term of positiveQueryTerms(analyzed)) {
        const view = rt.bundle.reader.postingsForTerm(term);
        if (view === null) continue;
        let tf = 0;
        let found = false;
        view.forEach((_i, d, t) => {
          if (d === docId) {
            tf = t;
            found = true;
          }
        });
        if (found) matchedTerms.push({ term, tf, df: view.df });
      }
      phrases = [];
      walkPositiveLeaves(parsed, (leaf) => {
        const analyzedPhrase = analyzeQuery(leaf, rt.bundle.reader.analysis);
        if (analyzedPhrase.kind !== 'phrase') return;
        const hits = matchPhrase(rt.bundle.reader, analyzedPhrase.terms);
        phrases!.push({ terms: analyzedPhrase.terms, matched: hits.includes(docId) });
      });
    }

    let pagerank: number | null = null;
    try {
      const pr = await this.pagerankFor(rt);
      if (pr !== null && docId < pr.scores.length) pagerank = pr.scores[docId]!;
    } catch {
      pagerank = null;
    }

    const text = meta.text;
    const truncated = text !== null && text.length > DOC_TEXT_MAX;
    return {
      corpus,
      docId,
      id: meta.id,
      title: meta.title,
      url: meta.url,
      source: meta.source,
      text: truncated ? text!.slice(0, DOC_TEXT_MAX) : text,
      textTruncated: truncated,
      pagerank: pagerank === null ? null : round(pagerank, 9),
      matchedTerms,
      phrases,
    };
  }

  /** System stats — the demo's technical overview. */
  async stats(corpusArg?: string): Promise<StatsResponse> {
    const corpus = corpusArg ?? this.cfg.defaultCorpus;
    const rt = this.runtime(corpus);
    const indexStats = rt.bundle.reader.stats();
    const pr = await this.pagerankFor(rt);

    const strategies: {
      id: string;
      label: string;
      mode: string;
      available: boolean;
      reason?: string;
    }[] = [];
    for (const id of STRATEGY_IDS) {
      const mode = id === 'bm25-pr' ? 'D' : getRankingStrategy(id).mode;
      const avail = await this.strategyAvailability(rt, id);
      strategies.push({
        id,
        label: STRATEGY_LABELS[id] ?? id,
        mode,
        available: avail.available,
        ...(avail.reason === undefined ? {} : { reason: avail.reason }),
      });
    }

    const recent = [...this.latencyRing].sort((a, b) => a - b);
    const recentAvg =
      recent.length === 0 ? 0 : recent.reduce((s, n) => s + n, 0) / recent.length;

    return {
      version: this.version,
      node: process.version,
      uptimeMs: Date.now() - this.startedAt,
      corpus: {
        name: corpus,
        numDocs: indexStats.numDocs,
        vocabSize: indexStats.vocabSize,
        numPostings: indexStats.numPostings,
        totalTokens: indexStats.totalTokens,
        avgDocLength: round(indexStats.avgDocLength, 2),
        indexBytes: rt.indexBytes,
        corpusHash: rt.bundle.corpusHash,
        metadataStore: rt.docStore.kind,
      },
      corpora: this.availableCorpora.map((name) => ({
        name,
        indexBytes:
          name === corpus
            ? rt.indexBytes
            : fs.existsSync(path.join(this.cfg.root, 'data', 'index', `${name}.aidx`))
              ? fs.statSync(path.join(this.cfg.root, 'data', 'index', `${name}.aidx`)).size
              : 0,
      })),
      pagerank: pr === null
        ? { available: false }
        : {
            available: true,
            source: pr.source,
            nodes: pr.meta.nodeCount,
            edges: pr.meta.edgeCount,
            iterations: pr.meta.iterations,
            residual: pr.meta.residual,
            converged: pr.meta.converged,
            damping: pr.meta.damping,
            ...(pr.meta.graphHash === '' ? {} : { graphHash: pr.meta.graphHash }),
          },
      strategies,
      fuzzy: { supported: true, defaults: DEFAULT_FUZZY },
      crawl: this.readCrawlManifest(),
      search: {
        total: this.totalSearches,
        recent: {
          count: recent.length,
          avgMs: round(recentAvg, 3),
          p95Ms: round(percentile(recent, 95), 3),
        },
      },
    };
  }

  private readCrawlManifest(): Record<string, unknown> | null {
    const file = path.join(this.cfg.root, 'data', 'eval', 'crawled.manifest.json');
    if (!fs.existsSync(file)) return null;
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const counts = (m.counts ?? {}) as Record<string, unknown>;
      const links = (counts.links ?? {}) as Record<string, unknown>;
      const urls = (counts.urls ?? {}) as Record<string, unknown>;
      const index = (m.index ?? {}) as Record<string, unknown>;
      return {
        documents: counts.documents ?? null,
        indexable: counts.indexable ?? null,
        duplicates: counts.duplicates ?? null,
        urls,
        links,
        failed: urls.failed ?? null,
        pending: urls.pending ?? null,
        vocabSize: index.vocabSize ?? null,
        corpusHash: index.corpusHash ?? null,
        builtAt: m.builtAt ?? null,
      };
    } catch {
      return null;
    }
  }

  /** Runtime configuration for the UI (strategy list = implemented only). */
  async config(): Promise<ConfigResponse> {
    const corpora = this.availableCorpora;
    const probeCorpus = corpora.includes(this.cfg.defaultCorpus)
      ? this.cfg.defaultCorpus
      : corpora[0];
    const strategies: { id: string; label: string; available: boolean; reason?: string }[] = [];
    for (const id of STRATEGY_IDS) {
      if (probeCorpus === undefined) {
        strategies.push({ id, label: STRATEGY_LABELS[id] ?? id, available: id !== 'bm25-pr' });
        continue;
      }
      const rt = this.runtime(probeCorpus);
      const avail = await this.strategyAvailability(rt, id);
      strategies.push({
        id,
        label: STRATEGY_LABELS[id] ?? id,
        available: avail.available,
        ...(avail.reason === undefined ? {} : { reason: avail.reason }),
      });
    }
    return {
      version: this.version,
      defaultCorpus: this.cfg.defaultCorpus,
      defaultStrategy: this.cfg.defaultStrategy,
      defaultK: this.cfg.defaultK,
      maxK: this.cfg.maxK,
      maxPage: this.cfg.maxPage,
      implicitOperator: this.cfg.implicitOperator,
      corpora,
      strategies,
      fuzzyDefaults: DEFAULT_FUZZY,
    };
  }

  /**
   * Recorded experiments from COMMITTED artifacts — read-only, never
   * recomputed, never modified (evidence rule, DEVELOPMENT.md).
   */
  benchmarks(): unknown {
    const runs = this.readJsonDir(path.join(this.cfg.root, 'runs'), (file, json) => {
      const m = (json.metrics ?? {}) as Record<string, unknown>;
      const strat = (json.strategy ?? {}) as Record<string, unknown>;
      const lat = (json.latency_ms ?? {}) as Record<string, unknown>;
      const ndcg = (m.ndcg ?? {}) as Record<string, unknown>;
      const recall = (m.recall ?? {}) as Record<string, unknown>;
      const gitObj = (json.git ?? {}) as Record<string, unknown>;
      const corpusObj = (json.corpus ?? {}) as Record<string, unknown>;
      const fuzzy = (json.fuzzy ?? null) as Record<string, unknown> | null;
      const querySet = (json.query_set ?? {}) as Record<string, unknown>;
      if (typeof m.map !== 'number') return null;
      return {
        file,
        experimentId: typeof json.experiment_id === 'string' ? json.experiment_id : null,
        timestamp: typeof json.timestamp === 'string' ? json.timestamp : null,
        gitSha: typeof gitObj.sha === 'string' ? gitObj.sha : null,
        corpus: typeof corpusObj.name === 'string' ? corpusObj.name : null,
        strategy: typeof strat.id === 'string' ? strat.id : null,
        mode: typeof strat.mode === 'string' ? strat.mode : null,
        params: (strat.params ?? {}) as Record<string, number | string>,
        evaluatedQueries:
          typeof querySet.evaluated_queries === 'number' ? querySet.evaluated_queries : null,
        map: m.map,
        ndcg10: typeof ndcg['10'] === 'number' ? ndcg['10'] : null,
        recall100: typeof recall['100'] === 'number' ? recall['100'] : null,
        latencyAvgMs: typeof lat.avg === 'number' ? lat.avg : null,
        fuzzy: fuzzy !== null && fuzzy.enabled === true,
      };
    });

    const fuzzyBenches = this.readJsonDir(
      path.join(this.cfg.root, 'benchmarks', 'results'),
      (file, json) => {
        if (!file.endsWith('-fuzzy-benchmark.json')) return null;
        const arms = (json.arms ?? {}) as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [name, arm] of Object.entries(arms)) {
          const a = (arm ?? {}) as Record<string, unknown>;
          const mm = (a.metrics ?? {}) as Record<string, unknown>;
          const ndcg = (mm.ndcg ?? {}) as Record<string, unknown>;
          const recall = (mm.recall ?? {}) as Record<string, unknown>;
          const lat = (a.latency_ms ?? {}) as Record<string, unknown>;
          const failures = (a.parse_failures ?? null) as number | null;
          out[name] = {
            map: mm.map ?? null,
            ndcg10: ndcg['10'] ?? null,
            recall100: recall['100'] ?? null,
            avgMs: lat.avg ?? null,
            p95Ms: lat.p95 ?? null,
            parseFailures: typeof failures === 'number' ? failures : null,
          };
        }
        const gitObj = (json.git ?? {}) as Record<string, unknown>;
        const config = (json.config ?? {}) as Record<string, unknown>;
        const querySet = (json.query_set ?? {}) as Record<string, unknown>;
        return {
          file,
          kind: typeof json.kind === 'string' ? json.kind : 'fuzzy-typo-benchmark',
          timestamp: typeof json.timestamp === 'string' ? json.timestamp : null,
          gitSha: typeof gitObj.sha === 'string' ? gitObj.sha : null,
          strategy: typeof config.strategy === 'string' ? config.strategy : null,
          maxEdits:
            typeof (config.fuzzy as Record<string, unknown> | undefined)?.maxEdits === 'number'
              ? ((config.fuzzy as Record<string, unknown>).maxEdits as number)
              : null,
          judgedQueries:
            typeof querySet.judged_queries === 'number' ? querySet.judged_queries : null,
          correctionsSample: Array.isArray(json.corrections)
            ? (json.corrections as { token?: string; corrupted?: string }[])
                .slice(0, 5)
                .map((c) => ({ token: c.token ?? '', corrupted: c.corrupted ?? '' }))
            : [],
          arms: out,
        };
      },
    );

    const queryBenches = this.readJsonDir(
      path.join(this.cfg.root, 'benchmarks', 'results'),
      (file, json) => {
        if (!file.endsWith('-query-benchmark.json')) return null;
        const stagesRaw = json.stages ?? json.results ?? null;
        const stages: unknown[] = Array.isArray(stagesRaw)
          ? stagesRaw
          : typeof stagesRaw === 'object' && stagesRaw !== null
            ? Object.entries(stagesRaw as Record<string, unknown>).map(([stage, v]) => ({
                stage,
                ...(typeof v === 'object' && v !== null ? v : { avg: v }),
              }))
            : [];
        const gitObj = (json.git ?? {}) as Record<string, unknown>;
        const config = (json.config ?? {}) as Record<string, unknown>;
        const failures = (json.parse_failures ?? {}) as Record<string, unknown>;
        const fuzzyExpansion = (json.fuzzy_expansion ?? null) as
          | Record<string, { termsExpanded?: number; variantsAdded?: number; queriesExpanded?: number }>
          | null;
        const linkGraph = (json.link_graph ?? null) as Record<string, unknown> | null;
        return {
          file,
          kind: typeof json.kind === 'string' ? json.kind : 'query-latency',
          timestamp: typeof json.timestamp === 'string' ? json.timestamp : null,
          gitSha: typeof gitObj.sha === 'string' ? gitObj.sha : null,
          corpus: typeof config.corpus === 'string' ? config.corpus : null,
          queries: typeof config.queries === 'number' ? config.queries : null,
          topk: typeof config.topk === 'number' ? config.topk : null,
          parseFailures: typeof failures.candidates === 'number' ? failures.candidates : null,
          stages,
          fuzzyExpansion:
            fuzzyExpansion === null
              ? null
              : Object.fromEntries(
                  Object.entries(fuzzyExpansion).map(([stage, v]) => [
                    stage,
                    {
                      termsExpanded: v.termsExpanded ?? null,
                      variantsAdded: v.variantsAdded ?? null,
                      queriesExpanded: v.queriesExpanded ?? null,
                    },
                  ]),
                ),
          linkGraph,
        };
      },
    );

    const pagerankRuns = this.readJsonDir(
      path.join(this.cfg.root, 'benchmarks', 'results'),
      (file, json) => {
        if (!file.endsWith('-pagerank.json')) return null;
        const graph = (json.graph ?? {}) as Record<string, unknown>;
        const conv = (json.convergence ?? {}) as Record<string, unknown>;
        const scores = (json.scores ?? null) as Record<string, unknown> | null;
        const top = scores !== null && Array.isArray(scores.top) ? scores.top : null;
        const gitObj = (json.git ?? {}) as Record<string, unknown>;
        const { trace: _trace, ...convRest } = conv;
        void _trace;
        return {
          file,
          kind: typeof json.kind === 'string' ? json.kind : 'pagerank',
          timestamp: typeof json.timestamp === 'string' ? json.timestamp : null,
          gitSha: typeof gitObj.sha === 'string' ? gitObj.sha : null,
          runId: typeof json.runId === 'number' ? json.runId : null,
          graph,
          convergence: convRest,
          sum: scores !== null && typeof scores.sum === 'number' ? scores.sum : null,
          top: top === null ? null : top.slice(0, 5),
        };
      },
    );

    return {
      generatedAt: new Date().toISOString(),
      note: 'Recorded experiments read from committed artifacts — not recomputed.',
      runs,
      fuzzyBenches,
      queryBenches,
      pagerankRuns,
    };
  }

  private readJsonDir(
    dir: string,
    map: (file: string, json: Record<string, unknown>) => unknown,
  ): unknown[] {
    let files: string[];
    try {
      files = fs.readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
    const out: unknown[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<
          string,
          unknown
        >;
        const mapped = map(f, json);
        if (mapped !== null) out.push(mapped);
      } catch {
        // skip unreadable artifact — never fabricate a replacement
      }
    }
    return out;
  }
}
