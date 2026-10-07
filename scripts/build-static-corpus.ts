/**
 * Builds the bundled static fixture corpus `data/corpora/static-v1/` from
 * Project Gutenberg plain-text books.
 *
 * Source texts are downloaded once into a scratch directory (not committed):
 *   curl -L -o %TEMP%/gutenberg-src/pg<ID>.txt https://www.gutenberg.org/cache/epub/ID/ID.txt
 *
 * For each book it strips the Gutenberg boilerplate, splits the text into
 * chapter-sized documents with a per-book heading pattern (plus a cluster
 * filter that drops table-of-contents duplicates), wraps each part in minimal
 * HTML, and writes:
 *
 *   data/corpora/static-v1/
 *     html/<id>.html        one file per document
 *     documents.jsonl       one metadata record per document (+ per-file sha256)
 *     manifest.json         corpus-level provenance + sha256 of documents.jsonl
 *     README.md             human-readable provenance note
 *
 * Deterministic: fixed book list, fixed split rules, no timestamps other than
 * the recorded retrieval date — re-running reproduces identical bytes.
 *
 * Usage: npx tsx scripts/build-static-corpus.ts
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SOURCE_DIR = path.join(os.tmpdir(), 'gutenberg-src');
const OUT_DIR = path.join(process.cwd(), 'data', 'corpora', 'static-v1');
const RETRIEVED = '2026-10-07';
const LICENSE =
  'Public domain (Project Gutenberg eBook license, https://www.gutenberg.org/policy/license.html)';

interface BookConfig {
  id: number;
  slug: string;
  title: string;
  author: string;
  workDate: string;
  /** heading pattern applied per line; case-sensitive unless `ci` */
  heading: RegExp;
  /** drop headings that sit in a cluster (table-of-contents duplicates) */
  clusterFilter: boolean;
  /** cap on chapters taken (from the start of the book) */
  maxParts: number;
  minParts: number;
}

const BOOKS: BookConfig[] = [
  {
    id: 1342,
    slug: 'pride-prejudice',
    title: 'Pride and Prejudice',
    author: 'Jane Austen',
    workDate: '1813',
    heading: /^\s*chapter\s+[ivxlcdm]+[\].]*\s*$/i,
    clusterFilter: true,
    maxParts: 20,
    minParts: 40,
  },
  {
    id: 84,
    slug: 'frankenstein',
    title: 'Frankenstein; or, The Modern Prometheus',
    author: 'Mary Shelley',
    workDate: '1818',
    heading: /^\s*chapter\s+\d+\s*$/i,
    clusterFilter: true,
    maxParts: 20,
    minParts: 20,
  },
  {
    id: 11,
    slug: 'alice',
    title: "Alice's Adventures in Wonderland",
    author: 'Lewis Carroll',
    workDate: '1865',
    heading: /^\s*chapter\s+[ivxlcdm]+[\].]*\s*$/i,
    clusterFilter: true,
    maxParts: 20,
    minParts: 12,
  },
  {
    id: 1661,
    slug: 'sherlock-holmes',
    title: 'The Adventures of Sherlock Holmes',
    author: 'Arthur Conan Doyle',
    workDate: '1892',
    // story headings: "I. A SCANDAL IN BOHEMIA" — must be ALL CAPS so the
    // mixed-case table of contents and the standalone inner "I." / "II."
    // section numerals inside stories are not treated as splits; includes
    // typographic quotes (e.g. "THE ENGINEER\u2019S THUMB")
    heading: /^\s*[IVXLC]+\.\s+[A-Z][A-Z0-9 ,.:'\u2019\u2018-]+$/,
    clusterFilter: false,
    maxParts: 20,
    minParts: 12,
  },
  {
    id: 174,
    slug: 'dorian-gray',
    title: 'The Picture of Dorian Gray',
    author: 'Oscar Wilde',
    workDate: '1890',
    heading: /^\s*chapter\s+[ivxlcdm]+[\].]*\s*$/i,
    clusterFilter: true,
    maxParts: 20,
    minParts: 20,
  },
];

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const sha256 = (buf: Buffer | string): string => crypto.createHash('sha256').update(buf).digest('hex');

