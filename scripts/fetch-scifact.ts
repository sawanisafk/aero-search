/**
 * Fetches BEIR SciFact (Thakur et al. 2021) into data/corpora/scifact/ and
 * publishes the evaluation inputs into data/eval/ (committed provenance).
 *
 *   data/corpora/scifact/          gitignored (downloadable, ~3 MB zip)
 *     scifact.zip                  kept for provenance
 *     corpus.jsonl                 5,183 docs: {_id, title, text}
 *     queries.jsonl                1,109 queries: {_id, text}
 *     qrels/train.tsv, qrels/test.tsv
 *   data/eval/                     committed
 *     scifact-queries.jsonl        copy of queries.jsonl
 *     scifact-qrels.tsv            copy of qrels/test.tsv (339 judgments,
 *                                  300 distinct queries, binary grades)
 *     scifact.manifest.json        source/url/published-md5/actual sha256s/counts
 *
 * Verification: the zip's MD5 is checked against the value published by the
 * BEIR authors *before* extraction; sha256 of the zip and of corpus.jsonl is
 * recorded in the manifest (re-fetches must reproduce them).
 *
 * License note: the zip ships no license file; GitHub allenai/scifact shows
 * NOASSERTION. The manifest records this honestly — SciFact is published for
 * research/evaluation (Wadden et al. NAACL 2020); BEIR itself is Apache-2.0.
 *
 * Usage: npx tsx scripts/fetch-scifact.ts [--force]
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  downloadFile,
  extractArchive,
  hashFile,
  sha256,
  writeJson,
} from './lib/dataset.js';

const DATASET_URL = 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip';
/** MD5 published by the BEIR authors (README of beir repository). */
const PUBLISHED_MD5 = '5f7d1de60b170fc8027bb7898e2efca1';
const RETRIEVED = '2026-10-07';

const ROOT = process.cwd();
const CORPUS_DIR = path.join(ROOT, 'data', 'corpora', 'scifact');
const EVAL_DIR = path.join(ROOT, 'data', 'eval');
const ZIP_PATH = path.join(CORPUS_DIR, 'scifact.zip');

function countLines(file: string): number {
  const text = fs.readFileSync(file, 'utf8');
  let n = 0;
  for (const line of text.split('\n')) {
    if (line.trim() !== '') n++;
  }
  return n;
}

function copyEvalInputs(): void {
  const queriesSrc = path.join(CORPUS_DIR, 'queries.jsonl');
  const qrelsSrc = path.join(CORPUS_DIR, 'qrels', 'test.tsv');
  if (!fs.existsSync(queriesSrc) || !fs.existsSync(qrelsSrc)) {
    throw new Error(`extracted files missing under ${CORPUS_DIR}`);
  }
  fs.mkdirSync(EVAL_DIR, { recursive: true });
  fs.copyFileSync(queriesSrc, path.join(EVAL_DIR, 'scifact-queries.jsonl'));
  fs.copyFileSync(qrelsSrc, path.join(EVAL_DIR, 'scifact-qrels.tsv'));
}

/** Recompute provenance from the files on disk — valid on every path. */
function writeManifest(): void {
  const corpusFile = path.join(CORPUS_DIR, 'corpus.jsonl');
  const md5 = hashFile('md5', ZIP_PATH);
  if (md5 !== PUBLISHED_MD5) {
    throw new Error(`md5 mismatch on existing zip: published=${PUBLISHED_MD5} actual=${md5}`);
  }
  const corpusSha = sha256(fs.readFileSync(corpusFile));
  const documents = countLines(corpusFile);
  const queries = countLines(path.join(CORPUS_DIR, 'queries.jsonl'));
  const qrelsTestLines = countLines(path.join(CORPUS_DIR, 'qrels', 'test.tsv')) - 1; // header
  const qrelsTrainLines = countLines(path.join(CORPUS_DIR, 'qrels', 'train.tsv')) - 1;
  const testQrelsText = fs
    .readFileSync(path.join(CORPUS_DIR, 'qrels', 'test.tsv'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  const testQueryIds = new Set(testQrelsText.slice(1).map((l) => l.split('\t')[0]));

  copyEvalInputs();

  writeJson(path.join(EVAL_DIR, 'scifact.manifest.json'), {
    name: 'scifact',
    source: 'BEIR benchmark (https://github.com/beir-cellar/beir), dataset by Wadden et al. NAACL 2020',
    dataset_url: DATASET_URL,
    published_md5: PUBLISHED_MD5,
    verified_md5: md5,
    zip_sha256: hashFile('sha256', ZIP_PATH),
    corpus_jsonl_sha256: corpusSha,
    retrieved: RETRIEVED,
    counts: {
      documents,
      queries,
      qrels_test_rows: qrelsTestLines,
      qrels_test_queries: testQueryIds.size,
      qrels_train_rows: qrelsTrainLines,
    },
    license:
      'No license file in the dataset archive; GitHub allenai/scifact reports NOASSERTION. ' +
      'BEIR repository code is Apache-2.0. Used for research/evaluation with attribution: ' +
      'Wadden et al., "Fact or Fiction: Verifying Scientific Claims", NAACL 2020.',
    generator: 'scripts/fetch-scifact.ts',
  });

  console.log(
    `[scifact] ${documents} docs, ${queries} queries, ` +
      `${qrelsTestLines} test judgments (${testQueryIds.size} queries), ` +
      `${qrelsTrainLines} train judgments`,
  );
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const corpusFile = path.join(CORPUS_DIR, 'corpus.jsonl');

  if (fs.existsSync(corpusFile) && !force) {
    console.log('[scifact] already fetched — use --force to re-download');
    writeManifest();
    console.log('[scifact] manifest + data/eval inputs refreshed');
    return;
  }

  console.log(`[scifact] downloading ${DATASET_URL}`);
  await downloadFile(DATASET_URL, ZIP_PATH);

  const md5 = hashFile('md5', ZIP_PATH);
  if (md5 !== PUBLISHED_MD5) {
    throw new Error(
      `md5 mismatch: published=${PUBLISHED_MD5} actual=${md5} — refusing to extract a tampered/unexpected archive`,
    );
  }
  console.log(`[scifact] md5 OK (${md5})`);
  console.log(`[scifact] zip sha256 ${hashFile('sha256', ZIP_PATH)}`);

  const tmpDir = path.join(CORPUS_DIR, '.extract-tmp');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  extractArchive(ZIP_PATH, tmpDir);

  // zip unpacks into a top-level scifact/ directory — hoist contents up
  const inner = path.join(tmpDir, 'scifact');
  if (!fs.existsSync(inner)) throw new Error(`unexpected zip layout at ${tmpDir}`);
  for (const entry of fs.readdirSync(inner)) {
    const dest = path.join(CORPUS_DIR, entry);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(path.join(inner, entry), dest);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  writeManifest();
  console.log('[scifact] committed inputs written to data/eval/');
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
