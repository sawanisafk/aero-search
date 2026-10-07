/**
 * Repository interfaces for crawl-state persistence (M3).
 *
 * Pure contracts — no `pg` types — so the crawler can be unit-tested against
 * an in-memory fake while `src/storage/postgres/store.ts` provides the real
 * implementation. Dependency direction: crawler → these interfaces ← postgres.
 */

export type UrlStatus = 'pending' | 'fetched' | 'failed' | 'skipped';

export interface EnqueuedUrl {
  /** Normalized URL — primary key, future corpus document id. */
  url: string;
  /** URL exactly as it appeared in a seed or outlink (provenance). */
  originalUrl: string;
  host: string;
  depth: number;
  /** Normalized URL whose outlink discovery produced this entry, or null for seeds. */
  discoveredFrom: string | null;
}

export interface UrlState extends EnqueuedUrl {
  status: UrlStatus;
  httpStatus: number | null;
  contentType: string | null;
  bytes: number | null;
  error: string | null;
  redirectChain: string[];
  enqueuedAt: Date;
  fetchedAt: Date | null;
}

export interface FetchedMeta {
  httpStatus: number;
  contentType: string | null;
  bytes: number;
  redirectChain: string[];
}

export interface FrontierRepository {
  /** Insert pending URLs; rows that already exist are left untouched. Returns newly inserted count. */
  enqueue(entries: readonly EnqueuedUrl[]): Promise<number>;
  markFetched(url: string, meta: FetchedMeta): Promise<void>;
  markFailed(url: string, error: string, httpStatus: number | null): Promise<void>;
  markSkipped(url: string, reason: string): Promise<void>;
  get(url: string): Promise<UrlState | null>;
  /** Pending rows in BFS order (depth, then enqueue time) — crash-resume path. */
  loadPending(limit: number): Promise<UrlState[]>;
  /** Every row regardless of status — resume seeds the seen-set from this. */
  loadAll(): Promise<UrlState[]>;
  counts(): Promise<Record<UrlStatus, number>>;
}

export interface Heading {
  level: string;
  text: string;
}

export interface StoredDocument {
  /** Normalized URL — equals the corpus document id handed to the index. */
  url: string;
  title: string;
  headings: Heading[];
  meta: Record<string, string>;
  text: string;
  wordCount: number;
  uniqueTerms: number;
  /** sha1 over normalized extracted text (exact-duplicate detection). */
  contentHash: string;
  canonicalUrl: string | null;
  bytes: number;
  httpStatus: number;
  contentType: string;
  fetchedAt: Date;
  /** Set when identical content already exists at another URL. */
  duplicateOf: string | null;
}

export interface UpsertResult {
  url: string;
  inserted: boolean;
  duplicateOf: string | null;
}

export interface DocumentRepository {
  upsert(doc: StoredDocument): Promise<UpsertResult>;
  getByUrl(url: string): Promise<StoredDocument | null>;
  findByContentHash(hash: string): Promise<StoredDocument | null>;
  count(): Promise<number>;
  /** Rows eligible for indexing (duplicate_of IS NULL). */
  countIndexable(): Promise<number>;
  /** Deterministic batch (ordered by url) — index rebuild reads pages of this. */
  listIndexable(limit: number, offset: number): Promise<StoredDocument[]>;
}

export interface StoredLink {
  fromUrl: string;
  toUrl: string;
  anchor: string;
  position: number;
}

export interface LinkRepository {
  /** Insert edges; identical (from, to, position) rows are ignored. Returns new edge count. */
  insert(links: readonly StoredLink[]): Promise<number>;
  /** All edges in deterministic order — PageRank input. */
  edges(): Promise<StoredLink[]>;
  stats(): Promise<{ edgeCount: number; sourceCount: number; targetCount: number }>;
}

/** Everything the crawler persists: frontier state + documents + link graph. */
export interface CrawlStore extends FrontierRepository, DocumentRepository, LinkRepository {}
