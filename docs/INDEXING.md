# Indexing

How the inverted/positional index is built, laid out, persisted, and measured.
Architecture: [ARCHITECTURE.md](ARCHITECTURE.md) · Decisions: [DECISIONS.md](DECISIONS.md) ·
Plan: [DEVELOPMENT.md](DEVELOPMENT.md).

---

## Pipeline

```
document text
  └─ analyze()            shared index-time AND query-time path (src/core/text/)
       NFKC -> lowercase -> tokenize -> stop-word filter -> Porter stem
       emits dense token positions over the *emitted* stream
  └─ IndexWriter staging  one posting per distinct term of the doc:
                          (termId, docId, position run)     [src/core/index/writer.ts]
  └─ finalize()           stable counting sort by termId, then delta encoding
  └─ IndexData            packed typed arrays (pure data)
  └─ serializeSegment()   AIDX binary file                   [src/storage/segment.ts]
  └─ IndexReader          dictionary + sequential/position decoding
```

Key properties:

- **One analyzer, two call sites.** Documents and queries go through the same
  `analyze()`; a query term can never diverge from the indexed form.
- **Positions are dense over the emitted token stream.** Stop-words consume no
  position, so `"machine learning"` (positions 0,1) stays adjacent even when
  stop-words sit between words in the raw text. The analysis config is frozen
  into the segment header so query time reuses exactly the same rules.
- **Stemming is first-class.** Porter (ANSI C reference port) validated against
  all 23,531 official test vectors. Surface forms differ from dictionary terms —
  `Darcy` indexes as `darci`, `Holmes` as `holm` — tests assert this explicitly.

## Data structures (`IndexData`)

| Field | Type | Length | Encoding |
|---|---|---|---|
| `terms` | `string[]` | vocabSize | termId -> term (first-seen order) |
| `termIndex` | `Map<string, number>` | vocabSize | rebuilt on load, never persisted |
| `docOffsets` | `Uint32Array` | vocabSize + 1 | prefix sums; term t owns `[docOffsets[t], docOffsets[t+1])` |
| `dfs` | `Uint32Array` | vocabSize | derived: `docOffsets[t+1] - docOffsets[t]` |
| `docDeltas` | `Uint32Array` | numPostings | per term: first doc id absolute, then ascending gaps |
| `tfs` | `Uint16Array` | numPostings | term frequency per posting (build throws above 65,535) |
| `posDeltas` | `Uint32Array` | totalPositions | per posting run: first position absolute, then gaps |
| `posRunStarts` | `Uint32Array` | numPostings + 1 | monotonic offsets into `posDeltas` (sentinel at end) |
| `docLengths` | `Uint32Array` | numDocs | indexed term count per doc (BM25 `dl`) |
| `docs` | `DocMeta[]` | numDocs | `{docId, title, url, wordCount}`; bodies stay in storage |
| `stats` | `IndexStats` | — | `numDocs, vocabSize, numPostings, totalTokens, avgDocLength` |
| `corpusHash` | `string` | — | sha256 of the source corpus (see Persistence) |

Why typed arrays: one JS object per posting would cost GBs at 100K docs;
packed arrays keep the whole index in a few hundred MB (measured below).

### Build: two-phase, counting sort

Phase 1 stages postings in document order (arrays grow amortized O(1)).
Phase 2 `finalize()`:

1. **Count** occurrences per `termId` -> `docOffsets` (prefix sums).
2. **Scatter** each staged posting to its slot via a cursor array — a stable
   counting sort, O(postings + vocab), no comparison sort. Doc ids inside a
   term stay ascending because documents are added in order; the first-of-term
   entry then stores the absolute id and the rest are gaps.
3. **Delta encode** positions into `posDeltas` in slot order so
   `posRunStarts` is monotonic (runs are located in the staging buffer by a
   per-slot `runLoc` index, then copied out sequentially).

### Read access patterns (`IndexReader`, `TermPostingsView`)

- `getTermId(term)` — hash lookup, O(1).
- `docIds()` / `forEach(...)` — one sequential pass decodes a term's whole
  posting list (delta decoding wants exactly this order).
