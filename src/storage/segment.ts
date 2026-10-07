/**
 * AIDX segment persistence — binary serialization of an IndexData segment.
 *
 * Layout (little-endian):
 *
 *   header
 *     magic          4s   "AIDX"
 *     version        u16  1
 *     numDocs        u32
 *     vocabSize      u32
 *     totalPostings  u32
 *     totalPositions u32
 *     totalTokens    u32
 *
 *   sections (each: u32 byteLength + payload)
 *     1. analysis     UTF-8 JSON of AnalysisConfig (frozen at build time)
 *     2. termOffsets  u32[vocabSize + 1]  strtab starts (last = strtab end)
 *     3. termStrtab   UTF-8 terms concatenated
 *     4. docOffsets   u32[vocabSize + 1]
 *     5. docDeltas    u32[numPostings]    delta-encoded doc ids
 *     6. tfs          u16[numPostings]
 *     7. posDeltas    u32[numPositions]   run-first-absolute position gaps
 *     8. posRunStarts u32[numPostings + 1]
 *     9. docLengths   u32[numDocs]
 *    10. docsMeta     numDocs x { u32 titleLen, bytes, u32 urlLen, bytes,
 *                                 u32 wordCount }   (docId = array position)
 *
 * Not serialized (rebuilt on load): termIndex (hash map), dfs (prefix sums
 * over docOffsets), stats (derived from header + docLengths).
 *
 * Readers copy each section into fresh typed arrays, so file offsets need no
 * alignment padding and the loaded segment is independent of the file buffer.
 * Delta encoding and positions are preserved verbatim — phrase/proximity
 * matching works identically before and after a round trip.
 *
 * The PostgreSQL database is the system of record; an AIDX segment is a
 * rebuildable derived artifact (docs/DECISIONS.md ADR-006).
 */

import fs from 'node:fs';
import path from 'node:path';
import { computeDfs } from '../core/index/writer.js';
import { IndexReader } from '../core/index/reader.js';
import type { AnalysisConfig } from '../core/text/analyze.js';
import type { DocMeta, IndexData, IndexStats } from '../core/index/types.js';

const MAGIC = Buffer.from('AIDX', 'ascii');
export const AIDX_VERSION = 1;

class ChunkWriter {
  private readonly chunks: Buffer[] = [];
  private len = 0;

  get byteLength(): number {
    return this.len;
  }

  bytes(b: Buffer): void {
    this.chunks.push(b);
    this.len += b.length;
  }

  u16(v: number): void {
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16LE(v, 0);
    this.bytes(b);
  }

  u32(v: number): void {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(v, 0);
    this.bytes(b);
  }

