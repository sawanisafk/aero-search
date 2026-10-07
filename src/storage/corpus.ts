/**
 * Fixture corpus loader — reads a bundled corpus directory (manifest +
 * documents.jsonl + html/) and returns IndexWriter-ready inputs.
 *
 * Trust model: every document's HTML is verified against the sha256 recorded
 * in documents.jsonl, and documents.jsonl itself is hashed — that hash both
 * validates against manifest.json and becomes the index's corpus hash, so a
 * segment can always be traced back to the exact corpus bytes it was built
 * from (DEVELOPMENT.md evidence rule).
 *
 * Text extraction here is deliberately minimal (strip tags, decode the few
 * entities the fixture generator emits): these are our own known fixture
 * files. The production HTML pipeline arrives with the crawler in M3.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AddDocumentInput } from '../core/index/types.js';

export interface CorpusDocumentMeta {
  id: string;
  file: string;
  title: string;
  url: string;
  source: string;
  sourceUrl: string;
  license: string;
  workDate: string;
  retrieved: string;
  sha256: string;
}

export interface CorpusManifest {
  name: string;
  version: number;
  description: string;
  retrieved: string;
  license: string;
  generator: string;
  numDocuments: number;
  documentsSha256: string;
  sources: {
    id: number;
    title: string;
    author: string;
    workDate: string;
    parts: number;
  }[];
}

export interface LoadedCorpus {
  docs: AddDocumentInput[];
  manifest: CorpusManifest;
  /** sha256 of documents.jsonl — pass to IndexWriter as corpusHash */
  corpusHash: string;
}

const sha256 = (buf: Buffer | string): string => crypto.createHash('sha256').update(buf).digest('hex');

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function extractTitle(html: string): string {
  const m = /<title>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]!.trim()) : '';
}

export function extractText(html: string): string {
  const body = html.replace(/<head[\s\S]*?<\/head>/i, '');
  const text = body.replace(/<[^>]+>/g, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

export function loadCorpus(dir: string): LoadedCorpus {
  const docsPath = path.join(dir, 'documents.jsonl');
  const raw = fs.readFileSync(docsPath);
  const corpusHash = sha256(raw);

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as CorpusManifest;
  if (manifest.documentsSha256 !== corpusHash) {
    throw new Error(
      `corpus hash mismatch: manifest=${manifest.documentsSha256} actual=${corpusHash} — corpus was modified after generation`,
    );
  }

  const docs: AddDocumentInput[] = [];
  for (const line of raw.toString('utf8').split('\n')) {
    if (line.trim() === '') continue;
    const meta = JSON.parse(line) as CorpusDocumentMeta;
    const html = fs.readFileSync(path.join(dir, meta.file));
    const actual = sha256(html);
    if (actual !== meta.sha256) {
      throw new Error(`${meta.file}: sha256 mismatch (manifest ${meta.sha256}, actual ${actual})`);
    }
    const htmlStr = html.toString('utf8');
    docs.push({
      title: extractTitle(htmlStr) || meta.title,
      url: meta.url,
      text: extractText(htmlStr),
    });
  }

  if (docs.length !== manifest.numDocuments) {
    throw new Error(`expected ${manifest.numDocuments} documents, parsed ${docs.length}`);
  }

  return { docs, manifest, corpusHash };
}
