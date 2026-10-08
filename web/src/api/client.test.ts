/**
 * Client contract tests — URL construction and the single error path
 * (server envelope → ApiError, network → NETWORK, non-JSON → BAD_RESPONSE).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, documentPath, searchPath } from './client';

function fakeRes(ok: boolean, status: number, text: string, statusText = ''): Response {
  return { ok, status, statusText, text: async () => text } as unknown as Response;
}

function jsonRes(body: unknown, status = 200): Response {
  return fakeRes(status >= 200 && status < 300, status, JSON.stringify(body));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchPath', () => {
  it('serializes every parameter in order', () => {
    expect(
      searchPath({
        q: 'stem cells',
        k: 10,
        page: 2,
        strategy: 'bm25',
        corpus: 'scifact',
        fuzzy: false,
        fuzzyEdits: 1,
        implicit: 'and',
      }),
    ).toBe(
      '/api/search?q=stem+cells&k=10&page=2&strategy=bm25&corpus=scifact&fuzzy=false&fuzzyEdits=1&implicit=and',
    );
  });

  it('omits optional parameters that are undefined', () => {
    expect(searchPath({ q: 'x' })).toBe('/api/search?q=x');
  });
});

describe('documentPath', () => {
  it('encodes corpus and document ids', () => {
    expect(documentPath('static-v1', 'page #1')).toBe('/api/documents/static-v1/page%20%231');
  });

  it('appends q only when non-empty', () => {
    expect(documentPath('c', '7', { q: 'a b' })).toBe('/api/documents/c/7?q=a+b');
    expect(documentPath('c', '7', { q: '' })).toBe('/api/documents/c/7');
    expect(documentPath('c', '7')).toBe('/api/documents/c/7');
  });
});

describe('error path', () => {
  it('maps the server error envelope to ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonRes({ error: { code: 'VALIDATION', message: 'q is required' } }, 400),
      ),
    );
    const e = await api.search({ q: 'x' }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 400, code: 'VALIDATION', message: 'q is required' });
  });

  it('wraps network failures as NETWORK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const e = await api.health().catch((err: unknown) => err);
    expect(e).toMatchObject({ status: 0, code: 'NETWORK' });
  });

  it('rejects non-JSON bodies as BAD_RESPONSE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(true, 200, '<html>nope</html>')));
    const e = await api.health().catch((err: unknown) => err);
    expect(e).toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('rejects empty 2xx bodies as BAD_RESPONSE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(true, 200, '')));
    const e = await api.health().catch((err: unknown) => err);
    expect(e).toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('passes through successful JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonRes({ status: 'ok', version: '0.1.0', uptimeMs: 1, corpora: [], loadedCorpora: [], searches: 0 }),
      ),
    );
    await expect(api.health()).resolves.toMatchObject({ status: 'ok', version: '0.1.0' });
  });

  it('falls back to the HTTP status when the envelope is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ nope: true }, 503)));
    const e = await api.config().catch((err: unknown) => err);
    expect(e).toMatchObject({ status: 503, code: 'HTTP_ERROR' });
  });
});