  u32Array(a: Uint32Array): void {
    this.section(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  }

  u16Array(a: Uint16Array): void {
    this.section(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  }

  /** length-prefixed section: u32 byteLength + payload */
  section(payload: Buffer): void {
    this.u32(payload.length);
    this.bytes(payload);
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.len);
  }
}

class Cursor {
  constructor(
    private readonly buf: Buffer,
    private pos = 0,
  ) {}

  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new Error(`AIDX truncated: need ${n} bytes at offset ${this.pos}`);
    }
  }

  ascii(n: number): Buffer {
    this.need(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  section(): Buffer {
    const n = this.u32();
    this.need(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  /** Copy a section of `count` u32 values into a fresh aligned typed array. */
  u32Array(count: number): Uint32Array {
    const raw = this.section();
    if (raw.length !== count * 4) {
      throw new Error(`AIDX bad section: expected ${count * 4} bytes, got ${raw.length}`);
    }
    const ab = new ArrayBuffer(raw.length);
    new Uint8Array(ab).set(raw);
    return new Uint32Array(ab);
  }

  u16Array(count: number): Uint16Array {
    const raw = this.section();
    if (raw.length !== count * 2) {
      throw new Error(`AIDX bad section: expected ${count * 2} bytes, got ${raw.length}`);
    }
    const ab = new ArrayBuffer(raw.length);
    new Uint8Array(ab).set(raw);
    return new Uint16Array(ab);
  }
}

export function serializeSegment(data: IndexData): Buffer {
  const { stats, analysis, docs, docLengths, docOffsets, docDeltas, tfs, posDeltas, posRunStarts } = data;

  const w = new ChunkWriter();
  w.bytes(MAGIC);
  w.u16(AIDX_VERSION);
  w.u32(stats.numDocs);
  w.u32(stats.vocabSize);
  w.u32(stats.numPostings);
  w.u32(posDeltas.length);
  w.u32(stats.totalTokens);

  w.section(Buffer.from(JSON.stringify(analysis), 'utf8'));

  // term dictionary as offset table + string blob
  const termBufs = data.terms.map((t) => Buffer.from(t, 'utf8'));
  const offsets = new Uint32Array(data.terms.length + 1);
  let acc = 0;
  for (let i = 0; i < termBufs.length; i++) {
    offsets[i] = acc;
    acc += termBufs[i]!.length;
  }
  offsets[data.terms.length] = acc;
  w.u32Array(offsets);
  w.section(Buffer.concat(termBufs, acc));

  w.u32Array(docOffsets);
  w.u32Array(docDeltas);
  w.u16Array(tfs);
  w.u32Array(posDeltas);
  w.u32Array(posRunStarts);
  w.u32Array(docLengths);

  // doc metadata (docId is the array position)
  for (const d of docs) {
    const title = Buffer.from(d.title, 'utf8');
    const url = Buffer.from(d.url, 'utf8');
    w.u32(title.length);
    w.bytes(title);
    w.u32(url.length);
    w.bytes(url);
    w.u32(d.wordCount);
  }

  return w.toBuffer();
}

export function deserializeSegment(buf: Buffer): IndexData {
  const c = new Cursor(buf);
  if (!c.ascii(4).equals(MAGIC)) throw new Error('not an AIDX segment (bad magic)');
  const version = c.u16();
  if (version !== AIDX_VERSION) throw new Error(`unsupported AIDX version ${version}`);

  const numDocs = c.u32();
  const vocabSize = c.u32();
  const numPostings = c.u32();
  const numPositions = c.u32();
  const totalTokens = c.u32();

  const analysis = JSON.parse(c.section().toString('utf8')) as AnalysisConfig;

  const termOffsets = c.u32Array(vocabSize + 1);
  const strtab = c.section();
  const terms: string[] = new Array(vocabSize);
  for (let t = 0; t < vocabSize; t++) {
    terms[t] = strtab.toString('utf8', termOffsets[t]!, termOffsets[t + 1]!);
  }

  const docOffsets = c.u32Array(vocabSize + 1);
  const docDeltas = c.u32Array(numPostings);
  const tfs = c.u16Array(numPostings);
  const posDeltas = c.u32Array(numPositions);
  const posRunStarts = c.u32Array(numPostings + 1);
  const docLengths = c.u32Array(numDocs);

  const docs: DocMeta[] = new Array(numDocs);
  for (let i = 0; i < numDocs; i++) {
    const title = c.section().toString('utf8');
    const url = c.section().toString('utf8');
    const wordCount = c.u32();
    docs[i] = { docId: i, title, url, wordCount };
  }

  const termIndex = new Map<string, number>();
  for (let t = 0; t < vocabSize; t++) termIndex.set(terms[t]!, t);

  const stats: IndexStats = {
    numDocs,
    vocabSize,
    numPostings,
    totalTokens,
    avgDocLength: numDocs > 0 ? totalTokens / numDocs : 0,
  };

  return {
    terms,
    termIndex,
    docOffsets,
    dfs: computeDfs(docOffsets),
    docDeltas,
    tfs,
    posDeltas,
    posRunStarts,
    docLengths,
    docs,
    stats,
    analysis,
  };
}

/** Serialize and write an AIDX segment; returns bytes written. */
export function writeSegment(data: IndexData, filePath: string): number {
  const buf = serializeSegment(data);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
  return buf.length;
}

export function readSegment(filePath: string): IndexData {
  return deserializeSegment(fs.readFileSync(filePath));
}

/**
 * Debug artifact: full human-readable dump of the segment including decoded
 * postings and positions. Intended for small corpora — never used on the
 * query path.
 */
export function exportSegmentJson(data: IndexData, filePath: string): void {
  const reader = IndexReader.fromData(data);
  const postings = data.terms.map((term, t) => {
    const view = reader.postings(t);
    const list: { docId: number; tf: number; positions: number[] }[] = [];
    view.forEach((i, docId, tf) => list.push({ docId, tf, positions: view.positions(i) }));
    return { term, df: view.df, postings: list };
  });
  const payload = {
    stats: data.stats,
    analysis: data.analysis,
    docs: data.docs,
    docLengths: Array.from(data.docLengths),
    postings,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}
