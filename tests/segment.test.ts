import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { IndexWriter } from '../src/core/index/writer.js';
import { IndexReader } from '../src/core/index/reader.js';
import type { AddDocumentInput, IndexData } from '../src/core/index/types.js';
import {
  deserializeSegment,
  exportSegmentJson,
  readSegment,
  serializeSegment,
  writeSegment,
} from '../src/storage/segment.js';

const DOCS: AddDocumentInput[] = [
  { title: 'The Cat Sat', url: 'https://example.com/0', text: 'the cat sat on the mat' },
  { title: 'The Dog Sat', url: 'https://example.com/1', text: 'the dog sat on the log' },
  {
    title: 'Machine Learning',
    url: 'https://example.com/2',
    text: 'machine learning algorithms learn patterns from data',
  },
  {
    title: 'Learning Machines',
    url: 'https://example.com/3',
    text: 'the machine learned quickly and machines learn fast',
  },
];

/** sha256 of the literal string "static-v1" — exercises the header field. */
const CORPUS_HASH = 'b1b1e8e0d6a2d79d9e9c1b0f4a1b0e6b8ff2f9f5e01d6b05d6e0f1f0a4e6d2c8';

function buildIndex(docs: AddDocumentInput[] = DOCS): IndexData {
  const writer = new IndexWriter({ corpusHash: CORPUS_HASH });
  for (const d of docs) writer.addDocument(d);
  return writer.finalize();
}

const tmpDirs: string[] = [];
function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidx-test-'));
  tmpDirs.push(dir);
  return path.join(dir, name);
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('AIDX segment persistence', () => {
  it('round-trips every buffer, document and stat exactly', () => {
    const original = buildIndex();
    const restored = deserializeSegment(serializeSegment(original));

    expect(restored.corpusHash).toBe(CORPUS_HASH);
    expect(restored.terms).toEqual(original.terms);
    expect([...restored.termIndex]).toEqual([...original.termIndex]);
    expect(restored.docOffsets).toEqual(original.docOffsets);
    expect(restored.dfs).toEqual(original.dfs);
    expect(restored.docDeltas).toEqual(original.docDeltas);
    expect(restored.tfs).toEqual(original.tfs);
    expect(restored.posDeltas).toEqual(original.posDeltas);
    expect(restored.posRunStarts).toEqual(original.posRunStarts);
    expect(restored.docLengths).toEqual(original.docLengths);
    expect(restored.docs).toEqual(original.docs);
    expect(restored.stats).toEqual(original.stats);
    expect(restored.analysis).toEqual(original.analysis);
  });

  it('keeps phrase-level positions usable after a round trip', () => {
    const restored = deserializeSegment(serializeSegment(buildIndex()));
    const reader = IndexReader.fromData(restored);
    const machine = reader.postingsForTerm('machin')!;
    const learn = reader.postingsForTerm('learn')!;

    const positionsOf = (view: ReturnType<typeof reader.postingsForTerm>, docId: number) => {
      let out: number[] = [];
      view!.forEach((i, d) => {
        if (d === docId) out = view!.positions(i);
      });
      return out;
    };

    expect(positionsOf(machine, 3)).toEqual([0, 3]);
    expect(positionsOf(learn, 3)).toEqual([1, 4]);
    expect(positionsOf(learn, 2)).toEqual([1, 3]);
  });

  it('round-trips an empty corpus', () => {
    const empty = buildIndex([]);
    const restored = deserializeSegment(serializeSegment(empty));
    expect(restored.corpusHash).toBe(CORPUS_HASH);
    expect(restored.stats.numDocs).toBe(0);
    expect(restored.stats.vocabSize).toBe(0);
    expect(restored.terms).toEqual([]);
    expect(restored.docs).toEqual([]);
    expect(restored.docOffsets.length).toBe(1);
    expect(restored.docDeltas.length).toBe(0);
    expect(restored.posRunStarts.length).toBe(1);
  });

  it('round-trips through the filesystem', () => {
    const original = buildIndex();
    const file = tmpFile('segment.aidx');
    const bytes = writeSegment(original, file);
    expect(bytes).toBe(serializeSegment(original).length);
    expect(fs.statSync(file).size).toBe(bytes);

    const restored = readSegment(file);
    expect(restored.terms).toEqual(original.terms);
    expect(restored.stats).toEqual(original.stats);
    expect(restored.posDeltas).toEqual(original.posDeltas);
  });

  it('rejects wrong magic and truncated data', () => {
    const buf = serializeSegment(buildIndex());
    const bad = Buffer.from(buf);
    bad.write('XXXX', 0, 'ascii');
    expect(() => deserializeSegment(bad)).toThrow(/bad magic/);
    expect(() => deserializeSegment(buf.subarray(0, 16))).toThrow(/truncated/);
  });

  it('exports a debug JSON dump with decoded postings', () => {
    const original = buildIndex();
    const file = tmpFile('segment.json');
    exportSegmentJson(original, file);

    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.stats).toEqual(original.stats);
    expect(parsed.docs).toEqual(original.docs);
    const learn = parsed.postings.find((p: { term: string }) => p.term === 'learn');
    expect(learn.df).toBe(2);
    expect(learn.postings).toEqual([
      { docId: 2, tf: 2, positions: [1, 3] },
      { docId: 3, tf: 2, positions: [1, 4] },
    ]);
  });
});
