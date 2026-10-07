import type {
  CrawlStore,
  DocumentRepository,
  EnqueuedUrl,
  FrontierRepository,
  LinkRepository,
  StoredDocument,
  StoredLink,
  UrlState,
  UrlStatus,
} from '../../src/storage/repositories.js';

function linkKey(l: StoredLink): string {
  return l.fromUrl + '\u0000' + l.toUrl + '\u0000' + String(l.position);
}

/**
 * In-memory CrawlStore for crawler unit tests — mirrors PostgresStore
 * semantics (ON CONFLICT do-nothing, content-hash ownership, BFS order).
 * The PostgreSQL implementation gets the same coverage in Phase D's E2E test.
 */
export class InMemoryCrawlStore implements CrawlStore, FrontierRepository, DocumentRepository, LinkRepository {
  readonly urls = new Map<string, UrlState>();
  readonly docs = new Map<string, StoredDocument>();
  readonly links: StoredLink[] = [];

  async enqueue(entries: readonly EnqueuedUrl[]): Promise<number> {
    let inserted = 0;
    for (const e of entries) {
      if (this.urls.has(e.url)) continue;
      this.urls.set(e.url, {
        ...e,
        status: 'pending',
        httpStatus: null,
        contentType: null,
        bytes: null,
        error: null,
        redirectChain: [],
        enqueuedAt: new Date(0),
        fetchedAt: null,
      });
      inserted++;
    }
    return inserted;
  }

  async markFetched(
    url: string,
    meta: { httpStatus: number; contentType: string | null; bytes: number; redirectChain: string[] },
  ): Promise<void> {
    const row = this.urls.get(url);
    if (row === undefined) return;
    row.status = 'fetched';
    row.httpStatus = meta.httpStatus;
    row.contentType = meta.contentType;
    row.bytes = meta.bytes;
    row.redirectChain = meta.redirectChain;
    row.error = null;
    row.fetchedAt = new Date(1_700_000_000_000);
  }

  async markFailed(url: string, error: string, httpStatus: number | null = null): Promise<void> {
    const row = this.urls.get(url);
    if (row === undefined) return;
    row.status = 'failed';
    row.error = error;
    row.httpStatus = httpStatus;
    row.fetchedAt = new Date(1_700_000_000_000);
  }

  async markSkipped(url: string, reason: string): Promise<void> {
    const row = this.urls.get(url);
    if (row === undefined) return;
    row.status = 'skipped';
    row.error = reason;
    row.fetchedAt = new Date(1_700_000_000_000);
  }

  async get(url: string): Promise<UrlState | null> {
    return this.urls.get(url) ?? null;
  }

  async loadPending(limit: number): Promise<UrlState[]> {
    return [...this.urls.values()]
      .filter((u) => u.status === 'pending')
      .sort((a, b) => a.depth - b.depth || a.enqueuedAt.getTime() - b.enqueuedAt.getTime())
      .slice(0, limit);
  }

  async loadAll(): Promise<UrlState[]> {
    return [...this.urls.values()].sort(
      (a, b) => a.depth - b.depth || a.enqueuedAt.getTime() - b.enqueuedAt.getTime(),
    );
  }

  async counts(): Promise<Record<UrlStatus, number>> {
    const out: Record<UrlStatus, number> = { pending: 0, fetched: 0, failed: 0, skipped: 0 };
    for (const u of this.urls.values()) out[u.status]++;
    return out;
  }

  async upsert(doc: StoredDocument): Promise<{ url: string; inserted: boolean; duplicateOf: string | null }> {
    const existing = this.docs.get(doc.url) ?? null;
    const owner =
      existing !== null && existing.contentHash === doc.contentHash
        ? existing.duplicateOf
        : (this.findByContentHashSync(doc.contentHash)?.url ?? null);
    const duplicateOf = owner !== null && owner !== doc.url ? owner : null;
    this.docs.set(doc.url, { ...doc, duplicateOf });
    return { url: doc.url, inserted: existing === null, duplicateOf };
  }

  private findByContentHashSync(hash: string): StoredDocument | null {
    for (const d of this.docs.values()) {
      if (d.contentHash === hash && d.duplicateOf === null) return d;
    }
    return null;
  }

  async getByUrl(url: string): Promise<StoredDocument | null> {
    return this.docs.get(url) ?? null;
  }

  async findByContentHash(hash: string): Promise<StoredDocument | null> {
    return this.findByContentHashSync(hash);
  }

  async count(): Promise<number> {
    return this.docs.size;
  }

  async countIndexable(): Promise<number> {
    return [...this.docs.values()].filter((d) => d.duplicateOf === null).length;
  }

  async listIndexable(limit: number, offset: number): Promise<StoredDocument[]> {
    return [...this.docs.values()]
      .filter((d) => d.duplicateOf === null)
      .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
      .slice(offset, offset + limit);
  }

  async insert(links: readonly StoredLink[]): Promise<number> {
    let inserted = 0;
    for (const l of links) {
      const key = linkKey(l);
      if (this.links.some((x) => linkKey(x) === key)) continue;
      this.links.push(l);
      inserted++;
    }
    return inserted;
  }

  async edges(): Promise<StoredLink[]> {
    return [...this.links].sort((a, b) =>
      a.fromUrl === b.fromUrl
        ? a.position - b.position || (a.toUrl < b.toUrl ? -1 : 1)
        : a.fromUrl < b.fromUrl
          ? -1
          : 1,
    );
  }

  async stats(): Promise<{ edgeCount: number; sourceCount: number; targetCount: number }> {
    return {
      edgeCount: this.links.length,
      sourceCount: new Set(this.links.map((l) => l.fromUrl)).size,
      targetCount: new Set(this.links.map((l) => l.toUrl)).size,
    };
  }
}
