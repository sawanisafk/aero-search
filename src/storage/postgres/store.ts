import type { Pool } from 'pg';
import type {
  DocumentRepository,
  EnqueuedUrl,
  FetchedMeta,
  FrontierRepository,
  LinkRepository,
  StoredDocument,
  StoredLink,
  UpsertResult,
  UrlState,
  UrlStatus,
} from '../repositories.js';

interface UrlRow {
  normalized_url: string;
  original_url: string;
  host: string;
  depth: number;
  status: UrlStatus;
  http_status: number | null;
  content_type: string | null;
  bytes: number | null;
  error: string | null;
  discovered_from: string | null;
  redirect_chain: string[];
  enqueued_at: Date;
  fetched_at: Date | null;
}

interface DocumentRow {
  url: string;
  title: string;
  headings: StoredDocument['headings'];
  meta: Record<string, string>;
  text: string;
  word_count: number;
  unique_terms: number;
  content_hash: string;
  canonical_url: string | null;
  bytes: number;
  http_status: number;
  content_type: string;
  fetched_at: Date;
  duplicate_of: string | null;
}

function toUrlState(row: UrlRow): UrlState {
  return {
    url: row.normalized_url,
    originalUrl: row.original_url,
    host: row.host,
    depth: row.depth,
    status: row.status,
    httpStatus: row.http_status,
    contentType: row.content_type,
    bytes: row.bytes,
    error: row.error,
    discoveredFrom: row.discovered_from,
    redirectChain: row.redirect_chain,
    enqueuedAt: row.enqueued_at,
    fetchedAt: row.fetched_at,
  };
}

function toDocument(row: DocumentRow): StoredDocument {
  return {
    url: row.url,
    title: row.title,
    headings: row.headings,
    meta: row.meta,
    text: row.text,
    wordCount: row.word_count,
    uniqueTerms: row.unique_terms,
    contentHash: row.content_hash,
    canonicalUrl: row.canonical_url,
    bytes: row.bytes,
    httpStatus: row.http_status,
    contentType: row.content_type,
    fetchedAt: row.fetched_at,
    duplicateOf: row.duplicate_of,
  };
}

/**
 * PostgreSQL implementation of the crawl repository interfaces.
 * All statements are parameterized; JSONB columns receive JSON.stringify'd
 * values (node-postgres would otherwise serialize JS arrays as PG array
 * literals, which are not valid JSONB).
 */
export class PostgresStore implements FrontierRepository, DocumentRepository, LinkRepository {
  constructor(private readonly pool: Pool) {}

  // ── frontier ────────────────────────────────────────────────────────────

  async enqueue(entries: readonly EnqueuedUrl[]): Promise<number> {
    if (entries.length === 0) return 0;
    let inserted = 0;
    for (const e of entries) {
      const res = await this.pool.query<{ exists: boolean }>(
        `INSERT INTO urls (normalized_url, original_url, host, depth, discovered_from)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (normalized_url) DO NOTHING
         RETURNING true AS exists`,
        [e.url, e.originalUrl, e.host, e.depth, e.discoveredFrom],
      );
      if (res.rowCount !== null && res.rowCount > 0) inserted += res.rowCount;
    }
    return inserted;
  }

  async markFetched(url: string, meta: FetchedMeta): Promise<void> {
    await this.pool.query(
      `UPDATE urls
          SET status = 'fetched', http_status = $2, content_type = $3, bytes = $4,
              redirect_chain = $5::jsonb, fetched_at = now(), error = NULL
        WHERE normalized_url = $1`,
      [url, meta.httpStatus, meta.contentType, meta.bytes, JSON.stringify(meta.redirectChain)],
    );
  }

  async markFailed(url: string, error: string, httpStatus: number | null = null): Promise<void> {
    await this.pool.query(
      `UPDATE urls
          SET status = 'failed', http_status = $2, error = $3, fetched_at = now()
        WHERE normalized_url = $1`,
      [url, httpStatus, error],
    );
  }

