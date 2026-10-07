/**
 * Crawl orchestrator (ARCHITECTURE §7 pipeline, implemented literally):
 *
 *   seeds → frontier (BFS by depth) → robots.txt (cached per origin, status
 *   semantics per RFC 9309) → per-host politeness delay → fetch (redirect
 *   cap, byte cap) → content-type gate → extract → content-hash dedupe →
 *   upsert document + link edges → enqueue children within allowlist/depth.
 *
 * Hard budgets: `maxPages` page-fetch attempts (robots fetches excluded —
 * they are bounded by distinct hosts), `maxDepth`, non-empty allowlist
 * (ADR-006). Clock and sleep are injected: tests run on a deterministic
 * virtual clock, real runs use the defaults.
 */

import { analyze } from '../core/text/index.js';
import type { CrawlStore, EnqueuedUrl } from '../storage/repositories.js';
import { contentHash } from './dedupe.js';
import { extractPage } from './extract.js';
import type { Fetcher } from './fetcher.js';
import { Frontier, type FrontierEntry } from './frontier.js';
import { crawlDelayFor, isAllowed, robotsForResponse, type RobotsRules, ALLOW_ALL } from './robots.js';
import { HostScheduler } from './politeness.js';
import { hostOf, isAllowedHost, normalizeUrl } from './url.js';

export interface CrawlerConfig {
  seeds: readonly string[];
  allowlist: readonly string[];
  maxPages: number;
  maxDepth: number;
  /** Default per-host politeness delay in ms; robots crawl-delay overrides it. */
  delayMs: number;
  userAgent: string;
  respectRobots: boolean;
}

export type CrawlEventType =
  | 'seed'
  | 'seed-skipped'
  | 'robots-fetched'
  | 'robots-skipped'
  | 'fetched'
  | 'failed'
  | 'content-skipped'
  | 'duplicate'
  | 'stored';

export interface CrawlEvent {
  type: CrawlEventType;
  url: string;
  detail?: string;
  status?: number;
}

export interface CrawlReport {
  /** Page fetch attempts (success or failure); robots fetches excluded. */
  pagesFetched: number;
  stored: number;
  duplicates: number;
  robotsSkipped: number;
  contentTypeSkipped: number;
  failed: number;
  /** URLs newly added to frontier + persisted as pending rows. */
  newUrls: number;
  depthDropped: number;
  offAllowlistDropped: number;
  durationMs: number;
  events: CrawlEvent[];
}

export interface CrawlerDeps {
  fetcher: Fetcher;
  store: CrawlStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (event: CrawlEvent) => void;
}

const HTML_MIME = new Set(['text/html', 'application/xhtml+xml']);

function mimeOf(contentType: string | null): string | null {
  if (contentType === null) return null;
  return (contentType.split(';')[0] ?? '').trim().toLowerCase() || null;
}

