/**
 * Minimal robots.txt implementation following RFC 9309 semantics
 * (ARCHITECTURE §7: "tiny own parser; the engineering point is that it is
 * respected and decisions are logged").
 *
 * Covered: group selection by longest matching user-agent token; path rules
 * with `*` wildcards and `$` end-anchors; longest-match wins, allow wins
 * ties; crawl-delay; sitemap collection; response-status semantics
 * (404/410 → allow all, 401/403 → disallow all, 429 → disallow all,
 * 5xx → allow all).
 */

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsGroup {
  userAgents: string[];
  rules: RobotsRule[];
  crawlDelay: number | null;
}

export interface RobotsRules {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export const ALLOW_ALL: RobotsRules = { groups: [], sitemaps: [] };

export const DISALLOW_ALL: RobotsRules = {
  groups: [{ userAgents: ['*'], rules: [{ allow: false, path: '/' }], crawlDelay: null }],
  sitemaps: [],
};

export function parseRobots(text: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!lastWasAgent || current === null) {
        current = { userAgents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.userAgents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      if (current === null) {
        // Rules before any user-agent line: apply them to every crawler
        // (conservative politeness — a leading Disallow must not be ignored).
        current = { userAgents: ['*'], rules: [], crawlDelay: null };
        groups.push(current);
      }
      // Empty directives carry no restriction ("Disallow:" = allow everything).
      if (value !== '') {
        current.rules.push({ allow: field === 'allow', path: value });
      }
      lastWasAgent = false;
    } else if (field === 'crawl-delay') {
      if (current !== null) {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
      }
      lastWasAgent = false;
    } else if (field === 'sitemap' && value !== '') {
      sitemaps.push(value);
      // Sitemap lines are global; they do not split agent groups.
    }
    // Unknown fields are ignored per RFC 9309.
  }

  return { groups, sitemaps };
}

/**
 * Group whose user-agent token matches the given UA most specifically
 * (longest token wins; `*` and the anonymous group score 0; null = no group
 * matches).
 */
function bestGroupFor(rules: RobotsRules, userAgent: string): RobotsGroup | null {
  const ua = userAgent.toLowerCase();
  let best: RobotsGroup | null = null;
  let bestScore = -1;
  for (const group of rules.groups) {
    let score = -1;
    for (const token of group.userAgents) {
      if (token === '') {
        score = Math.max(score, 0);
      } else if (token === '*') {
        score = Math.max(score, 0);
      } else if (ua.includes(token)) {
        score = Math.max(score, token.length);
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = group;
    }
  }
  return bestScore >= 0 ? best : null;
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const re = new RegExp(`^${source}${anchored ? '$' : ''}`);
  return re.test(path);
}

export function isAllowed(rules: RobotsRules, userAgent: string, path: string): boolean {
  const group = bestGroupFor(rules, userAgent);
  if (group === null) return true;

  let winner: RobotsRule | null = null;
  let winnerLen = -1;
  for (const rule of group.rules) {
    if (!matches(rule.path, path)) continue;
    if (winner === null) {
      winner = rule;
      winnerLen = rule.path.length;
      continue;
    }
    const len = rule.path.length;
    if (len > winnerLen) {
      winner = rule;
      winnerLen = len;
    } else if (len === winnerLen && rule.allow && !winner.allow) {
      winner = rule;
    }
  }
  return winner === null ? true : winner.allow;
}

/** Effective crawl-delay in seconds for this UA (null = none). */
export function crawlDelayFor(rules: RobotsRules, userAgent: string): number | null {
  return bestGroupFor(rules, userAgent)?.crawlDelay ?? null;
}

/**
 * RFC 9309 §2.3 response semantics for a fetched robots.txt.
 * `body` is the response text (null when there is none).
 */
export function robotsForResponse(status: number, body: string | null): RobotsRules {
  if (status === 200 && body !== null) return parseRobots(body);
  if (status === 401 || status === 403) return DISALLOW_ALL;
  if (status === 429) return DISALLOW_ALL;
  // 404/410 and other 4xx: no restrictions; 5xx: MAY access (§2.3.1.5).
  return ALLOW_ALL;
}