- `positions(postingIndex)` — O(tf) decode of one run. **`postingIndex` is the
  global index** (what `forEach` hands you), not a term-local ordinal.
- No skip lists / WAND yet — added only if benchmarks demand them.

## Persistence (AIDX)

Binary little-endian format, version + corpus hash in the header
(full field-by-field spec in the header of `src/storage/segment.ts`):

```
header   magic "AIDX" | version u16 | numDocs/vocabSize/numPostings/
         numPositions/totalTokens u32 | corpusHash section
sections length-prefixed: analysis JSON, term offsets + strtab,
         docOffsets, docDeltas, tfs, posDeltas, posRunStarts,
         docLengths, doc metadata (title/url/wordCount per doc)
```

- `dfs`, `termIndex`, `stats` are **rebuilt on load**, not stored.
- Each section is copied into a fresh typed array, so loaded segments never
  alias the file buffer and file offsets need no alignment padding.
- **Corpus hash:** the builder computes sha256 over the corpus bytes
  (for `static-v1`: `documents.jsonl`) and stamps it into both writer and
  segment header — every benchmark/reported number can be tied to the exact
  corpus build (`DEVELOPMENT.md` evidence rule).
- `exportSegmentJson()` dumps a human-readable JSON with decoded postings and
  positions for debugging.
- Round-trip tests assert **bit-identical buffers and identical query
  results** after save/load.

## Fixture corpora

- **`data/corpora/static-v1/`** (committed): 84 chapter documents from five
  public-domain Project Gutenberg books (Pride and Prejudice, Frankenstein,
  Alice, Sherlock Holmes, Dorian Gray), with per-file sha256, manifest
  (source/date/license) and README. Loader verifies the full hash chain.
  Regenerate: `npm run corpus:static`.
- **`data/corpora/synthetic-v1/`** (gitignored, reproducible): seeded
  Zipf-distributed pseudo-English corpora for benchmarks.
  Regenerate: `npm run corpus:synthetic`.
  Known limitation: unigram stream, no topical structure — measures indexing
  cost and index shape, not ranking quality (ranking uses static-v1 and later
  the crawled corpus).

## Benchmark (M1)

Artifact: `benchmarks/results/2026-10-07T13-22-21-192Z-index-benchmark.json`
(config + git sha `44781e8` + corpus hashes + timestamp, committed as
evidence). Reproduce: `npm run bench:index`.

Synthetic corpora, seed 42, 50K vocab, ~200 words/doc. AMD Ryzen 7 4800H,
Node v24.13.0, Windows.

| docs | build (analyze+stage) | docs/s | finalize | serialize | load | segment | vocab | postings | full posting scan | RSS |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 619 ms | 1,615 | 23 ms | 20 ms | 15 ms | 2.6 MB | 27,286 | 144,997 | 2.9 ms | 83 MB |
| 10,000 | 5,631 ms | 1,776 | 138 ms | 41 ms | 41 ms | 22.7 MB | 46,555 | 1,454,928 | 8.8 ms | 210 MB |

Read-path detail (10K): position decode ≈ 0.08 µs/op, dictionary hit lookup
0.53 ms per 2K lookups. The full scan decodes all 1.45M doc ids + tfs in
< 9 ms — headroom for scoring work in M2.

Observations:

- **Build dominates** (tokenization + Porter over 2M tokens); finalize,
  serialize and load are one order of magnitude smaller.
- Segment size ≈ 6 B/posting (docDelta u32 + tf u16) + 4 B/position.
- Larger corpora amortize better (1.6K -> 1.8K docs/s) — dictionary/staging
  overhead per doc shrinks with vocab reuse.

## Deferred (documented paths, not built in M1)

- **Multiple indexed fields** (title vs body weighting): single `text` field
  now; `AddDocumentInput` and the segment format gain per-field arrays in M4
  (field weighting for hybrid ranking).
- **Skip lists / WAND** for early termination — revisit at M6 numbers.
- **Incremental indexing** (merge segments): rebuild-only for now; PostgreSQL
  remains the system of record and the index is a derived artifact (ADR-006).
- **HTML parsing**: the fixture loader strips tags from our own known files;
  the production extraction pipeline ships with the crawler (M3).