function pathOf(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

export class Crawler {
  private readonly frontier = new Frontier();
  private readonly scheduler: HostScheduler;
  private readonly robotsCache = new Map<string, RobotsRules>();
  private readonly events: CrawlEvent[] = [];
  private readonly sleep: (ms: number) => Promise<void>;
  private pagesFetched = 0;
  private stored = 0;
  private duplicates = 0;
  private robotsSkipped = 0;
  private contentTypeSkipped = 0;
  private failed = 0;
  private newUrls = 0;
  private depthDropped = 0;
  private offAllowlistDropped = 0;

  constructor(
    private readonly config: CrawlerConfig,
    private readonly deps: CrawlerDeps,
  ) {
    if (config.seeds.length === 0) throw new Error('crawler: at least one seed URL required');
    if (config.allowlist.length === 0) {
      throw new Error('crawler: allowlist is empty — a controlled crawl must name its domains (ADR-006)');
    }
    if (config.maxPages < 1) throw new Error('crawler: maxPages must be >= 1');
    if (config.maxDepth < 0) throw new Error('crawler: maxDepth must be >= 0');
    this.scheduler = new HostScheduler(config.delayMs);
    this.sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /**
   * Runs the crawl. `{ resume: true }` reloads persisted crawl state first:
   * every known URL enters the seen-set (no re-fetch of processed rows) and
   * pending rows rejoin the queue in BFS order — crash-resume / second run.
   */
  async run(opts: { resume?: boolean } = {}): Promise<CrawlReport> {
    const now = this.deps.now ?? Date.now;
    const sleep = this.sleep;
    const t0 = now();

    if (opts.resume === true) {
      const known = await this.deps.store.loadAll();
      for (const row of known) {
        if (row.status === 'pending') {
          this.frontier.add([{ url: row.url, host: row.host, depth: row.depth }]);
        }
        this.frontier.markSeen(row.url);
      }
    }

    for (const raw of this.config.seeds) {
      const url = normalizeUrl(raw);
      if (url === null) {
        this.emit({ type: 'seed-skipped', url: raw, detail: 'invalid or non-http seed' });
        continue;
      }
      if (!isAllowedHost(url, this.config.allowlist)) {
        this.emit({ type: 'seed-skipped', url, detail: 'outside allowlist' });
        continue;
      }
      await this.accept([{ url, originalUrl: raw, host: hostOf(url), depth: 0, discoveredFrom: null }]);
      this.emit({ type: 'seed', url });
    }

    while (this.pagesFetched < this.config.maxPages) {
      const pending = this.frontier.pending();
      if (pending.length === 0) break;
      const t = now();
      const due = pending.find((e) => this.scheduler.isDue(e.host, t));
      if (due === undefined) {
        const wait = Math.min(...pending.map((e) => this.scheduler.msUntilDue(e.host, t)));
        if (wait > 0) await sleep(wait);
        continue;
      }
      this.frontier.remove(due.url);
      await this.fetchOne(due);
    }

    return {
      pagesFetched: this.pagesFetched,
      stored: this.stored,
      duplicates: this.duplicates,
      robotsSkipped: this.robotsSkipped,
      contentTypeSkipped: this.contentTypeSkipped,
      failed: this.failed,
      newUrls: this.newUrls,
      depthDropped: this.depthDropped,
      offAllowlistDropped: this.offAllowlistDropped,
      durationMs: now() - t0,
      events: this.events,
    };
  }

  /** Persist newly seen URLs as pending rows and push them onto the frontier. */
  private async accept(entries: EnqueuedUrl[]): Promise<number> {
    const inBatch = new Set<string>();
    const fresh = entries.filter((e) => {
      if (this.frontier.has(e.url) || inBatch.has(e.url)) return false;
      inBatch.add(e.url);
      return true;
    });
    if (fresh.length === 0) return 0;
    this.frontier.add(fresh);
    await this.deps.store.enqueue(fresh);
    this.newUrls += fresh.length;
    return fresh.length;
  }

  private async fetchOne(entry: FrontierEntry): Promise<void> {
    const now = this.deps.now ?? Date.now;
    const robots = await this.robotsFor(entry);
    if (
      this.config.respectRobots &&
      !isAllowed(robots, this.config.userAgent, pathOf(entry.url))
    ) {
      await this.deps.store.markSkipped(entry.url, 'robots: disallowed');
      this.robotsSkipped++;
      this.emit({ type: 'robots-skipped', url: entry.url });
      return;
    }

    // Politeness gap applies after the robots.txt fetch too: same host,
    // next request must still wait out the delay.
    const wait = this.scheduler.msUntilDue(entry.host, now());
    if (wait > 0) await this.sleep(wait);

    this.pagesFetched++;
    let res;
    try {
      res = await this.deps.fetcher.fetch(entry.url);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await this.deps.store.markFailed(entry.url, detail, null);
      this.failed++;
      this.scheduler.markFetched(entry.host, now());
      this.emit({ type: 'failed', url: entry.url, detail });
      return;
    }
    this.scheduler.markFetched(entry.host, now());

    if (res.status < 200 || res.status >= 300) {
      const detail = `http ${res.status}`;
      await this.deps.store.markFailed(entry.url, detail, res.status);
      this.failed++;
      this.emit({ type: 'failed', url: entry.url, detail, status: res.status });
      return;
    }

    const mime = mimeOf(res.contentType);
    if (mime === null || !HTML_MIME.has(mime)) {
      const detail = `content-type: ${mime ?? 'unknown'}`;
      await this.deps.store.markSkipped(entry.url, detail);
      this.contentTypeSkipped++;
      this.emit({ type: 'content-skipped', url: entry.url, detail });
      return;
    }

    const page = extractPage(res.body, res.finalUrl);
    const tokens = analyze(page.text);
    const upsert = await this.deps.store.upsert({
      url: entry.url,
      title: page.title,
      headings: page.headings,
      meta: page.meta,
      text: page.text,
      wordCount: tokens.length,
      uniqueTerms: new Set(tokens.map((t) => t.term)).size,
      contentHash: contentHash(page.text),
      canonicalUrl: page.canonicalUrl,
      bytes: res.bytes,
      httpStatus: res.status,
      contentType: res.contentType ?? 'text/html',
      fetchedAt: new Date(),
      duplicateOf: null,
    });
    await this.deps.store.markFetched(entry.url, {
      httpStatus: res.status,
      contentType: res.contentType,
      bytes: res.bytes,
      redirectChain: res.redirectChain.length > 1 ? res.redirectChain : [],
    });

    if (upsert.duplicateOf !== null) {
      this.duplicates++;
      this.emit({ type: 'duplicate', url: entry.url, detail: `duplicate of ${upsert.duplicateOf}` });
    } else {
      this.stored++;
      this.emit({ type: 'fetched', url: entry.url, status: res.status });
    }

    await this.deps.store.insert(
      page.links.flatMap((l) => {
        const to = normalizeUrl(l.href ?? l.rawHref);
        return to === null
          ? []
          : [{ fromUrl: entry.url, toUrl: to, anchor: l.anchor, position: l.position }];
      }),
    );

    const nextDepth = entry.depth + 1;
    const children: EnqueuedUrl[] = [];
    for (const l of page.links) {
      const child = l.href === null ? null : normalizeUrl(l.href);
      if (child === null) continue;
      if (!isAllowedHost(child, this.config.allowlist)) {
        this.offAllowlistDropped++;
        continue;
      }
      if (nextDepth > this.config.maxDepth) {
        this.depthDropped++;
        continue;
      }
      children.push({
        url: child,
        originalUrl: l.rawHref,
        host: hostOf(child),
        depth: nextDepth,
        discoveredFrom: entry.url,
      });
    }
    await this.accept(children);
  }

  private async robotsFor(entry: FrontierEntry): Promise<RobotsRules> {
    const origin = new URL(entry.url).origin;
    const cached = this.robotsCache.get(origin);
    if (cached !== undefined) return cached;
    if (!this.config.respectRobots) {
      this.robotsCache.set(origin, ALLOW_ALL);
      return ALLOW_ALL;
    }

    const now = this.deps.now ?? Date.now;
    const robotsUrl = `${origin}/robots.txt`;
    let rules: RobotsRules;
    try {
      const res = await this.deps.fetcher.fetch(robotsUrl);
      rules = robotsForResponse(res.status, res.body);
      this.emit({ type: 'robots-fetched', url: robotsUrl, status: res.status });
    } catch (err) {
      // No usable robots.txt → no restrictions (fail-open, logged as data).
      rules = ALLOW_ALL;
      this.emit({
        type: 'robots-fetched',
        url: robotsUrl,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    this.scheduler.markFetched(entry.host, now());
    const delay = crawlDelayFor(rules, this.config.userAgent);
    if (delay !== null) this.scheduler.setDelay(entry.host, delay * 1000);
    this.robotsCache.set(origin, rules);
    return rules;
  }

  private emit(event: CrawlEvent): void {
    this.events.push(event);
    this.deps.onEvent?.(event);
  }
}
