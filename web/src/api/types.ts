/**
 * Response types — the browser-side mirror of the API contract defined in
 * src/api/search-service.ts. Kept in sync by the contract tests in
 * tests/api.test.ts (server) and src/api/client.test.ts (this client).
 */

export interface SnippetHighlight {
  readonly start: number;
  readonly end: number;
  readonly term: string;
}

export interface Snippet {
  readonly text: string;
  readonly highlights: readonly SnippetHighlight[];
  readonly matched: boolean;
  readonly sourceStart: number;
}

export interface SearchHit {
  readonly rank: number;
  readonly docId: string;
  readonly title: string;
  readonly url: string | null;
  readonly source: string;
  readonly snippet: Snippet | null;
  readonly score: number;
  readonly signals: Readonly<Record<string, number>>;
}

export interface FuzzyExpansion {
  readonly term: string;
  readonly variants: readonly string[];
  readonly distance: 1 | 2;
}

export interface SearchMeta {
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
  readonly fuzzy: {
    readonly applied: boolean;
    readonly edits: 1 | 2;
    readonly expansions: readonly FuzzyExpansion[];
    readonly stats: {
      readonly termsAttempted: number;
      readonly termsExpanded: number;
      readonly variantsAdded: number;
      readonly caps: Readonly<Record<string, number>>;
    } | null;
  };
  readonly strategyDetail: {
    readonly id: string;
    readonly engineId: string;
    readonly mode: string;
    readonly params: Readonly<Record<string, number | string>>;
  };
  readonly diagnostics: {
    readonly implicitOperator: 'and' | 'or';
    readonly parsed: unknown;
    readonly analyzedTerms: readonly string[];
    readonly positiveTerms: readonly string[];
    readonly candidates: number;
  };
}

export interface SearchResponse {
  readonly query: string;
  readonly strategy: string;
  readonly results: readonly SearchHit[];
  readonly meta: SearchMeta;
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
  readonly matchedTerms: readonly { term: string; tf: number; df: number }[] | null;
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
  readonly pagerank: {
    readonly available: boolean;
    readonly source?: string;
    readonly nodes?: number;
    readonly edges?: number;
    readonly iterations?: number;
    readonly residual?: number;
    readonly converged?: boolean;
    readonly damping?: number;
    readonly graphHash?: string;
  };
  readonly strategies: readonly {
    readonly id: string;
    readonly label: string;
    readonly mode: string;
    readonly available: boolean;
    readonly reason?: string;
  }[];
  readonly fuzzy: {
    readonly supported: true;
    readonly defaults: Readonly<Record<string, number>>;
  };
  readonly crawl: Readonly<Record<string, unknown>> | null;
  readonly search: {
    readonly total: number;
    readonly recent: { readonly count: number; readonly avgMs: number; readonly p95Ms: number };
  };
}

export interface StrategyConfig {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly reason?: string;
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
  readonly strategies: readonly StrategyConfig[];
  readonly fuzzyDefaults: Readonly<Record<string, number>>;
}

export interface HealthResponse {
  readonly status: 'ok';
  readonly version: string;
  readonly uptimeMs: number;
  readonly corpora: readonly string[];
  readonly loadedCorpora: readonly string[];
  readonly searches: number;
}

export interface QualityRun {
  readonly file: string;
  readonly experimentId: string | null;
  readonly timestamp: string | null;
  readonly gitSha: string | null;
  readonly corpus: string | null;
  readonly strategy: string | null;
  readonly mode: string | null;
  readonly params: Readonly<Record<string, number | string>>;
  readonly evaluatedQueries: number | null;
  readonly map: number;
  readonly ndcg10: number | null;
  readonly recall100: number | null;
  readonly latencyAvgMs: number | null;
  readonly fuzzy: boolean;
}

export interface FuzzyBench {
  readonly file: string;
  readonly timestamp: string | null;
  readonly gitSha: string | null;
  readonly strategy: string | null;
  readonly maxEdits: number | null;
  readonly judgedQueries: number | null;
  readonly correctionsSample: readonly { token: string; corrupted: string }[];
  readonly arms: Readonly<
    Record<
      string,
      {
        map: number | null;
        ndcg10: number | null;
        recall100: number | null;
        avgMs: number | null;
        p95Ms: number | null;
        parseFailures: number | null;
      }
    >
  >;
}

export interface QueryBench {
  readonly file: string;
  readonly kind: string;
  readonly timestamp: string | null;
  readonly gitSha: string | null;
  readonly corpus: string | null;
  readonly queries: number | null;
  readonly topk: number | null;
  readonly parseFailures: number | null;
  readonly stages: readonly {
    readonly stage: string;
    readonly count?: number;
    readonly avg?: number;
    readonly median?: number;
    readonly p95?: number;
    readonly max?: number;
  }[];
}

export interface PagerankRun {
  readonly file: string;
  readonly timestamp: string | null;
  readonly gitSha: string | null;
  readonly runId: number | null;
  readonly graph: Readonly<Record<string, unknown>>;
  readonly convergence: Readonly<Record<string, unknown>>;
  readonly sum: number | null;
  readonly top: readonly { readonly url: string; readonly value: number }[] | null;
}

export interface BenchmarksResponse {
  readonly generatedAt: string;
  readonly note: string;
  readonly runs: readonly QualityRun[];
  readonly fuzzyBenches: readonly FuzzyBench[];
  readonly queryBenches: readonly QueryBench[];
  readonly pagerankRuns: readonly PagerankRun[];
}
