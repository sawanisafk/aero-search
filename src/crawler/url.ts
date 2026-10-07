/**
 * URL normalization (ARCHITECTURE §7). Two normalized forms of the same page
 * must be byte-identical so the frontier, the urls table, and document
 * identity all agree on one canonical string.
 *
 * Rules: http/https only; lowercase host; empty query markers and fragments
 * dropped; default ports removed; userinfo dropped; query parameters sorted
 * lexicographically; relative URLs resolved against a base (the fetching
 * page, honoring <base href> at the extraction layer).
 */

export function normalizeUrl(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = base !== undefined ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.hostname === '') return null;

  u.hash = '';
  u.username = '';
  u.password = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }
  u.searchParams.sort();

  const out = u.toString();
  return out.endsWith('?') ? out.slice(0, -1) : out;
}

export function hostOf(normalizedUrl: string): string {
  return new URL(normalizedUrl).hostname;
}

/**
 * Allowlist check: exact host match, `*.suffix` (suffix + subdomains), or
 * `*` (everything). An empty allowlist denies everything — a controlled
 * crawl must name its domains (ADR-006).
 */
export function isAllowedHost(normalizedUrl: string, allowlist: readonly string[]): boolean {
  const host = hostOf(normalizedUrl);
  for (const raw of allowlist) {
    const pattern = raw.trim().toLowerCase();
    if (pattern === '') continue;
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      if (host === suffix || host.endsWith(`.${suffix}`)) return true;
    } else if (host === pattern) {
      return true;
    }
  }
  return false;
}

export function parseAllowlist(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
