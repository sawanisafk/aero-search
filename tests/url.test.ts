import { describe, expect, it } from 'vitest';
import { isAllowedHost, normalizeUrl, parseAllowlist } from '../src/crawler/url.js';

describe('normalizeUrl', () => {
  it('lowercases scheme and host but preserves path case', () => {
    expect(normalizeUrl('HTTPS://Example.COM/About-Page')).toBe('https://example.com/About-Page');
  });

  it('strips fragments', () => {
    expect(normalizeUrl('https://x.org/a#section-2')).toBe('https://x.org/a');
  });

  it('removes default ports and keeps explicit non-default ports', () => {
    expect(normalizeUrl('https://x.org:443/a')).toBe('https://x.org/a');
    expect(normalizeUrl('http://x.org:80/a')).toBe('http://x.org/a');
    expect(normalizeUrl('http://x.org:8080/a')).toBe('http://x.org:8080/a');
  });

  it('adds the root slash for host-only URLs', () => {
    expect(normalizeUrl('https://x.org')).toBe('https://x.org/');
  });

  it('drops the empty-query marker', () => {
    expect(normalizeUrl('https://x.org/a?')).toBe('https://x.org/a');
  });

  it('sorts query parameters so equivalent queries agree', () => {
    expect(normalizeUrl('https://x.org/s?b=2&a=1')).toBe('https://x.org/s?a=1&b=2');
    expect(normalizeUrl('https://x.org/s?a=1&b=2')).toBe(normalizeUrl('https://x.org/s?b=2&a=1'));
  });

  it('resolves relative URLs against a base', () => {
    expect(normalizeUrl('/about', 'https://x.org/dir/page')).toBe('https://x.org/about');
    expect(normalizeUrl('./sibling', 'https://x.org/dir/page')).toBe('https://x.org/dir/sibling');
    expect(normalizeUrl('//other.org/c', 'https://x.org/dir/page')).toBe('https://other.org/c');
    expect(normalizeUrl('page2', 'https://x.org/dir/page')).toBe('https://x.org/dir/page2');
  });

  it('rejects non-http schemes and unparseable input', () => {
    expect(normalizeUrl('mailto:someone@x.org')).toBeNull();
    expect(normalizeUrl('javascript:void(0)')).toBeNull();
    expect(normalizeUrl('data:text/plain,hi')).toBeNull();
    expect(normalizeUrl('ftp://x.org/f')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('/relative-without-base')).toBeNull();
  });

  it('drops userinfo credentials', () => {
    expect(normalizeUrl('https://user:pass@x.org/a')).toBe('https://x.org/a');
  });

  it('keeps IDN hosts in punycode (URL parser behavior)', () => {
    expect(normalizeUrl('https://bücher.example/')).toBe('https://xn--bcher-kva.example/');
  });
});

describe('isAllowedHost', () => {
  it('matches exact hosts only, case-insensitively', () => {
    expect(isAllowedHost('https://example.org/a', ['example.org'])).toBe(true);
    expect(isAllowedHost('https://EXAMPLE.org/a', ['example.org'])).toBe(true);
    expect(isAllowedHost('https://sub.example.org/a', ['example.org'])).toBe(false);
    expect(isAllowedHost('https://notexample.org/a', ['example.org'])).toBe(false);
  });

  it('matches suffix patterns with subdomains', () => {
    expect(isAllowedHost('https://a.example.org/', ['*.example.org'])).toBe(true);
    expect(isAllowedHost('https://example.org/', ['*.example.org'])).toBe(true);
    expect(isAllowedHost('https://example.org.evil.io/', ['*.example.org'])).toBe(false);
  });

  it('supports the * catch-all and denies when the allowlist is empty', () => {
    expect(isAllowedHost('https://anything.io/', ['*'])).toBe(true);
    expect(isAllowedHost('https://anything.io/', [])).toBe(false);
    expect(isAllowedHost('https://anything.io/', ['', '  '])).toBe(false);
  });
});

describe('parseAllowlist', () => {
  it('splits, trims and drops empties', () => {
    expect(parseAllowlist('a.org, b.org , ,*.c.io')).toEqual(['a.org', 'b.org', '*.c.io']);
    expect(parseAllowlist(undefined)).toEqual([]);
  });
});
