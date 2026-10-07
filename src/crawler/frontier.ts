/**
 * In-memory crawl frontier (ARCHITECTURE §7: "queues in memory, every
 * transition persisted to PostgreSQL"). Pure data structure: dedupe via a
 * seen-set, BFS ordering by depth with FIFO within a depth. Persistence,
 * budgets, and host politeness are layered on by the orchestrator (Phase C).
 */

export interface FrontierEntry {
  url: string;
  host: string;
  depth: number;
}

export class Frontier {
  private readonly seen = new Set<string>();
  private readonly buckets = new Map<number, FrontierEntry[]>();
  private pendingCount = 0;

  /**
   * Adds not-yet-seen URLs. Returns how many were new (already-seen URLs are
   * dropped — this is the run-level dedupe on top of URL normalization).
   */
  add(candidates: readonly { url: string; host: string; depth: number }[]): number {
    let added = 0;
    for (const c of candidates) {
      if (this.seen.has(c.url)) continue;
      this.seen.add(c.url);
      let bucket = this.buckets.get(c.depth);
      if (bucket === undefined) {
        bucket = [];
        this.buckets.set(c.depth, bucket);
      }
      bucket.push({ url: c.url, host: c.host, depth: c.depth });
      this.pendingCount++;
      added++;
    }
    return added;
  }

  /** Pending entries in BFS order (depth, then arrival); does not consume. */
  pending(): FrontierEntry[] {
    const depths = [...this.buckets.keys()].sort((a, b) => a - b);
    const out: FrontierEntry[] = [];
    for (const d of depths) out.push(...(this.buckets.get(d) ?? []));
    return out;
  }

  /** Removes a specific entry (taken by the orchestrator once due). */
  remove(url: string): boolean {
    for (const bucket of this.buckets.values()) {
      const i = bucket.findIndex((e) => e.url === url);
      if (i !== -1) {
        bucket.splice(i, 1);
        this.pendingCount--;
        return true;
      }
    }
    return false;
  }

  has(url: string): boolean {
    return this.seen.has(url);
  }

  /**
   * Marks a URL as seen WITHOUT queueing it — used on resume to keep
   * already-processed rows (fetched/failed/skipped) from being re-added as
   * children of later pages.
   */
  markSeen(url: string): void {
    this.seen.add(url);
  }

  size(): number {
    return this.pendingCount;
  }

  /** Total URLs ever accepted — equals rows this run would enqueue. */
  seenCount(): number {
    return this.seen.size;
  }
}
