-- M3 schema: crawl frontier state, documents (system of record), link graph.
-- Rationale: docs/ARCHITECTURE.md §4, ADR-003 (PostgreSQL never in the query
-- hot path). Applied by src/storage/postgres/migrate.ts (tracked in
-- schema_migrations, transactional, idempotent via IF NOT EXISTS).

-- One row per normalized URL the crawler has ever seen. 'pending' rows are the
-- persistent frontier; every state transition the in-memory queue makes is
-- written here (crash-resume, cross-run dedupe, failure audit).
CREATE TABLE IF NOT EXISTS urls (
  normalized_url  TEXT PRIMARY KEY,
  original_url    TEXT NOT NULL,
  host            TEXT NOT NULL,
  depth           INTEGER NOT NULL CHECK (depth >= 0),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'fetched', 'failed', 'skipped')),
  http_status     INTEGER,
  content_type    TEXT,
  bytes           INTEGER,
  error           TEXT,
  discovered_from TEXT,
  redirect_chain  JSONB NOT NULL DEFAULT '[]'::jsonb,
  enqueued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetched_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS urls_host_idx ON urls (host);
CREATE INDEX IF NOT EXISTS urls_status_idx ON urls (status);
CREATE INDEX IF NOT EXISTS urls_pending_bfs_idx ON urls (depth, enqueued_at)
  WHERE status = 'pending';

-- Extracted page content: the index bodies are derived from these rows
-- (rebuild → segment), never read from the query hot path (ADR-003).
CREATE TABLE IF NOT EXISTS documents (
  url           TEXT NOT NULL PRIMARY KEY
                REFERENCES urls (normalized_url) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT '',
  headings      JSONB NOT NULL DEFAULT '[]'::jsonb,
  meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
  text          TEXT NOT NULL DEFAULT '',
  word_count    INTEGER NOT NULL DEFAULT 0,
  unique_terms  INTEGER NOT NULL DEFAULT 0,
  content_hash  TEXT NOT NULL,
  canonical_url TEXT,
  bytes         INTEGER NOT NULL,
  http_status   INTEGER NOT NULL,
  content_type  TEXT NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  duplicate_of  TEXT REFERENCES documents (url) ON DELETE SET NULL
);

-- Exact-duplicate detection: at most one content-owning row per hash;
-- later URLs with identical content are stored but flagged duplicate_of.
CREATE UNIQUE INDEX IF NOT EXISTS documents_content_hash_uidx
  ON documents (content_hash) WHERE duplicate_of IS NULL;

-- Directed hyperlink graph — PageRank input (M4).
CREATE TABLE IF NOT EXISTS links (
  from_url TEXT NOT NULL REFERENCES documents (url) ON DELETE CASCADE,
  to_url   TEXT NOT NULL,
  anchor   TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL,
  PRIMARY KEY (from_url, to_url, position)
);

CREATE INDEX IF NOT EXISTS links_to_url_idx ON links (to_url);