function stripBoilerplate(text: string): string[] {
  const lines = text.split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\*\*\* START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/.test(lines[i]!)) {
      start = i + 1;
      break;
    }
  }
  for (let i = start; i < lines.length; i++) {
    if (/^\*\*\* END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

function findHeadings(lines: string[], heading: RegExp, clusterFilter: boolean): number[] {
  let matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (heading.test(lines[i]!)) matches.push(i);
  }
  if (clusterFilter) {
    // keep only headings isolated by >5 lines on both sides — table-of-
    // contents entries are clustered on consecutive lines
    matches = matches.filter((m, k) => {
      const prevFar = k === 0 || m - matches[k - 1]! > 5;
      const nextFar = k === matches.length - 1 || matches[k + 1]! - m > 5;
      return prevFar && nextFar;
    });
  }
  return matches;
}

function partToHtml(book: BookConfig, heading: string, body: string): string {
  const docTitle = `${book.title} — ${heading}`;
  const cleaned = body
    .replace(/\[Illustration[\s\S]*?\]/g, '')
    .replace(/\r/g, '')
    .trim();
  const paragraphs = cleaned
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
  const bodyHtml = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n');
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(docTitle)}</title>`,
    `<meta name="author" content="${escapeHtml(book.author)}">`,
    `<meta name="source" content="https://www.gutenberg.org/cache/epub/${book.id}">`,
    '</head>',
    '<body>',
    `<h1>${escapeHtml(docTitle)}</h1>`,
    bodyHtml,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

interface DocRecord {
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

function main(): void {
  fs.mkdirSync(path.join(OUT_DIR, 'html'), { recursive: true });

  const records: DocRecord[] = [];
  const sourceSummaries: { id: number; title: string; author: string; workDate: string; parts: number }[] = [];

  for (const book of BOOKS) {
    const srcPath = path.join(SOURCE_DIR, `pg${book.id}.txt`);
    if (!fs.existsSync(srcPath)) {
      throw new Error(`missing source ${srcPath} — run the curl download command first`);
    }
    const lines = stripBoilerplate(fs.readFileSync(srcPath, 'utf8'));
    const headings = findHeadings(lines, book.heading, book.clusterFilter);
    if (headings.length < book.minParts) {
      throw new Error(
        `${book.slug}: found ${headings.length} headings, expected >= ${book.minParts} — splitter config needs review`,
      );
    }
    const take = Math.min(book.maxParts, headings.length);
    sourceSummaries.push({
      id: book.id,
      title: book.title,
      author: book.author,
      workDate: book.workDate,
      parts: take,
    });

    for (let p = 0; p < take; p++) {
      const from = headings[p]!;
      const to = p + 1 < headings.length ? headings[p + 1]! : lines.length;
      // normalize the raw heading for display: collapse whitespace and drop
      // trailing book-keeping marks like "Chapter I.]" or "CHAPTER II."
      const heading = lines[from]!.trim().replace(/\s+/g, ' ').replace(/[\].]+$/, '').trim();
      const body = lines.slice(from + 1, to).join('\n');
      const idx = p + 1;
      const id = `${book.slug}-${String(idx).padStart(2, '0')}`;
      const file = `html/${id}.html`;
      const html = partToHtml(book, heading, body);
      const words = body.trim().split(/\s+/).length;
      if (words < 30) throw new Error(`${file}: suspiciously short (${words} words)`);
      fs.writeFileSync(path.join(OUT_DIR, file), html, 'utf8');
      records.push({
        id,
        file,
        title: `${book.title} — ${heading}`,
        url: `https://www.gutenberg.org/cache/epub/${book.id}/pg${book.id}.txt#part-${idx}`,
        source: 'project-gutenberg',
        sourceUrl: `https://www.gutenberg.org/cache/epub/${book.id}/pg${book.id}.txt`,
        license: LICENSE,
        workDate: book.workDate,
        retrieved: RETRIEVED,
        sha256: sha256(html),
      });
    }
    console.log(
      `${book.slug}: ${headings.length} headings found, took ${take} (headings sample: ${headings
        .slice(0, 3)
        .map((h) => `${h + 1}:${lines[h]!.trim()}`)
        .join(' | ')})`,
    );
  }

  const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const documentsSha256 = sha256(jsonl);
  fs.writeFileSync(path.join(OUT_DIR, 'documents.jsonl'), jsonl, 'utf8');

  const manifest = {
    name: 'static-v1',
    version: 1,
    description:
      'Bundled static fixture corpus: chapter documents extracted from public-domain Project Gutenberg books.',
    retrieved: RETRIEVED,
    license: LICENSE,
    generator: 'scripts/build-static-corpus.ts',
    numDocuments: records.length,
    documentsSha256,
    sources: sourceSummaries,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const readme = `# static-v1 — bundled static fixture corpus

- **Documents:** ${records.length} chapter documents (HTML + manifest)
- **Retrieved:** ${RETRIEVED}
- **License:** ${LICENSE}
- **Generator:** \`scripts/build-static-corpus.ts\` (deterministic; re-running
  reproduces identical bytes given the same source texts)

## Sources

${sourceSummaries.map((s) => `- ${s.title} (${s.author}, ${s.workDate}) — Gutenberg id ${s.id}, ${s.parts} documents`).join('\n')}

## Layout

- \`html/<id>.html\` — one minimal-HTML document per chapter
- \`documents.jsonl\` — one record per document: title, url, provenance, sha256
- \`manifest.json\` — corpus-level provenance and \`documentsSha256\`

The index build hashes \`documents.jsonl\` to stamp the segment's corpus hash
(docs/DECISIONS.md evidence rule).
`;
  fs.writeFileSync(path.join(OUT_DIR, 'README.md'), readme, 'utf8');

  console.log(`\nwrote ${records.length} documents to ${OUT_DIR}`);
  console.log(`documentsSha256: ${documentsSha256}`);
}

main();
