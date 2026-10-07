# Development Plan

Milestones, task breakdown, workflow conventions, and evidence rules.
Architecture: [ARCHITECTURE.md](ARCHITECTURE.md) · Decisions: [DECISIONS.md](DECISIONS.md).

---

## Workflow conventions

**Branches:** `main` (always green) + short-lived `feat/*`, `fix/*`, `docs/*` branches.
No heavyweight flow — solo project, merge when green.

**Commits (Conventional Commits):**

```
feat(index): implement positional inverted index
feat(ranking): add BM25 scoring
feat(crawler): implement URL frontier
fix(parser): handle malformed HTML
test(bm25): add ranking edge cases
perf(index): reduce posting-list memory usage
docs(architecture): document indexing pipeline
refactor(query): separate parsing from retrieval
chore(repo): initialize repository skeleton
```

Never: "update", "fix", "stuff", "changes", "final".

**Definition of done (every milestone):** code + unit tests passing (`npm test`,
`npm run typecheck`) + relevant doc updated + (where applicable) a committed benchmark/eval artifact.

**Evidence rule:** any number that may appear in the academic report must originate from a
committed artifact under `benchmarks/results/` or `runs/` containing `{config, git_sha,
corpus_hash, timestamp}`. Never fabricate or hand-edit a result.

**GitHub:** one milestone per GitHub Milestone; issues for features, bugs, research questions,
perf items.

---

## Milestones

| # | Milestone | Exit criteria |
|---|---|---|
| **M0** | Foundation | repo, TS toolchain, tests, Compose Postgres, docs skeleton, ADRs — **complete when `npm test` + `npm run typecheck` pass on a clean clone** |
| **M1** | Indexing core | tokenizer/normalizer/stopwords + Porter stemmer with test vectors; inverted **and positional** index built over bundled static docs; index serialization round-trip |
| **M2** | Retrieval + ranking + eval harness | Boolean AND/OR; TF-IDF (3 tf weightings); BM25 with k1/b; phrase + proximity; qrels v1; P@K/R@K/F1/MAP/NDCG@K runner; first real mode comparison (A vs B) |
| **M3** | Crawler + storage + PageRank | controlled crawl of seed set → Postgres; link graph; PageRank job; corpus manifest |
| **M4** | Hybrid + fuzzy | signal/normalizer/fusion architecture; modes A–E in `configs/`; RRF arm; fuzzy expansion for low-df terms; explanation payloads |
| **M5** | API + Aero UI | REST contract + OpenAPI; search UI with window chrome, taskbar, ranking-details panel, settings window |
| **M6** | Evaluation + benchmarks | 1K/10K/100K runs; latency, index size, RSS, throughput tables; mode comparison charts — **all numbers from committed artifacts** |
| **M7** | Validation + viva | documentation consistency audit (README ↔ code ↔ results ↔ report), README polish, `docs/VIVA.md` |

**Sequencing rules (non-negotiable):**

1. M2 uses the **bundled static corpus** — ranking research must not wait for the crawler.
2. The eval harness lands in **M2**, so every later feature is immediately measurable.
3. The UI is **M5** — high visibility, low risk; the IR core is the inverse.

---

## M0 — status: COMPLETE

- [x] Repository scaffold: `package.json`, `tsconfig.json` (strict), `vitest.config.ts`
- [x] `.gitignore`, `.env.example`, `docker-compose.yml` (Postgres 16)
- [x] Directory layout: `src/{core,crawler,storage,api,eval}`, `tests`, `docs`, `web`,
      `benchmarks/{configs,results}`, `configs`, `data/{corpora,index}`, `scripts`
- [x] `src/core` purity boundary declared; smoke test wired to Vitest
- [x] `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (ADR-001…010), this file
- [x] README with objective, structure, setup, status
- [x] `npm install` → `npm run typecheck` → `npm test` pass

## M1 — Indexing core (next)

**Tokenizer / text processing (`src/core/text/`)**
- [ ] Unicode normalization (NFKC) + lowercase
- [ ] Tokenizer: letters/digits, punctuation handling, hyphen/apostrophe policy
- [ ] Stop-word list (removal optional per experiment — flag preserved)
- [ ] Porter stemmer implemented from the algorithm + published test vectors
- [ ] Tests: golden cases for each step; index-time vs query-time path is the *same* function

**Index structures (`src/core/index/`)**
- [ ] Term dictionary: `term → termId`, `termId → {term, df}`
- [ ] `IndexWriter`: collects postings per term (inverted) + positions (positional)
- [ ] Delta-encoded `Uint32Array` docIds + `Uint16Array` tfs; per-doc position runs
- [ ] `docLen` flat array; corpus stats (`N`, `avgdl`, `vocabSize`)
- [ ] `IndexReader` implementation of the ARCHITECTURE interface
- [ ] Doc table: docId → {title, url} (bodies stay in storage layer)

**Persistence (`src/storage/`)**
- [ ] Segment writer/reader: binary format (format version + corpus hash header)
- [ ] JSON debug dump for inspectability
- [ ] Round-trip test: build → serialize → load → identical query results

**Fixture corpus**
- [ ] `data/corpora/static-v1/`: first ~50–100 bundled HTML docs + manifest
      (source, date, license) — small now, grown before M6 benchmarks

**Exit criteria:** given bundled docs, `IndexReader` answers term lookups with correct
df/tf/positions, survives a serialize/load cycle, and `npm test` covers edge cases
(empty doc, repeated terms, unicode terms).

---

## Evidence log (append-only)

| Date | Milestone | Artifact | Notes |
|---|---|---|---|
| 2026-10-07 | M0 | repo scaffold | toolchain green: typecheck + smoke test |
