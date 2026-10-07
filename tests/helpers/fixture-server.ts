import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Shared loopback fixture site for crawler tests — a tiny multi-page world
 * with robots.txt, a redirect, a duplicate pair, a non-HTML response, a
 * 404, an oversize response and an off-allowlist link.
 */

export const USER_AGENT = 'AeroSearchBot-Test/0.1';

export const HOME = `<!doctype html><html><head><title>Home</title></head><body>
  <h1>Fixture home</h1><p>Welcome to the fixture site used by crawler tests.</p>
  <a href="/page-a">A</a>
  <a href="/page-a#again">A again</a>
  <a href="/page-b">B</a>
  <a href="/blocked">Blocked</a>
  <a href="/plain.txt">Plain</a>
  <a href="/redirect">Redirect</a>
  <a href="/missing">Missing</a>
  <a href="/big">Big</a>
  <a href="http://outside.invalid/x">External</a>
  <a href="#self">Self</a>
</body></html>`;

export const SAME_BODY =
  '<h1>Same</h1><p>Identical body text for duplicate detection across two urls.</p>';

export const PAGE_A = `<!doctype html><html><head><title>Page A</title></head><body>${SAME_BODY}
  <a href="/page-c">Deeper</a>
</body></html>`;

export const PAGE_B = `<!doctype html><html><head><title>Page B (other title)</title></head><body>${SAME_BODY}
  <a href="/page-c">Deeper</a>
</body></html>`;

export const ROBOTS = 'User-agent: *\nDisallow: /blocked\n';

export interface FixtureServer {
  base: string;
  hits: string[];
  close(): Promise<void>;
}

function route(url: string, res: http.ServerResponse, hits: string[]): void {
  hits.push(url);
  const send = (status: number, type: string, body: string): void => {
    res.writeHead(status, { 'content-type': type, 'content-length': String(Buffer.byteLength(body)) });
    res.end(body);
  };
  switch (url) {
    case '/':
      send(200, 'text/html; charset=utf-8', HOME);
      return;
    case '/robots.txt':
      send(200, 'text/plain; charset=utf-8', ROBOTS);
      return;
    case '/page-a':
      send(200, 'text/html; charset=utf-8', PAGE_A);
      return;
    case '/page-b':
      send(200, 'text/html; charset=utf-8', PAGE_B);
      return;
    case '/redirect':
      res.writeHead(302, { location: '/page-a' });
      res.end();
      return;
    case '/plain.txt':
      send(200, 'text/plain; charset=utf-8', 'plain text here');
      return;
    case '/blocked':
      send(200, 'text/html; charset=utf-8', '<html><body>should never be fetched</body></html>');
      return;
    case '/big': {
      const body = Buffer.alloc(100_000, 0x61); // content-length exceeds fetcher cap
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    case '/missing':
    default:
      send(404, 'text/html; charset=utf-8', '<html><body>nope</body></html>');
      return;
  }
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => route(req.url ?? '/', res, hits));
  server.on('error', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
