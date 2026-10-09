/**
 * Builds a persisted eval index (AIDX segment + corpus-id map) for one of the
 * evaluation corpora:
 *
 *   npx tsx scripts/build-eval-index.ts --corpus scifact
 *   npx tsx scripts/build-eval-index.ts --corpus 20newsgroups
 *   npx tsx scripts/build-eval-index.ts --corpus static-v1
 *   npx tsx scripts/build-eval-index.ts --corpus cqadupstack-tierb   (or -programmers/-unix/-tex, -tierc)
 *
 * Outputs (both gitignored, rebuildable from the corpus + manifest):
 *   data/index/<corpus>.aidx        serialized IndexData (corpusHash inside)
 *   data/index/<corpus>.ids.json    docId -> corpus document id, in line
 *                                   order of the source corpus (the eval
 *                                   module speaks corpus ids, not docIds)
 *
 * JSONL corpora (scifact, 20newsgroups) index `title + ". " + text` as the
 * single indexed field (M1 field model — docs/INDEXING.md). static-v1 goes
 * through the bundled HTML loader as in the M1 pipeline test.
 */

import fs from 'node:fs';
import path from 'node:path';
import { IndexWriter } from '../src/core/index/writer.js';
import { writeSegment } from '../src/storage/segment.js';
import { loadCorpus } from '../src/storage/corpus.js';
import { sha256 } from './lib/dataset.js';

interface JsonlDoc {
  _id: string;
  title?: string;
  text?: string;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  const pref = `${flag}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit?.slice(pref.length);
}

function loadJsonlCorpus(dir: string): {
  docs: { title: string; url: string; text: string }[];
  ids: string[];
  corpusHash: string;
} {
  const file = path.join(dir, 'corpus.jsonl');
  if (!fs.existsSync(file)) {
    throw new Error(`missing ${file} — run the corpus fetch script first (see npm scripts)`);
  }
  const raw = fs.readFileSync(file);
  const corpusHash = sha256(raw);
  const docs: { title: string; url: string; text: string }[] = [];
  const ids: string[] = [];
  for (const line of raw.toString('utf8').split('\n')) {
    if (line.trim() === '') continue;
    const d = JSON.parse(line) as JsonlDoc;
    if (typeof d._id !== 'string') throw new Error('corpus.jsonl line without _id');
    const title = d.title ?? '';
    const text = d.text ?? '';
    docs.push({
      title,
      url: `corpus://document/${encodeURIComponent(d._id)}`,
      text: title !== '' ? `${title}. ${text}` : text,
    });
    ids.push(d._id);
  }
  return { docs, ids, corpusHash };
}

function loadStaticCorpus(dir: string): {
  docs: { title: string; url: string; text: string }[];
  ids: string[];
  corpusHash: string;
} {
  const loaded = loadCorpus(dir);
  const ids = fs
    .readFileSync(path.join(dir, 'documents.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => (JSON.parse(l) as { id: string }).id);
  if (ids.length !== loaded.docs.length) {
    throw new Error(`static-v1 id/doc mismatch: ${ids.length} ids vs ${loaded.docs.length} docs`);
  }
  return { docs: loaded.docs, ids, corpusHash: loaded.corpusHash };
}

function main(): void {
  const corpus = argValue('--corpus') ?? process.argv[2];
  if (corpus === undefined || corpus.startsWith('--')) {
    throw new Error(
      'usage: build-eval-index.ts --corpus cqadupstack-tierb|cqadupstack-programmers|cqadupstack-unix|cqadupstack-tex|cqadupstack-tierc|scifact|20newsgroups|static-v1',
    );
  }
  const dir = path.join(process.cwd(), 'data', 'corpora', corpus);
  if (!fs.existsSync(dir)) throw new Error(`corpus directory not found: ${dir}`);

  const t0 = performance.now();
  const { docs, ids, corpusHash } =
    corpus === 'static-v1' ? loadStaticCorpus(dir) : loadJsonlCorpus(dir);

  const writer = new IndexWriter({ corpusHash });
  for (const doc of docs) writer.addDocument(doc);
  const data = writer.finalize();
  const elapsed = performance.now() - t0;

  const outSegment = path.join(process.cwd(), 'data', 'index', `${corpus}.aidx`);
  const bytes = writeSegment(data, outSegment);
  fs.writeFileSync(
    path.join(process.cwd(), 'data', 'index', `${corpus}.ids.json`),
    `${JSON.stringify(ids)}\n`,
    'utf8',
  );

  console.log(`[index] ${corpus}`);
  console.log(`  docs       ${data.stats.numDocs}`);
  console.log(`  vocab      ${data.stats.vocabSize} terms, ${data.stats.numPostings} postings`);
  console.log(`  avgdl      ${data.stats.avgDocLength.toFixed(1)} tokens`);
  console.log(`  corpusHash ${data.corpusHash}`);
  console.log(`  segment    ${outSegment} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`  built in   ${elapsed.toFixed(0)} ms`);
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
