# static-v1 — bundled static fixture corpus

- **Documents:** 84 chapter documents (HTML + manifest)
- **Retrieved:** 2026-10-07
- **License:** Public domain (Project Gutenberg eBook license, https://www.gutenberg.org/policy/license.html)
- **Generator:** `scripts/build-static-corpus.ts` (deterministic; re-running
  reproduces identical bytes given the same source texts)

## Sources

- Pride and Prejudice (Jane Austen, 1813) — Gutenberg id 1342, 20 documents
- Frankenstein; or, The Modern Prometheus (Mary Shelley, 1818) — Gutenberg id 84, 20 documents
- Alice's Adventures in Wonderland (Lewis Carroll, 1865) — Gutenberg id 11, 12 documents
- The Adventures of Sherlock Holmes (Arthur Conan Doyle, 1892) — Gutenberg id 1661, 12 documents
- The Picture of Dorian Gray (Oscar Wilde, 1890) — Gutenberg id 174, 20 documents

## Layout

- `html/<id>.html` — one minimal-HTML document per chapter
- `documents.jsonl` — one record per document: title, url, provenance, sha256
- `manifest.json` — corpus-level provenance and `documentsSha256`

The index build hashes `documents.jsonl` to stamp the segment's corpus hash
(docs/DECISIONS.md evidence rule).
