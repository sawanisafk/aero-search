# Database — Aero Search

PostgreSQL as the **source of truth** for crawl state, documents, and the link graph
(M3). Never in the query hot path (ADR-003): queries serve from the in-memory segment;
PostgreSQL is read only for snippet bodies of the top-K results (M5) and offline jobs.

## Schema (`migrations/001_init.sql`)

| Table | Role | Key columns |
|---|---|---|
| `urls` | crawl frontier (system of record) | `normalized_url` PK, `status` (`pending/fetched/failed/skipped`), `depth`, `http_status`, `error`, `fetched_at`, `content_hash` — partial index on `(depth)` for `status='pending'` drives BFS |
| `documents` | extracted corpus | `id` PK, `url`, `title`, `text`, `word_count`, `content_hash`, `duplicate_of` → documents.id (byte-exact duplicates link to their owner), `fetched_at` — **partial unique index on `content_hash WHERE duplicate_of IS NULL`** |
| `links` | directed graph for PageRank (M4) | `src_document_id`, `dst_document_id` FK → documents (ON DELETE CASCADE), unique pair + index on `src` |

Content identity: `content_hash` (sha1 of raw bytes) computed by the crawler; `documents`
is deduplicated at write time; the index builder reads `duplicate_of IS NULL` rows only.

## Migrations

- `npm run db:migrate` → `scripts/db-migrate.ts` (idempotent, transactional,
  checksummed row in `schema_migrations`); applied automatically by `npm run crawl` /
  `npm run index:crawl` and test setup.
- Forward-only, numbered files in `migrations/` — edit schema by adding `002_*.sql`.

## Repository layer

- **Interfaces** (`src/storage/repositories.ts`): pure TypeScript, no `pg` types —
  `FrontierRepository` (upsert/claim/mark*/loadPending/loadAll), `DocumentRepository`
  (upsertDocument, listIndexable, count), `LinkRepository` (insertLinks, count, stats),
  plus `counts()`/`count()`/`stats()` reporting helpers. The `Crawler` and index builder
  depend only on these.
- **Implementation** (`src/storage/postgres/store.ts`): `PostgresStore` over a `pg` Pool,
  JSONB columns via `JSON.stringify`, `ON CONFLICT` upserts, batched link inserts.
- **Test double** (`tests/helpers/in-memory-store.ts`): same contracts, no I/O — unit
  tests stay fast; one E2E suite proves parity on real PostgreSQL.

## Running PostgreSQL without Docker (ADR-011)

`scripts/lib/embedded-pg.ts` → `startDatabase()`:

1. If `DATABASE_URL` is reachable → use it (keeps the compose/system contract intact).
2. Otherwise boot an **embedded PostgreSQL 16.14** (`embedded-postgres` npm):
   - dev/CLI: `data/pg/`, port 5432, compose credentials (`aero/aero`, db `aero_search`);
   - tests: fresh clusters under `data/pgtest/` (port 5433) / `data/pgtest-e2e`
     (port 5434), wiped after the run.
   - Cluster init uses `--encoding=UTF8 --locale=C` (Windows default `WIN1252`
     rejects non-ASCII characters in SQL).

All cluster directories are gitignored (`data/pg*`).

## Index rebuild (ADR-003 consistency rule)

Crawl writes PostgreSQL → **full offline rebuild** → derived segment:

```bash
npm run crawl          # writes urls/documents/links rows
npm run index:crawl    # rows → data/index/crawled.aidx + .ids.json
                       # + committed data/eval/crawled.manifest.json
```

`buildCrawlIndex` (in `scripts/lib/`) reads `listIndexable` in deterministic url order,
indexes through the existing `IndexWriter`, and records provenance in the manifest:
document/url/link counts, config sha256, git SHA, corpus hash (sha256 over
`url\ttitle\ttext` lines), segment bytes and stats.

## Queries used by the crawler (as-built)

All writes are `INSERT ... ON CONFLICT`; all reads are indexed point/batch lookups:

- BFS claim: `SELECT ... FROM urls WHERE status='pending' ORDER BY depth, id LIMIT n`
- Resume: load all rows in one ordered pass, rebuild the in-memory frontier.
- Index build: `SELECT ... FROM documents WHERE duplicate_of IS NULL ORDER BY url`
  in 500-row pages.