  async markSkipped(url: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE urls
          SET status = 'skipped', error = $2, fetched_at = now()
        WHERE normalized_url = $1`,
      [url, reason],
    );
  }

  async get(url: string): Promise<UrlState | null> {
    const res = await this.pool.query<UrlRow>(
      `SELECT * FROM urls WHERE normalized_url = $1`,
      [url],
    );
    const row = res.rows[0];
    return row === undefined ? null : toUrlState(row);
  }

  async loadPending(limit: number): Promise<UrlState[]> {
    const res = await this.pool.query<UrlRow>(
      `SELECT * FROM urls WHERE status = 'pending' ORDER BY depth, enqueued_at LIMIT $1`,
      [limit],
    );
    return res.rows.map(toUrlState);
  }

  async counts(): Promise<Record<UrlStatus, number>> {
    const res = await this.pool.query<{ status: UrlStatus; n: string }>(
      `SELECT status, count(*)::text AS n FROM urls GROUP BY status`,
    );
    const out: Record<UrlStatus, number> = { pending: 0, fetched: 0, failed: 0, skipped: 0 };
    for (const r of res.rows) out[r.status] = Number(r.n);
    return out;
  }

  // ── documents ───────────────────────────────────────────────────────────

  async upsert(doc: StoredDocument): Promise<UpsertResult> {
    const existing = await this.getByUrl(doc.url);
    const original =
      existing !== null && existing.contentHash === doc.contentHash
        ? existing.duplicateOf // same content as before: keep its duplicate status
        : await this.findByContentHash(doc.contentHash).then((o) => o?.url ?? null);
    const duplicateOf = original !== null && original !== doc.url ? original : null;

    await this.pool.query(
      `INSERT INTO documents
         (url, title, headings, meta, text, word_count, unique_terms, content_hash,
          canonical_url, bytes, http_status, content_type, fetched_at, duplicate_of)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (url) DO UPDATE SET
         title = EXCLUDED.title, headings = EXCLUDED.headings, meta = EXCLUDED.meta,
         text = EXCLUDED.text, word_count = EXCLUDED.word_count,
         unique_terms = EXCLUDED.unique_terms, content_hash = EXCLUDED.content_hash,
         canonical_url = EXCLUDED.canonical_url, bytes = EXCLUDED.bytes,
         http_status = EXCLUDED.http_status, content_type = EXCLUDED.content_type,
         fetched_at = EXCLUDED.fetched_at, duplicate_of = EXCLUDED.duplicate_of`,
      [
        doc.url, doc.title, JSON.stringify(doc.headings), JSON.stringify(doc.meta),
        doc.text, doc.wordCount, doc.uniqueTerms, doc.contentHash, doc.canonicalUrl,
        doc.bytes, doc.httpStatus, doc.contentType, doc.fetchedAt, duplicateOf,
      ],
    );
    return { url: doc.url, inserted: existing === null, duplicateOf };
  }

  async getByUrl(url: string): Promise<StoredDocument | null> {
    const res = await this.pool.query<DocumentRow>(
      `SELECT * FROM documents WHERE url = $1`,
      [url],
    );
    const row = res.rows[0];
    return row === undefined ? null : toDocument(row);
  }

  async findByContentHash(hash: string): Promise<StoredDocument | null> {
    const res = await this.pool.query<DocumentRow>(
      `SELECT * FROM documents WHERE content_hash = $1 AND duplicate_of IS NULL`,
      [hash],
    );
    const row = res.rows[0];
    return row === undefined ? null : toDocument(row);
  }

  async count(): Promise<number> {
    const res = await this.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM documents`);
    return Number(res.rows[0]?.n ?? '0');
  }

  async countIndexable(): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM documents WHERE duplicate_of IS NULL`,
    );
    return Number(res.rows[0]?.n ?? '0');
  }

  async listIndexable(limit: number, offset: number): Promise<StoredDocument[]> {
    const res = await this.pool.query<DocumentRow>(
      `SELECT * FROM documents WHERE duplicate_of IS NULL ORDER BY url LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return res.rows.map(toDocument);
  }

  // ── links ───────────────────────────────────────────────────────────────

  async insert(links: readonly StoredLink[]): Promise<number> {
    let inserted = 0;
    for (const l of links) {
      const res = await this.pool.query(
        `INSERT INTO links (from_url, to_url, anchor, position)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (from_url, to_url, position) DO NOTHING`,
        [l.fromUrl, l.toUrl, l.anchor, l.position],
      );
      if (res.rowCount !== null) inserted += res.rowCount;
    }
    return inserted;
  }

  async edges(): Promise<StoredLink[]> {
    const res = await this.pool.query<{
      from_url: string; to_url: string; anchor: string; position: number;
    }>(`SELECT from_url, to_url, anchor, position FROM links ORDER BY from_url, position, to_url`);
    return res.rows.map((r) => ({
      fromUrl: r.from_url,
      toUrl: r.to_url,
      anchor: r.anchor,
      position: r.position,
    }));
  }

  async stats(): Promise<{ edgeCount: number; sourceCount: number; targetCount: number }> {
    const res = await this.pool.query<{ edges: string; sources: string; targets: string }>(
      `SELECT count(*)::text AS edges,
              count(DISTINCT from_url)::text AS sources,
              count(DISTINCT to_url)::text AS targets
         FROM links`,
    );
    const row = res.rows[0];
    return {
      edgeCount: Number(row?.edges ?? '0'),
      sourceCount: Number(row?.sources ?? '0'),
      targetCount: Number(row?.targets ?? '0'),
    };
  }
}
