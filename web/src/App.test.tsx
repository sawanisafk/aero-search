/**
 * Desktop behavior tests — window manager, search rendering, evaluation
 * numbers, document open, status cards. All API traffic is stubbed.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

function res(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const CONFIG = {
  version: '0.1.0',
  defaultCorpus: 'scifact',
  defaultStrategy: 'bm25',
  defaultK: 10,
  maxK: 50,
  maxPage: 50,
  implicitOperator: 'or',
  corpora: ['scifact', 'static-v1', 'crawled'],
  strategies: [
    { id: 'bm25', label: 'BM25', available: true },
    { id: 'bm25-pr', label: 'BM25 + PageRank', available: false, reason: 'no PageRank for this corpus' },
  ],
  fuzzyDefaults: { maxEdits: 2, maxExpansionsPerQuery: 8 },
};

const SEARCH = {
  query: 'stem cells',
  strategy: 'bm25',
  results: [
    {
      rank: 1,
      docId: '42',
      title: 'Stem cell therapy results',
      url: null,
      source: 'scifact',
      snippet: {
        text: 'Stem cells regenerate tissue.',
        highlights: [{ start: 0, end: 5, term: 'stem' }],
        matched: true,
        sourceStart: 0,
      },
      score: 1.2345,
      signals: { bm25: 1.1, phrase: 0.13 },
    },
  ],
  meta: {
    corpus: 'scifact',
    k: 10,
    page: 1,
    totalPages: 1,
    totalCandidates: 12,
    returned: 1,
    latencyMs: 3.21,
    timing: { parseMs: 0.1, analyzeMs: 0.2, retrieveMs: 2.0, rankMs: 0.9 },
    fuzzyApplied: false,
    expandedTerms: [],
    fuzzy: { applied: false, edits: 1, expansions: [], stats: null },
    strategyDetail: { id: 'bm25', engineId: 'bm25-k1.2-b0.75', mode: 'A', params: { k1: 1.2 } },
    diagnostics: {
      implicitOperator: 'or',
      parsed: { terms: ['stem', 'cell'] },
      analyzedTerms: ['stem', 'cell'],
      positiveTerms: ['stem', 'cell'],
      candidates: 12,
    },
  },
};

const BENCH = {
  generatedAt: '2026-10-08T00:00:00.000Z',
  note: 'Recorded experiments read from committed artifacts — not recomputed.',
  runs: [
    {
      file: 'm3-bm25.json',
      experimentId: 'm3-bm25',
      timestamp: '2026-05-01T10:00:00.000Z',
      gitSha: 'f3bfedaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      corpus: 'scifact',
      strategy: 'bm25-k1.2-b0.75',
      mode: 'A',
      params: { k1: 1.2, b: 0.75 },
      evaluatedQueries: 1000,
      map: 0.6436,
      ndcg10: 0.687552,
      recall100: 0.91,
      latencyAvgMs: 12.3,
      fuzzy: false,
    },
  ],
  fuzzyBenches: [],
  queryBenches: [],
  pagerankRuns: [],
};

const STATS = {
  version: '0.1.0',
  node: 'v24.13.0',
  uptimeMs: 60000,
  corpus: {
    name: 'scifact',
    numDocs: 5183,
    vocabSize: 26299,
    numPostings: 1940000,
    totalTokens: 3200000,
    avgDocLength: 617.4,
    indexBytes: 4200000,
    corpusHash: 'abc123def456abc123def456abc123de',
    metadataStore: 'corpus.jsonl',
  },
  corpora: [{ name: 'scifact', indexBytes: 4200000 }],
  pagerank: {
    available: true,
    source: 'citation-graph:scifact',
    nodes: 5183,
    edges: 2015,
    iterations: 41,
    residual: 8.5e-7,
    converged: true,
    damping: 0.85,
    graphHash: 'a'.repeat(64),
  },
  strategies: [
    { id: 'bm25', label: 'BM25', mode: 'A', available: true },
    { id: 'bm25-pr', label: 'BM25 + PageRank', mode: 'D', available: false, reason: 'no PageRank' },
  ],
  fuzzy: { supported: true, defaults: { maxEdits: 2 } },
  crawl: null,
  search: { total: 3, recent: { count: 3, avgMs: 4.2, p95Ms: 9.9 } },
};

const DOC = {
  corpus: 'scifact',
  docId: 42,
  id: '42',
  title: 'Stem cell therapy results',
  url: null,
  source: 'scifact',
  text: 'Stem cells regenerate tissue in damaged organs.',
  textTruncated: false,
  pagerank: 0.000161,
  matchedTerms: [
    { term: 'stem', tf: 3, df: 120 },
    { term: 'cell', tf: 5, df: 300 },
  ],
  phrases: [{ terms: ['stem', 'cell'], matched: true }],
};

function installFetch(search: unknown = SEARCH): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/search')) return res(search);
    if (url.startsWith('/api/config')) return res(CONFIG);
    if (url.startsWith('/api/benchmarks')) return res(BENCH);
    if (url.startsWith('/api/stats')) return res(STATS);
    if (url.startsWith('/api/documents/')) return res(DOC);
    if (url.startsWith('/health')) {
      return res({ status: 'ok', version: '0.1.0', uptimeMs: 1, corpora: [], loadedCorpora: [], searches: 0 });
    }
    return res({ error: { code: 'NOT_FOUND', message: `no route for ${url}` } }, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A zero-result search response with the given query shape (for empty-state diagnosis). */
