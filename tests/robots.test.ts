import { describe, expect, it } from 'vitest';
import {
  crawlDelayFor,
  isAllowed,
  parseRobots,
  robotsForResponse,
} from '../src/crawler/robots.js';

const GOOGLE_STYLE = `
# example robots
User-agent: *
Disallow: /private/
Allow: /private/public-note

User-agent: AeroSearchBot
Disallow: /no-bot/
Allow: /open/
Crawl-delay: 2

Sitemap: https://x.org/sitemap.xml
`;

describe('parseRobots', () => {
  it('parses groups, rules, crawl-delay and sitemaps', () => {
    const r = parseRobots(GOOGLE_STYLE);
    expect(r.groups).toHaveLength(2);
    expect(r.groups[0]?.userAgents).toEqual(['*']);
    expect(r.groups[1]?.userAgents).toEqual(['aerosearchbot']);
    expect(r.groups[1]?.crawlDelay).toBe(2);
    expect(r.sitemaps).toEqual(['https://x.org/sitemap.xml']);
  });

  it('joins consecutive user-agent lines into one group and splits on rules', () => {
    const r = parseRobots('User-agent: a\nUser-agent: b\nDisallow: /\nUser-agent: c\nDisallow: /x');
    expect(r.groups).toHaveLength(2);
    expect(r.groups[0]?.userAgents).toEqual(['a', 'b']);
    expect(r.groups[1]?.userAgents).toEqual(['c']);
  });

  it('strips comments, tolerates CRLF and ignores unknown fields', () => {
    const r = parseRobots('User-agent: bot # comment\r\nWhatever: 1\r\nDisallow: /a # trail\r\n');
    expect(r.groups[0]?.rules).toEqual([{ allow: false, path: '/a' }]);
  });

  it('treats empty directives as no restriction', () => {
    const r = parseRobots('User-agent: *\nDisallow:\nAllow:');
    expect(r.groups[0]?.rules).toEqual([]);
    expect(isAllowed(r, 'anybot', '/anything')).toBe(true);
  });

  it('handles rules appearing before any user-agent line', () => {
    const r = parseRobots('Disallow: /early');
    expect(r.groups).toHaveLength(1);
    expect(isAllowed(r, 'anybot', '/early/page')).toBe(false);
    expect(isAllowed(r, 'anybot', '/late')).toBe(true);
  });
});

describe('isAllowed', () => {
  it('selects the most specific matching group', () => {
    const r = parseRobots(GOOGLE_STYLE);
    expect(isAllowed(r, 'AeroSearchBot/0.1', '/no-bot/page')).toBe(false);
    expect(isAllowed(r, 'AeroSearchBot/0.1', '/anything-else')).toBe(true);
    // The * group's rules must not leak into the specific group's decision.
    expect(isAllowed(r, 'AeroSearchBot/0.1', '/private/x')).toBe(true);
    expect(isAllowed(r, 'OtherBot/2.0', '/private/x')).toBe(false);
    expect(isAllowed(r, 'OtherBot/2.0', '/no-bot/page')).toBe(true);
  });

  it('applies longest-match rules with allow winning ties', () => {
    const r = parseRobots(
      'User-agent: *\nDisallow: /fish\nAllow: /fish/bones\nDisallow: /fish/bones/tuna',
    );
    expect(isAllowed(r, 'bot', '/fish')).toBe(false);
    expect(isAllowed(r, 'bot', '/fish/bones')).toBe(true);
    expect(isAllowed(r, 'bot', '/fish/bones/tuna')).toBe(false);
    expect(isAllowed(r, 'bot', '/salmon')).toBe(true);
  });

  it('supports * wildcards and $ end anchors', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*/private$\nDisallow: /tmp*');
    expect(isAllowed(r, 'bot', '/a/private')).toBe(false);
    expect(isAllowed(r, 'bot', '/a/private/deeper')).toBe(true);
    expect(isAllowed(r, 'bot', '/tmp')).toBe(false);
    expect(isAllowed(r, 'bot', '/tmp/dir/file')).toBe(false);
    expect(isAllowed(r, 'bot', '/atmp')).toBe(true);
  });

  it('allows everything when no group matches', () => {
    const r = parseRobots('User-agent: SomeOtherBot\nDisallow: /');
    expect(isAllowed(r, 'AeroSearchBot', '/anything')).toBe(true);
  });

  it('matches anonymous groups (rules with no agent) for every crawler', () => {
    const r = parseRobots('User-agent:\nDisallow: /blocked');
    expect(isAllowed(r, 'anything', '/blocked')).toBe(false);
    expect(isAllowed(r, 'anything', '/open')).toBe(true);
  });
});

describe('crawlDelayFor', () => {
  it('returns the delay of the best matching group', () => {
    const r = parseRobots(GOOGLE_STYLE);
    expect(crawlDelayFor(r, 'AeroSearchBot/0.1')).toBe(2);
    expect(crawlDelayFor(r, 'OtherBot')).toBeNull();
  });
});

describe('robotsForResponse (RFC 9309 §2.3)', () => {
  it('parses 200 responses', () => {
    const r = robotsForResponse(200, 'User-agent: *\nDisallow: /x');
    expect(isAllowed(r, 'bot', '/x')).toBe(false);
  });

  it('404/410 and other 4xx mean allow all', () => {
    for (const status of [404, 410, 400]) {
      const r = robotsForResponse(status, null);
      expect(isAllowed(r, 'bot', '/anything'), `status ${status}`).toBe(true);
    }
  });

  it('401/403 mean disallow all', () => {
    for (const status of [401, 403]) {
      const r = robotsForResponse(status, null);
      expect(isAllowed(r, 'bot', '/anything'), `status ${status}`).toBe(false);
    }
  });

  it('429 means hold (disallow until retried)', () => {
    expect(isAllowed(robotsForResponse(429, null), 'bot', '/x')).toBe(false);
  });

  it('5xx means allow (no restrictions known)', () => {
    expect(isAllowed(robotsForResponse(503, null), 'bot', '/x')).toBe(true);
  });
});
