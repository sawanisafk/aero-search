/**
 * HTTP fetching behind the `Fetcher` interface (ADR-007: undici is the only
 * fetcher in v1; a Playwright-based browser fetcher may be added later only
 * if the target corpus is JS-rendered).
 *
 * Manual redirect loop (cap 5) so the chain is recorded as data; network
 * errors retried once with backoff; responses larger than `maxBytes` are
 * aborted mid-stream and surfaced as failures (ARCHITECTURE §7).
 * `accept-encoding: identity` keeps decoding trivial for a controlled crawl.
 */

import { request } from 'undici';

export interface FetchResult {
  status: number;
  /** URL after following redirects (=== requested URL when no redirect). */
  finalUrl: string;
  contentType: string | null;
  body: string;
  bytes: number;
  /** Every URL requested in order; length 1 means no redirect. */
  redirectChain: string[];
}

export interface Fetcher {
  fetch(url: string): Promise<FetchResult>;
}

export interface HttpFetcherOptions {
  userAgent: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Transport-level retries for network errors (HTTP statuses are data, not retried here). */
  retries?: number;
  retryBackoffMs?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function headerValue(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function decodeBody(buf: Buffer, contentType: string | null): string {
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType ?? '')?.[1];
  const enc = (charset ?? 'utf-8').toLowerCase();
  try {
    return new TextDecoder(enc).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

export class HttpFetcher implements Fetcher {
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly retries: number;
  private readonly retryBackoffMs: number;

  constructor(opts: HttpFetcherOptions) {
    this.userAgent = opts.userAgent;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxBytes = opts.maxBytes ?? 1_048_576;
    this.maxRedirects = opts.maxRedirects ?? 5;
    this.retries = opts.retries ?? 1;
    this.retryBackoffMs = opts.retryBackoffMs ?? 200;
  }

  async fetch(url: string): Promise<FetchResult> {
    const visited: string[] = [];
    let current = url;

    for (;;) {
      if (visited.length > this.maxRedirects) {
        throw new Error(`too many redirects (> ${this.maxRedirects}) at ${url}`);
      }
      visited.push(current);
      const res = await this.requestOnce(current);
      // Destroying an unconsumed undici body emits an AbortError on the
      // stream; this noop listener keeps early aborts from surfacing as
      // uncaught exceptions (iteration errors still propagate normally).
      res.body.on('error', () => undefined);

      const location = headerValue(res.headers.location);
      if (REDIRECT_STATUSES.has(res.statusCode) && location !== null) {
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new Error(`invalid redirect location "${location}" from ${current}`);
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new Error(`refusing redirect to non-http scheme: ${next.protocol}`);
        }
        res.body.destroy();
        current = next.toString();
        continue;
      }

      const contentType = headerValue(res.headers['content-type']);
      const contentLength = Number(headerValue(res.headers['content-length']));
      if (Number.isFinite(contentLength) && contentLength > this.maxBytes) {
        res.body.destroy();
        throw new Error(`content-length ${contentLength} exceeds maxBytes ${this.maxBytes}`);
      }

      const chunks: Buffer[] = [];
      let total = 0;
      let exceeded = false;
      for await (const chunk of res.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buf.length;
        if (total > this.maxBytes) {
          exceeded = true;
          break;
        }
        chunks.push(buf);
      }
      res.body.destroy();
      if (exceeded) {
        throw new Error(`body exceeds maxBytes ${this.maxBytes} at ${current}`);
      }

      const buf = Buffer.concat(chunks);
      return {
        status: res.statusCode,
        finalUrl: current,
        contentType,
        body: decodeBody(buf, contentType),
        bytes: total,
        redirectChain: visited,
      };
    }
  }

  private async requestOnce(url: string): Promise<Awaited<ReturnType<typeof request>>> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await request(url, {
          method: 'GET',
          headers: {
            'user-agent': this.userAgent,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-encoding': 'identity',
          },
          headersTimeout: this.timeoutMs,
          bodyTimeout: this.timeoutMs,
        });
      } catch (err) {
        lastError = err;
        if (attempt < this.retries) {
          await new Promise((r) => setTimeout(r, this.retryBackoffMs * (attempt + 1)));
        }
      }
    }
    throw lastError;
  }
}