function emptySearch(spec: {
  query: string;
  implicit: 'and' | 'or';
  positive: readonly string[];
  analyzed?: readonly string[];
  fuzzyApplied?: boolean;
}): unknown {
  const analyzed = spec.analyzed ?? spec.positive;
  return {
    ...SEARCH,
    query: spec.query,
    results: [],
    meta: {
      ...SEARCH.meta,
      totalCandidates: 0,
      returned: 0,
      fuzzyApplied: spec.fuzzyApplied ?? false,
      diagnostics: {
        ...SEARCH.meta.diagnostics,
        implicitOperator: spec.implicit,
        analyzedTerms: [...analyzed],
        positiveTerms: [...spec.positive],
        candidates: 0,
      },
    },
  };
}

describe('Aero desktop', () => {
  it('boots with a search window and renders ranked results', async () => {
    installFetch();
    const { container } = render(<App />);

    expect(container.querySelector('.aero-window')).not.toBeNull();
    expect(screen.getByLabelText('Aero Search')).toBeInTheDocument();

    // demo query results arrive
    expect(await screen.findByText('Stem cell therapy results')).toBeInTheDocument();
    expect(screen.getByText(/shown \/ 12 candidates/)).toBeInTheDocument();
    // strategy engine id is surfaced in the status line
    expect(screen.getAllByText('bm25-k1.2-b0.75').length).toBeGreaterThan(0);
    // matched term highlighting in the snippet
    expect(container.querySelectorAll('.result-snippet .hl')).toHaveLength(1);
  });

  it('opens the Evaluation window from the desktop icon with locked numbers', async () => {
    installFetch();
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText('Stem cell therapy results');
    await user.click(screen.getByText('Evaluation'));

    expect(await screen.findByText(/not recomputed/)).toBeInTheDocument();
    expect(screen.getByText('0.6436')).toBeInTheDocument();
    expect(screen.getAllByText('bm25-k1.2-b0.75').length).toBeGreaterThan(0);
  });

  it('opens a document window from a result', async () => {
    installFetch();
    const user = userEvent.setup();
    const { container } = render(<App />);

    await screen.findByText('Stem cell therapy results');
    await user.click(screen.getByRole('button', { name: 'details' }));

    expect(await screen.findByRole('heading', { name: 'Stem cell therapy results' })).toBeInTheDocument();
    expect(screen.getByText(/damaged organs/)).toBeInTheDocument();
    expect(screen.getByText('"stem cell" ✓')).toBeInTheDocument();
    expect(container.querySelector('.term-table')).not.toBeNull();
  });

  it('shows live system status cards', async () => {
    installFetch();
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText('Stem cell therapy results');
    await user.click(screen.getByText('System Status'));

    expect(await screen.findByText('index · scifact')).toBeInTheDocument();
    expect(screen.getByText('citation-graph:scifact')).toBeInTheDocument();
    expect(screen.getByText('5,183')).toBeInTheDocument();
  });

  it('minimizes via the title bar and restores from the taskbar', async () => {
    installFetch();
    const user = userEvent.setup();
    const { container } = render(<App />);

    await screen.findByText('Stem cell therapy results');
    expect(container.querySelectorAll('.aero-window')).toHaveLength(1);

    await user.click(screen.getByLabelText('Minimize Aero Search'));
    await waitFor(() => {
      expect(container.querySelector('.aero-window')).toBeNull();
    });

    const taskbarBtn = [...container.querySelectorAll<HTMLElement>('.taskbar-btn')].find((b) =>
      b.textContent?.includes('Aero Search'),
    );
    expect(taskbarBtn).toBeDefined();
    await user.click(taskbarBtn!);

    await waitFor(() => {
      expect(container.querySelector('.aero-window')).not.toBeNull();
    });
    expect(await screen.findByText('Stem cell therapy results')).toBeInTheDocument();
  });

  it('explains implicit-AND overreach on an empty search', async () => {
    installFetch(
      emptySearch({
        query: 'stem cells can differentiate into many cell types',
        implicit: 'and',
        positive: ['stem', 'cell', 'differenti', 'mani', 'type'],
      }),
    );
    render(<App />);

    expect(await screen.findByText(/Implicit AND requires all 5 content terms/)).toBeInTheDocument();
    expect(screen.getByText(/switch implicit to OR/)).toBeInTheDocument();
    // the diagnosis also shows what the query actually analyzed to
    expect(screen.getByText(/stem, cell, differenti, mani, type/)).toBeInTheDocument();
  });

  it('explains a quoted exact-phrase search on an empty result', async () => {
    installFetch(
      emptySearch({
        query: '"neural network transformers"',
        implicit: 'or',
        positive: ['neural', 'network', 'transform'],
      }),
    );
    render(<App />);

    expect(await screen.findByText(/exact-phrase search/)).toBeInTheDocument();
    expect(screen.getByText(/Remove the quotes/)).toBeInTheDocument();
  });

  it('explains all-stop-word queries', async () => {
    installFetch(emptySearch({ query: 'what is it', implicit: 'or', positive: [], analyzed: [] }));
    render(<App />);

    expect(await screen.findByText(/Every word was a stop word/)).toBeInTheDocument();
  });

  it('suggests fuzzy only when it can actually help (absent terms)', async () => {
    installFetch(emptySearch({ query: 'wonderlan', implicit: 'or', positive: ['wonderlan'] }));
    render(<App />);

    expect(await screen.findByText(/No indexed document contains these terms/)).toBeInTheDocument();
    expect(screen.getByText(/enable fuzzy recovery/)).toBeInTheDocument();
  });
});
