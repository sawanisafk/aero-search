/**
 * Fetches the 20 Newsgroups (by-date) archive from figshare, converts it to
 * our JSONL corpus format, and records provenance in data/eval/ (committed).
 *
 *   data/corpora/20newsgroups/     gitignored (reproducible via manifest)
 *     20news-bydate.tar.gz         kept for provenance
 *     20news-bydate-train/, 20news-bydate-test/   raw extraction
 *     corpus.jsonl                 converted corpus: {_id, title, text}
 *                                 _id = "<split>/<group>/<file>"
 *   data/eval/
 *     20newsgroups.manifest.json   source/actual sha256s/counts/groups
 *
 * This corpus is DEV/latency material only: it ships no relevance judgments,
 * so it never feeds metric numbers (docs/EVALUATION.md).
 *
 * Conversion is deterministic: splits -> groups -> files, all sorted; the
 * subject header (unfolded) becomes the title, the body after the header
 * block becomes the text. Expected total: 18,846 documents (recorded as
 * actual; a mismatch is reported, not silently accepted).
 *
 * Usage: npx tsx scripts/fetch-20newsgroups.ts [--force]
 */

import fs from 'node:fs';
import path from 'node:path';
import { downloadFile, extractArchive, hashFile, sha256, writeJson } from './lib/dataset.js';

const DATASET_URL = 'https://ndownloader.figshare.com/files/5975967';
const EXPECTED_DOCS = 18846;
const RETRIEVED = '2026-10-07';

const ROOT = process.cwd();
const CORPUS_DIR = path.join(ROOT, 'data', 'corpora', '20newsgroups');
const EVAL_DIR = path.join(ROOT, 'data', 'eval');
const ARCHIVE_PATH = path.join(CORPUS_DIR, '20news-bydate.tar.gz');
const CORPUS_FILE = path.join(CORPUS_DIR, 'corpus.jsonl');
const MANIFEST_PATH = path.join(EVAL_DIR, '20newsgroups.manifest.json');

interface HeaderParse {
  readonly title: string;
  readonly body: string;
}

/** Split RFC-822-style header block from body; unfold the Subject header. */
function parseNewsFile(raw: string): HeaderParse {
  const normalized = raw.replace(/\r\n/g, '\n');
  const sep = normalized.indexOf('\n\n');
  const headerBlock = sep === -1 ? normalized : normalized.slice(0, sep);
  const body = sep === -1 ? '' : normalized.slice(sep + 2);

  const lines = headerBlock.split('\n');
  let subject = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^Subject:/i.test(line)) {
      subject = line.replace(/^Subject:\s*/i, '').trim();
      // unfold continuation lines (start with whitespace)
      while (i + 1 < lines.length && /^\s/.test(lines[i + 1]!)) {
        subject += ` ${lines[i + 1]!.trim()}`;
        i++;
      }
      break;
    }
  }
  return { title: subject, body: body.trim() };
}

function convert(): { documents: number; groups: string[]; skipped: number } {
  const splits = fs
    .readdirSync(CORPUS_DIR)
    .filter((e) => e !== '20news-bydate.tar.gz')
    .filter((e) => fs.statSync(path.join(CORPUS_DIR, e)).isDirectory())
    .sort();

  const lines: string[] = [];
  const groups = new Set<string>();
  let skipped = 0;

  for (const split of splits) {
    const splitDir = path.join(CORPUS_DIR, split);
    for (const group of fs.readdirSync(splitDir).sort()) {
      const groupDir = path.join(splitDir, group);
      if (!fs.statSync(groupDir).isDirectory()) continue;
      groups.add(group);
      for (const file of fs.readdirSync(groupDir).sort()) {
        const filePath = path.join(groupDir, file);
        if (!fs.statSync(filePath).isFile()) continue;
        const { title, body } = parseNewsFile(fs.readFileSync(filePath, 'utf8'));
        if (title === '' && body === '') {
          skipped++;
          continue;
        }
        lines.push(
          JSON.stringify({ _id: `${split}/${group}/${file}`, title, text: body }),
        );
      }
    }
  }

  fs.writeFileSync(CORPUS_FILE, `${lines.join('\n')}\n`, 'utf8');
  return { documents: lines.length, groups: [...groups].sort(), skipped };
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');

  if (fs.existsSync(CORPUS_FILE) && !force) {
    console.log('[20news] already fetched — use --force to re-download');
    return;
  }

  if (!fs.existsSync(ARCHIVE_PATH) || force) {
    console.log(`[20news] downloading ${DATASET_URL}`);
    await downloadFile(DATASET_URL, ARCHIVE_PATH);
  }
  const zipSha = hashFile('sha256', ARCHIVE_PATH);
  console.log(`[20news] archive sha256 ${zipSha}`);

  fs.rmSync(path.join(CORPUS_DIR, '20news-bydate-test'), { recursive: true, force: true });
  fs.rmSync(path.join(CORPUS_DIR, '20news-bydate-train'), { recursive: true, force: true });
  extractArchive(ARCHIVE_PATH, CORPUS_DIR);
  const splits = fs
    .readdirSync(CORPUS_DIR)
    .filter((e) => e.startsWith('20news-bydate-') && fs.statSync(path.join(CORPUS_DIR, e)).isDirectory())
    .sort();
  if (splits.length !== 2) {
    throw new Error(`unexpected archive layout under ${CORPUS_DIR}: ${splits.join(', ') || 'nothing'}`);
  }

  const { documents, groups, skipped } = convert();
  const corpusSha = sha256(fs.readFileSync(CORPUS_FILE));
  if (documents !== EXPECTED_DOCS) {
    console.warn(
      `[20news] WARNING: converted ${documents} documents, expected ${EXPECTED_DOCS} — recording actual`,
    );
  }

  writeJson(MANIFEST_PATH, {
    name: '20newsgroups-bydate',
    source:
      '20 Newsgroups by date (Ken Lang, 1995) as published on figshare item 5975967',
    dataset_url: DATASET_URL,
    archive_sha256: zipSha,
    corpus_jsonl_sha256: corpusSha,
    retrieved: RETRIEVED,
    counts: { documents, groups: groups.length, skipped_empty: skipped },
    expected_documents: EXPECTED_DOCS,
    groups,
    has_qrels: false,
    license:
      'No explicit license stated on the source page; dataset published for research use. ' +
      'Attribution: K. Lang, "Newsweeder: Learning to filter netnews", ICML 1995.',
    generator: 'scripts/fetch-20newsgroups.ts',
  });

  console.log(
    `[20news] done — ${documents} docs, ${groups.length} groups` +
      (skipped > 0 ? `, ${skipped} empty skipped` : ''),
  );
  console.log('[20news] manifest written to data/eval/20newsgroups.manifest.json');
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
