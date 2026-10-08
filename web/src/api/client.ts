/**
 * Typed fetch client for the Aero Search API.
 *
 * WHAT: one function per endpoint, URL construction with encoding, and a
 *   single error path: every non-2xx response becomes ApiError carrying the
 *   server's { code, message } envelope (see src/api/app.ts).
 * FAILURES: network errors and non-JSON responses become ApiError with
 *   code 'NETWORK' / 'BAD_RESPONSE' so the UI never crashes on a shape it
 *   does not understand.
 */

import type {
  BenchmarksResponse,
  ConfigResponse,
  DocDetail,
  HealthResponse,
  SearchResponse,
  StatsResponse,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { accept: 'application/json' } });
  } catch {
    throw new ApiError(0, 'NETWORK', 'cannot reach the Aero Search API — is npm run api running?');
  }
  let body: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, 'BAD_RESPONSE', `unexpected response from ${path}`);
    }
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? `${res.status} ${res.statusText}`,
    );
  }
  if (body === null) {
    throw new ApiError(res.status, 'BAD_RESPONSE', `empty response from ${path}`);
  }
  return body as T;
}

export interface SearchQuery {
  readonly q: string;
  readonly k?: number;
  readonly page?: number;
  readonly strategy?: string;
  readonly corpus?: string;
  readonly fuzzy?: boolean;
  readonly fuzzyEdits?: 1 | 2;
  readonly implicit?: 'and' | 'or';
}

export function searchPath(params: SearchQuery): string {
  const qs = new URLSearchParams();
  qs.set('q', params.q);
  if (params.k !== undefined) qs.set('k', String(params.k));
  if (params.page !== undefined) qs.set('page', String(params.page));
  if (params.strategy !== undefined) qs.set('strategy', params.strategy);
  if (params.corpus !== undefined) qs.set('corpus', params.corpus);
  if (params.fuzzy !== undefined) qs.set('fuzzy', String(params.fuzzy));
  if (params.fuzzyEdits !== undefined) qs.set('fuzzyEdits', String(params.fuzzyEdits));
  if (params.implicit !== undefined) qs.set('implicit', params.implicit);
  return `/api/search?${qs.toString()}`;
}

export function documentPath(corpus: string, id: string, opts: { q?: string } = {}): string {
  const base = `/api/documents/${encodeURIComponent(corpus)}/${encodeURIComponent(id)}`;
  if (opts.q === undefined || opts.q.length === 0) return base;
  const qs = new URLSearchParams({ q: opts.q });
  return `${base}?${qs.toString()}`;
}

export const api = {
  health: (): Promise<HealthResponse> => getJson<HealthResponse>('/health'),
  search: (params: SearchQuery): Promise<SearchResponse> =>
    getJson<SearchResponse>(searchPath(params)),
  document: (corpus: string, id: string, opts: { q?: string } = {}): Promise<DocDetail> =>
    getJson<DocDetail>(documentPath(corpus, id, opts)),
  stats: (corpus?: string): Promise<StatsResponse> =>
    getJson<StatsResponse>(
      corpus === undefined ? '/api/stats' : `/api/stats?corpus=${encodeURIComponent(corpus)}`,
    ),
  config: (): Promise<ConfigResponse> => getJson<ConfigResponse>('/api/config'),
  benchmarks: (): Promise<BenchmarksResponse> => getJson<BenchmarksResponse>('/api/benchmarks'),
};
