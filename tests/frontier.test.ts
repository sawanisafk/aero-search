import { describe, expect, it } from 'vitest';
import { Frontier } from '../src/crawler/frontier.js';
import { HostScheduler } from '../src/crawler/politeness.js';

function entry(url: string, depth: number, host = 'x.org') {
  return { url, host, depth };
}

describe('Frontier', () => {
  it('dedupes by normalized URL and reports new additions', () => {
    const f = new Frontier();
    expect(f.add([entry('https://x.org/a', 0), entry('https://x.org/b', 0)])).toBe(2);
    expect(f.add([entry('https://x.org/b', 1), entry('https://x.org/c', 1)])).toBe(1);
    expect(f.size()).toBe(3);
    expect(f.seenCount()).toBe(3);
    expect(f.has('https://x.org/b')).toBe(true);
    expect(f.has('https://x.org/z')).toBe(false);
  });

  it('iterates pending() in BFS order without consuming', () => {
    const f = new Frontier();
    f.add([entry('https://x.org/d0a', 0), entry('https://x.org/d1a', 1), entry('https://x.org/d0b', 0)]);
    f.add([entry('https://x.org/d2', 2), entry('https://x.org/d1b', 1)]);
    expect(f.pending().map((e) => e.url)).toEqual([
      'https://x.org/d0a', 'https://x.org/d0b',
      'https://x.org/d1a', 'https://x.org/d1b',
      'https://x.org/d2',
    ]);
    expect(f.size()).toBe(5);
  });

  it('removes taken entries and keeps seen-set semantics afterwards', () => {
    const f = new Frontier();
    f.add([entry('https://x.org/a', 0)]);
    expect(f.remove('https://x.org/a')).toBe(true);
    expect(f.size()).toBe(0);
    expect(f.remove('https://x.org/a')).toBe(false);
    // Even after removal the URL stays "seen" — it must not be re-added.
    expect(f.add([entry('https://x.org/a', 1)])).toBe(0);
    expect(f.size()).toBe(0);
  });

  it('keeps entries from different hosts interleaved by depth only', () => {
    const f = new Frontier();
    f.add([entry('https://a.org/1', 0, 'a.org'), entry('https://b.org/1', 0, 'b.org')]);
    expect(f.pending().map((e) => e.host)).toEqual(['a.org', 'b.org']);
  });
});

describe('HostScheduler', () => {
  const host = 'x.org';

  it('allows the first fetch immediately', () => {
    const s = new HostScheduler(1000);
    expect(s.isDue(host, 0)).toBe(true);
    expect(s.msUntilDue(host, 0)).toBe(0);
  });

  it('gates subsequent fetches on the per-host delay', () => {
    const s = new HostScheduler(1000);
    s.markFetched(host, 1_000);
    expect(s.isDue(host, 1_500)).toBe(false);
    expect(s.msUntilDue(host, 1_500)).toBe(500);
    expect(s.isDue(host, 2_000)).toBe(true);
    expect(s.msUntilDue(host, 2_500)).toBe(0);
  });

  it('tracks hosts independently', () => {
    const s = new HostScheduler(1000);
    s.markFetched('a.org', 0);
    expect(s.isDue('b.org', 1)).toBe(true);
    expect(s.isDue('a.org', 1)).toBe(false);
  });

  it('applies robots crawl-delay overrides', () => {
    const s = new HostScheduler(1000);
    s.setDelay(host, 50);
    s.markFetched(host, 0);
    expect(s.msUntilDue(host, 40)).toBe(10);
    expect(s.isDue(host, 50)).toBe(true);
    expect(s.delayFor(host)).toBe(50);
    expect(s.delayFor('other.org')).toBe(1000);
  });

  it('rejects negative default delays', () => {
    expect(() => new HostScheduler(-1)).toThrow();
  });
});
