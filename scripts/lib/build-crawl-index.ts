/**
 * Index rebuild from PostgreSQL (ADR-003: PG = source of truth, segment =
 * derived artifact). Indexes every content-owning document (duplicate_of IS
 * NULL) in deterministic url order; the segment and ids array are written as
 * `<corpus>.aidx` / `<corpus>.ids.json`, plus a committed corpus manifest
 * (ADR-006 provenance: counts, config hash, git SHA, corpus hash).
 */

import path from 'node:path';
import { IndexWriter } from '../../src/core/index/writer.js';
import type { IndexStats } from '../../src/core/index/types.js';
import { writeSegment } from '../../src/storage/segment.js';
import type {
  DocumentRepository,
  FrontierRepository,
  LinkRepository,
  StoredDocument,
  UrlStatus,
} from '../../src/storage/repositories.js';
import { sha256, writeJson, type GitInfo } from './dataset.js';

export interface CrawlManifest {
  name: string;
  builtAt: string;
  git: GitInfo;
  /** sha256 of the crawl config file the corpus was crawled with (null in tests). */
  configSha256: string | null;
  counts: {
    documents: number;
    indexable: number;
    duplicates: number;
    urls: Record<UrlStatus, number>;
    links: { edgeCount: number; sourceCount: number; targetCount: number };
  };
  index: IndexStats & { bytes: number; corpusHash: string };
}

export type CrawlIndexStore = DocumentRepository & FrontierRepository & LinkRepository;

export interface BuildCrawlIndexOptions {
  store: CrawlIndexStore;
  /** Directory for `<name>.aidx` + `<name>.ids.json` (e.g. data/index). */
  outDir: string;
  /** Manifest destination (e.g. data/eval/crawled.manifest.json — committed). */
  manifestPath: string;
  /** Link-graph export destination (default: sibling `<name>.graph.json`). */
  graphPath?: string;
  git: GitInfo;
  configSha256: string | null;
  name?: string;
}

/** Canonical corpus serialization: hash source for provenance. */
function corpusLines(docs: readonly StoredDocument[]): string {
  return docs.map((d) => `${d.url}\t${d.title}\t${d.text}\n`).join('');
}

export async function buildCrawlIndex(
  opts: BuildCrawlIndexOptions,
): Promise<{ manifest: CrawlManifest; bytes: number; segmentPath: string; graphPath: string }> {
  const name = opts.name ?? 'crawled';

  const docs: StoredDocument[] = [];
  const batch = 500;
  for (let offset = 0; ; offset += batch) {
    const page = await opts.store.listIndexable(batch, offset);
    if (page.length === 0) break;
    docs.push(...page);
    if (page.length < batch) break;
  }

  const corpusHash = sha256(corpusLines(docs));
  const writer = new IndexWriter({ corpusHash });
  for (const d of docs) {
    writer.addDocument({
      title: d.title,
      url: d.url,
      // Single indexed field (M1 field model): title leads the body, as in
      // the JSONL evaluation corpora.
      text: d.title !== '' ? `${d.title}. ${d.text}` : d.text,
    });
  }
  const data = writer.finalize();

  const segmentPath = path.join(opts.outDir, `${name}.aidx`);
  const bytes = writeSegment(data, segmentPath);
  writeJson(path.join(opts.outDir, `${name}.ids.json`), docs.map((d) => d.url));

  const manifest: CrawlManifest = {
    name,
    builtAt: new Date().toISOString(),
    git: opts.git,
    configSha256: opts.configSha256,
    counts: {
      documents: await opts.store.count(),
      indexable: docs.length,
      duplicates: (await opts.store.count()) - docs.length,
      urls: await opts.store.counts(),
      links: await opts.store.stats(),
    },
    index: { ...data.stats, bytes, corpusHash },
  };
  writeJson(opts.manifestPath, manifest);

  // Committed edge-list export: the exact link graph PageRank consumes
  // (M3 evidence + M4-A reproducibility, independent of the DB cluster).
  const graphPath =
    opts.graphPath ?? opts.manifestPath.replace(/\.manifest\.json$/, '.graph.json');
  const edges = await opts.store.edges();
  writeJson(graphPath, {
    name,
    generatedAt: manifest.builtAt,
    corpusHash,
    counts: manifest.counts.links,
    edges: edges.map((e) => ({ from: e.fromUrl, to: e.toUrl, anchor: e.anchor, position: e.position })),
  });

  return { manifest, bytes, segmentPath, graphPath };
}
