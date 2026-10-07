/**
 * Indexing benchmark — M1 evidence artifact generator.
 *
 * Measures, per corpus size: analyze+stage build time (docs/s), finalize,
 * serialize, deserialize, segment bytes, RSS/heap, and read-path latency
 * (full posting scan, position decode, dictionary lookup).
 *
 * Output: benchmarks/results/<timestamp>-index-benchmark.json containing
 * {config, git_sha, corpus_hash, timestamp} as required by the DEVELOPMENT.md
 * evidence rule. Numbers in reports must come from this file — never hand
 * copied from console output.
 *
 * Usage:
 *   npm run bench:index            # sizes 1000,10000 (default)
 *   npx tsx benchmarks/index-benchmark.ts --sizes 1000,10000,100000
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IndexWriter } from '../src/core/index/writer.js';
import { IndexReader } from '../src/core/index/reader.js';
import { serializeSegment, deserializeSegment } from '../src/storage/segment.js';
import { DEFAULT_SYNTHETIC, generateSyntheticCorpus } from '../scripts/lib/synthetic.js';

const sizes = (() => {
  const i = process.argv.indexOf('--sizes');
  const raw = i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : '1000,10000';
  return raw.split(',').map((s) => Number(s.trim()));
})();

const now = (): bigint => process.hrtime.bigint();
const msSince = (t: bigint): number => Number(now() - t) / 1e6;
const round = (v: number, d = 2): number => Number(v.toFixed(d));
const mb = (bytes: number): number => round(bytes / (1024 * 1024), 1);

interface SizeResult {
  numDocs: number;
  corpusHash: string;
  corpusGenerateMs: number;
  buildMs: number;
  docsPerSec: number;
  finalizeMs: number;
  serializeMs: number;
  deserializeMs: number;
  segmentBytes: number;
  rssAfterBuildMb: number;
  heapAfterBuildMb: number;
  vocabSize: number;
  numPostings: number;
  totalPositions: number;
  totalTokens: number;
  avgDocLength: number;
  fullScanMs: number;
  positionDecodeMs: number;
  positionDecodePerOpUs: number;
  dictHitLookupMs: number;
  dictMissLookupMs: number;
}

function fullScan(reader: IndexReader): number {
  const t = now();
  let acc = 0;
  for (const term of reader.raw.terms) {
    reader.postingsForTerm(term)!.forEach((_i, _docId, tf) => {
      acc += tf;
    });
  }
  const ms = msSince(t);
  if (acc < 0) throw new Error('unreachable'); // keep acc used
  return ms;
}

function positionDecode(reader: IndexReader, sample: number): { totalMs: number; ops: number } {
  const data = reader.raw;
  const t = now();
  let ops = 0;
  // deterministic sample: stride through postings (no RNG dependency)
  const total = data.stats.numPostings;
  const stride = Math.max(1, Math.floor(total / sample));
  for (let termId = 0; termId < data.stats.vocabSize; termId++) {
    const from = data.docOffsets[termId]!;
    const to = data.docOffsets[termId + 1]!;
    for (let i = from; i < to; i += stride) {
      reader.postings(termId).positions(i);
      ops++;
    }
  }
  return { totalMs: msSince(t), ops };
}

function dictLookup(reader: IndexReader, terms: string[]): number {
  const t = now();
  let hits = 0;
  for (const term of terms) if (reader.getTermId(term) !== undefined) hits++;
  const ms = msSince(t);
  if (hits < 0) throw new Error('unreachable');
  return ms;
}

function dictMiss(reader: IndexReader, n: number): number {
  const t = now();
  let misses = 0;
  for (let i = 0; i < n; i++) if (reader.getTermId(`zzqnotaword${i}`) === undefined) misses++;
  const ms = msSince(t);
  if (misses !== n) throw new Error('unexpected dictionary hit');
  return ms;
}

function runSize(numDocs: number): SizeResult {
  const tGen = now();
  const corpus = generateSyntheticCorpus({
    ...DEFAULT_SYNTHETIC,
    numDocs,
  });
  const corpusGenerateMs = msSince(tGen);

  const writer = new IndexWriter({ corpusHash: corpus.corpusHash });
  const tBuild = now();
  for (const doc of corpus.docs) writer.addDocument(doc);
  const buildMs = msSince(tBuild);

  const tFinal = now();
  const data = writer.finalize();
  const finalizeMs = msSince(tFinal);

  const mem = process.memoryUsage();

  const tSer = now();
  const buf = serializeSegment(data);
  const serializeMs = msSince(tSer);

  const tDes = now();
  const reloaded = deserializeSegment(buf);
  const deserializeMs = msSince(tDes);
  const reader = IndexReader.fromData(reloaded);

  // warm up the read path, then take the best of 3 full scans
  fullScan(reader);
  const scans = [fullScan(reader), fullScan(reader), fullScan(reader)];

  const pos = positionDecode(reader, 5_000);

  // deterministic lookup samples: every 500th term, repeated
  const lookupTerms: string[] = [];
  for (let i = 0; i < data.terms.length; i += Math.max(1, Math.floor(data.terms.length / 2_000))) {
    lookupTerms.push(data.terms[i]!);
  }
  dictLookup(reader, lookupTerms); // warm up
  const hitMs = dictLookup(reader, lookupTerms);
  const missMs = dictMiss(reader, 2_000);

  let totalPositions = 0;
  for (let i = 0; i < data.tfs.length; i++) totalPositions += data.tfs[i]!;

  return {
    numDocs,
    corpusHash: corpus.corpusHash,
    corpusGenerateMs: round(corpusGenerateMs),
    buildMs: round(buildMs),
    docsPerSec: round((numDocs / buildMs) * 1000),
    finalizeMs: round(finalizeMs),
    serializeMs: round(serializeMs),
    deserializeMs: round(deserializeMs),
    segmentBytes: buf.length,
    rssAfterBuildMb: mb(mem.rss),
    heapAfterBuildMb: mb(mem.heapUsed),
    vocabSize: data.stats.vocabSize,
    numPostings: data.stats.numPostings,
    totalPositions,
    totalTokens: data.stats.totalTokens,
    avgDocLength: round(data.stats.avgDocLength, 1),
    fullScanMs: round(Math.min(...scans)),
    positionDecodeMs: round(pos.totalMs),
    positionDecodePerOpUs: round((pos.totalMs * 1000) / pos.ops, 2),
    dictHitLookupMs: round(hitMs),
    dictMissLookupMs: round(missMs),
  };
}

function main(): void {
  const gitSha = execSync('git rev-parse HEAD').toString().trim();
  const gitDirty = execSync('git status --porcelain').toString().trim().length > 0;
  const timestamp = new Date().toISOString();

  console.log(`index benchmark — git ${gitSha}${gitDirty ? ' (dirty)' : ''}, sizes: ${sizes.join(', ')}`);

  const results: SizeResult[] = [];
  for (const size of sizes) {
    console.log(`  running ${size} docs ...`);
    results.push(runSize(size));
  }

  const artifact = {
    schema: 'aero-search/index-benchmark/v1',
    timestamp,
    git_sha: gitSha,
    git_dirty: gitDirty,
    environment: {
      platform: os.platform(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model ?? 'unknown',
      node: process.version,
    },
    config: {
      sizes,
      ...DEFAULT_SYNTHETIC,
      note: 'buildMs covers analyze+staging (addDocument loop); finalize is the counting sort + delta encoding; fullScan decodes all docIds and tfs once (best of 3 after warm-up).',
    },
    corpus: results.map((r) => ({ numDocs: r.numDocs, corpusHash: r.corpusHash })),
    results,
  };

  const outDir = path.join(process.cwd(), 'benchmarks', 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = timestamp.replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${stamp}-index-benchmark.json`);
  fs.writeFileSync(outFile, JSON.stringify(artifact, null, 2) + '\n', 'utf8');

  console.log('\n  docs | build ms | docs/s | finalize | serialize | load | segment | vocab | postings | fullScan');
  for (const r of results) {
    console.log(
      `  ${String(r.numDocs).padStart(5)} | ${String(r.buildMs).padStart(8)} | ${String(r.docsPerSec).padStart(6)} | ` +
        `${String(r.finalizeMs).padStart(8)} | ${String(r.serializeMs).padStart(9)} | ${String(r.deserializeMs).padStart(4)} | ` +
        `${String(mb(r.segmentBytes)).padStart(7)} MB | ${r.vocabSize} | ${r.numPostings} | ${r.fullScanMs} ms`,
    );
  }
  console.log(`\nwrote ${path.relative(process.cwd(), outFile)}`);
}

main();
