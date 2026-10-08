/**
 * Document metadata providers — titles/URLs/text for result rows.
 *
 * WHAT: maps an integer docId (position inside the loaded index) to the
 *   human-facing metadata that lives OUTSIDE the index: the source corpus
 *   files, or (for the crawled corpus) PostgreSQL — the system of record.
 * WHY: the .aidx segment stores only terms/postings/positions (ADR-001
 *   frozen format). Presentation data belongs to the corpus layer, so the
 *   index never had to change and M5 adds zero pressure on M0-M4.
 * DATA IN: corpus name, the IndexBundle (docId -> corpus id), repo root.
 * DATA OUT: DocMeta { id, title, url, source, text } per docId, or null for
 *   a docId outside the index.
 * CONNECTS TO M0-M4:
 *   - scifact / 20newsgroups -> data/corpora/<name>/corpus.jsonl (BEIR rows,
 *     matched by _id against bundle.ids — never assumes line order)
 *   - static-v1 -> src/storage/corpus.ts loadCorpus() (bundled fixture)
 *   - crawled -> PG documents table via DATABASE_URL when set (text was
 *     extracted by the M3 crawler); unavailable => text null.
 * SECURITY: user-supplied ids are only ever looked up in in-memory maps or
 *   parameterized SQL — never used as filesystem paths.
 */

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import type { IndexBundle } from '../../scripts/lib/retrieval-run.js';
import { loadCorpus } from '../storage/corpus.js';

export interface DocMeta {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly source: string;
  /** full document text when the corpus keeps it; null when unavailable */
  readonly text: string | null;
}

export interface DocStore {
  /** short label for the UI, e.g. 'beir-jsonl' */
  readonly kind: string;
  get(docId: number): DocMeta | null;
  /**
   * Optional async preparation before get() (crawled store resolves text
   * from PostgreSQL). No-op for file-backed stores.
   */
  resolve?(docId: number): Promise<void>;
}

interface BeirRow {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

function loadBeirJsonl(file: string): Map<string, BeirRow> {
  const out = new Map<string, BeirRow>();
  if (!fs.existsSync(file)) return out;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    if (line.trim() === '') continue;
    const row = JSON.parse(line) as { _id?: unknown; title?: unknown; text?: unknown };
    if (typeof row._id !== 'string') continue;
    out.set(row._id, {
      id: row._id,
      title: typeof row.title === 'string' ? row.title : '',
      text: typeof row.text === 'string' ? row.text : '',
    });
  }
  return out;
}

class BeirDocStore implements DocStore {
  readonly kind = 'beir-jsonl';
  private readonly byId: Map<string, BeirRow>;

  constructor(
    private readonly bundle: IndexBundle,
    private readonly corpusLabel: string,
    file: string,
  ) {
    this.byId = loadBeirJsonl(file);
  }

  get(docId: number): DocMeta | null {
    const id = this.bundle.ids[docId];
    if (id === undefined) return null;
    const row = this.byId.get(id);
    if (row === undefined) {
      return { id, title: id, url: null, source: this.corpusLabel, text: null };
    }
    return {
      id: row.id,
      title: row.title.length > 0 ? row.title : row.id,
      url: null,
      source: this.corpusLabel,
      text: row.text,
    };
  }
}

class StaticDocStore implements DocStore {
  readonly kind = 'fixture-corpus';
  private readonly metas: Array<{ title: string; url: string; text: string } | null> = [];
  private readonly ids: readonly string[];
  private readonly label: string;

  constructor(corpusLabel: string, corpusDir: string, ids: readonly string[]) {
    this.ids = ids;
    this.label = corpusLabel;
    try {
      const loaded = loadCorpus(corpusDir);
      for (const d of loaded.docs) this.metas.push({ title: d.title, url: d.url, text: d.text });
    } catch {
      // corpus files missing — results still list documents by id.
      this.metas.length = 0;
    }
  }

  get(docId: number): DocMeta | null {
    const id = this.ids[docId];
    if (id === undefined) return null;
    const meta = this.metas[docId] ?? null;
    return {
      id,
      title: meta?.title ?? id,
      url: meta?.url ?? null,
      source: this.label,
      text: meta?.text ?? null,
    };
  }
}

/** Crawled metadata: PostgreSQL documents table, only when DATABASE_URL is set. */
class CrawledDocStore implements DocStore {
  readonly kind = 'postgres-crawl';
  private readonly cache = new Map<string, { title: string; text: string | null }>();
  private pool: pg.Pool | null;

  constructor(private readonly bundle: IndexBundle) {
    const url = process.env.DATABASE_URL;
    this.pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
  }

  async resolve(docId: number): Promise<void> {
    const id = this.bundle.ids[docId];
    if (id === undefined || this.pool === null || this.cache.has(id)) return;
    try {
      const res = await this.pool.query('SELECT title, text FROM documents WHERE url = $1', [id]);
      const row = res.rows[0] as { title?: string; text?: string } | undefined;
      this.cache.set(id, { title: row?.title ?? '', text: row?.text ?? null });
    } catch {
      this.cache.set(id, { title: '', text: null });
    }
  }

  get(docId: number): DocMeta | null {
    const id = this.bundle.ids[docId];
    if (id === undefined) return null;
    const cached = this.cache.get(id);
    return {
      id,
      title: cached !== undefined && cached.title.length > 0 ? cached.title : id,
      url: id,
      source: 'crawl',
      text: cached?.text ?? null,
    };
  }
}

export function createDocStore(corpus: string, bundle: IndexBundle, root: string): DocStore {
  if (corpus === 'crawled') return new CrawledDocStore(bundle);
  const beirFile = path.join(root, 'data', 'corpora', corpus, 'corpus.jsonl');
  if (fs.existsSync(beirFile)) return new BeirDocStore(bundle, corpus, beirFile);
  const fixtureDir = path.join(root, 'data', 'corpora', corpus);
  if (fs.existsSync(path.join(fixtureDir, 'documents.jsonl'))) {
    return new StaticDocStore(corpus, fixtureDir, bundle.ids);
  }
  // Unknown/absent metadata: ids still resolve (title = id), text = null.
  return {
    kind: 'ids-only',
    get(docId: number): DocMeta | null {
      const id = bundle.ids[docId];
      return id === undefined ? null : { id, title: id, url: null, source: corpus, text: null };
    },
  };
}
