/**
 * End-to-end pipeline tests: documents -> analysis -> inverted index ->
 * AIDX persistence -> reader -> lookups. The second suite runs against the
 * bundled static-v1 fixture corpus (the M1 exit criteria).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { IndexWriter } from '../src/core/index/writer.js';
import { IndexReader } from '../src/core/index/reader.js';
import { analyze } from '../src/core/text/analyze.js';
import type { AddDocumentInput } from '../src/core/index/types.js';
import { loadCorpus } from '../src/storage/corpus.js';
import { readSegment, writeSegment } from '../src/storage/segment.js';

const CORPUS_DIR = path.join(process.cwd(), 'data', 'corpora', 'static-v1');

interface SnapshotEntry {
  docIds: number[];
  tfs: number[];
  positions: number[][];
}

/** Full observable query results for every term — used for equality checks. */
function snapshot(reader: IndexReader): Map<string, SnapshotEntry> {
  const out = new Map<string, SnapshotEntry>();
  for (const term of reader.raw.terms) {
    const view = reader.postingsForTerm(term)!;
    const docIds: number[] = [];
    const tfs: number[] = [];
    const positions: number[][] = [];
    view.forEach((i, docId, tf) => {
      docIds.push(docId);
      tfs.push(tf);
      positions.push(view.positions(i));
    });
    out.set(term, { docIds, tfs, positions });
  }
  return out;
}

const DOCS: AddDocumentInput[] = [
  { title: 'A', url: 'u:0', text: 'the quick brown fox jumps over the lazy dog' },
  { title: 'B', url: 'u:1', text: 'quick foxes are quick — a fox is quick indeed' },
  { title: 'C', url: 'u:2', text: 'machine learning systems learn statistical patterns' },
];

const tmpDirs: string[] = [];
function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-'));
  tmpDirs.push(dir);
  return path.join(dir, name);
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('pipeline: index -> segment -> reader', () => {
  it('produces identical query results before and after a persistence cycle', () => {
    const writer = new IndexWriter({ corpusHash: 'e2e-inline-corpus' });
    for (const d of DOCS) writer.addDocument(d);
    const built = writer.finalize();

    const file = tmpFile('inline.aidx');
    writeSegment(built, file);
    const reloaded = IndexReader.fromData(readSegment(file));

    expect(reloaded.raw.corpusHash).toBe('e2e-inline-corpus');
    expect(snapshot(reloaded)).toEqual(snapshot(IndexReader.fromData(built)));
  });
});

describe('pipeline: bundled static-v1 corpus (M1 exit criteria)', { timeout: 60_000 }, () => {
  it('indexes the bundled docs and answers term lookups with correct df/tf/positions', () => {
    const { docs, manifest, corpusHash } = loadCorpus(CORPUS_DIR);
    expect(docs.length).toBe(manifest.numDocuments);
    expect(corpusHash).toBe(manifest.documentsSha256);

    const writer = new IndexWriter({ corpusHash });
    for (const d of docs) writer.addDocument(d);
    const data = writer.finalize();
    const reader = IndexReader.fromData(data);

    expect(reader.numDocs()).toBe(manifest.numDocuments);
    expect(data.stats.vocabSize).toBeGreaterThan(5_000);
    expect(data.stats.avgDocLength).toBeGreaterThan(100);

    // spot checks across all five source books (words survive Porter)
    for (const term of ['sherlock', 'rabbit', 'victor', 'dorian', 'bennet']) {
      expect(reader.hasTerm(term), `expected term "${term}" in dictionary`).toBe(true);
    }
    // consonant + y applies: "Darcy" -> "darci" (step 1c), so the surface
    // form is deliberately absent from the dictionary
    expect(reader.hasTerm('darcy')).toBe(false);
    expect(reader.hasTerm('darci')).toBe(true);
    // "Holmes" stems to "holm" (step 1a + step 5) and only Sherlock docs use it
    const holm = reader.postingsForTerm('holm')!;
    expect(holm.df).toBeGreaterThanOrEqual(6);
    expect(holm.df).toBeLessThanOrEqual(manifest.sources.find((s) => s.id === 1661)!.parts);

    // df is consistent with a full scan
    let scanned = 0;
    holm.forEach(() => scanned++);
    expect(scanned).toBe(holm.df);

    // phrase readiness taken from the corpus itself: two tokens adjacent in
    // document 0 must be adjacent in positions
    const tokens = analyze(docs[0]!.text).filter((t) => !/^(the|and|of|a|to)$/.test(t.term));
    expect(tokens.length).toBeGreaterThan(4);
    const [t1, t2] = [tokens[0]!, tokens[1]!];
    const v1 = reader.postingsForTerm(t1.term)!;
    const v2 = reader.postingsForTerm(t2.term)!;
    let adjacent = false;
    v1.forEach((i, docId, tf) => {
      if (docId !== 0 || adjacent) return;
      const p1 = v1.positions(i);
      const positionsOf2 = new Set<number>();
      v2.forEach((j, d2) => {
        if (d2 === 0) for (const p of v2.positions(j)) positionsOf2.add(p);
      });
      adjacent = p1.some((p) => positionsOf2.has(p + 1));
    });
    expect(adjacent).toBe(true);
  });

  it('survives a serialize/load cycle on the bundled corpus', () => {
    const { docs, manifest, corpusHash } = loadCorpus(CORPUS_DIR);
    const writer = new IndexWriter({ corpusHash });
    for (const d of docs) writer.addDocument(d);
    const built = writer.finalize();

    const file = tmpFile('static-v1.aidx');
    writeSegment(built, file);
    const reloaded = IndexReader.fromData(readSegment(file));

    expect(reloaded.numDocs()).toBe(manifest.numDocuments);
    expect(reloaded.raw.corpusHash).toBe(corpusHash);
    expect(snapshot(reloaded)).toEqual(snapshot(IndexReader.fromData(built)));
  });
});
