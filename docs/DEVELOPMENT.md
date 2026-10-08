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
| **M3** | Crawler + storage + link graph | controlled crawl of seed set → Postgres; link graph; persistent/resumable crawl state; crawled corpus rebuilt into the index + committed manifest |
| **M4** | PageRank + hybrid + fuzzy | PageRank job over the crawled link graph; signal/normalizer/fusion architecture; modes A–E in `configs/`; RRF arm; fuzzy expansion for low-df terms; explanation payloads |
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

## M1 — status: COMPLETE

Component details and benchmark tables: [INDEXING.md](INDEXING.md).

**Tokenizer / text processing (`src/core/text/`)**
- [x] Unicode normalization (NFKC) + lowercase
- [x] Tokenizer: letters/digits, punctuation handling, hyphen/apostrophe policy
- [x] Stop-word list (removal optional per experiment — flag preserved)
- [x] Porter stemmer implemented from the algorithm + published test vectors
      (all 23,531 official vectors pass)
- [x] Tests: golden cases for each step; index-time vs query-time path is the *same* function

**Index structures (`src/core/index/`)**
- [x] Term dictionary: `term ↔ termId`, `termId → {term, df}`
- [x] `IndexWriter`: collects postings per term (inverted) + positions (positional)
- [x] Delta-encoded `Uint32Array` docIds + `Uint16Array` tfs; per-doc position runs
- [x] `docLen` flat array; corpus stats (`N`, `avgdl`, `vocabSize`)
- [x] `IndexReader` implementation of the ARCHITECTURE interface
- [x] Doc table: docId → {title, url} (bodies stay in storage layer)

**Persistence (`src/storage/`)**
- [x] Segment writer/reader: binary format (format version + corpus hash header)
- [x] JSON debug dump for inspectability
- [x] Round-trip test: build → serialize → load → identical query results

**Fixture corpus**
- [x] `data/corpora/static-v1/`: 84 bundled HTML docs + manifest (source, date,
      license) — grown before M6 benchmarks

**Exit criteria:** given bundled docs, `IndexReader` answers term lookups with correct
df/tf/positions, survives a serialize/load cycle, and `npm test` covers edge cases
(empty doc, repeated terms, unicode terms). — **met** (38 tests green;
`tests/pipeline.test.ts` runs the bundled corpus end to end).

---

## M2 — status: COMPLETE

Component details: [SEARCH.md](SEARCH.md) · [RANKING.md](RANKING.md) ·
[EVALUATION.md](EVALUATION.md) · results: [EXPERIMENTS.md](EXPERIMENTS.md).

**Query language (`src/core/query/`)**
- [x] Typed AST (term/phrase/and/or/not) + lexer with absolute positions
- [x] Recursive-descent parser: precedence NOT > AND > OR, parentheses, implicit
      operator selectable (`'and'` default for UI, `'or'` for IR evaluation)
- [x] Typed `QueryParseError` with closed code set + character position
- [x] Malformed-query test matrix (every code, every position)

**Boolean retrieval (`src/core/retrieval/`)**
- [x] AND intersect / OR union / NOT difference over sorted `Uint32Array` docIds
- [x] `analyzeQuery` sharing the index-time analyzer; empty-leaf/NOT semantics
- [x] `retrieveBoolean` candidates as the substrate for every strategy

**Ranking (`src/core/ranking/`)** — [RANKING.md](RANKING.md)
- [x] TF-IDF with 3 tf weightings (raw/log/augmented), per-reader cached maxTf
- [x] BM25 from first principles, configurable validated k1/b (defaults 1.2/0.75)
- [x] Positional phrase matching (two-stage; stop-word-aware) as an additive signal
- [x] Proximity window signal `k/(1+(w−|q|))`, scoring-only, k = 0 ablation
- [x] Pluggable strategies: registry + `createStrategy` + `resolveStrategyParams`
      (eager validation, params recorded in artifacts); deterministic ordering

**Evaluation (`src/eval/`)** — [EVALUATION.md](EVALUATION.md)
- [x] Qrels/Run types; strict BEIR parsers (qrels TSV, queries JSONL)
- [x] P@K, R@K, F1@K, AP/MAP, NDCG@K — hand-calculated golden tests
- [x] Run evaluation iterates qrels (failed/missing queries = zeros)

**Harness (`scripts/`, `benchmarks/`)** — [EXPERIMENTS.md](EXPERIMENTS.md)
- [x] `fetch-scifact.ts`: published-MD5 verification, sha256 manifests, committed
      `data/eval/` inputs (300-query test qrels); `fetch-20newsgroups.ts` (dev only)
- [x] `build-eval-index.ts`: corpus → AIDX segment + docId↔corpusId map
- [x] `run-experiment.ts`: strategy × corpus × params → `runs/*.json` with
      {git sha+clean, corpus/query/qrels hashes, params, metrics, latency}
- [x] `benchmarks/query-benchmark.ts`: e2e latency avg/median/p95/max per stage
- [x] Mode A vs B comparison on real judged data + mode C ablation

**Exit criteria** (milestone table: Boolean; TF-IDF ×3; BM25 k1/b; phrase + proximity;
qrels v1; metric runner; first A vs B comparison) — **met**: 149 tests green,
A vs B measured on BEIR SciFact (TF-IDF MAP 0.4421 → BM25 MAP 0.6436),
6 run artifacts + 3 latency artifacts committed at git `7d9ef4c`.
Frozen at annotated tag **`m2-complete`** → `b23a551`.

---

## M3 — status: COMPLETE

Component details: [CRAWLER.md](CRAWLER.md) · [DATABASE.md](DATABASE.md) ·
[ARCHITECTURE §4/§7](ARCHITECTURE.md). PageRank was **moved to M4** (milestone table
above) — M3 ends at the link graph.

**PostgreSQL schema + repository layer** (Phases A)
- [x] `migrations/001_init.sql`: `urls` (frontier), `documents` (dedup via partial-unique
      content_hash), `links` (PageRank input, FK cascade)
- [x] Pure repository interfaces (`src/storage/repositories.ts`, no pg types) +
      `PostgresStore` implementation + in-memory test double
- [x] Idempotent transactional migrations (`npm run db:migrate`)
- [x] **ADR-011:** embedded PostgreSQL 16.14 (`embedded-postgres`) when no reachable
      `DATABASE_URL` — compose/system contract unchanged; test clusters isolated

**Crawler primitives** (Phase B)
- [x] URL normalization (one canonical string per page) + allowlist (empty → refuses)
- [x] Hand-written RFC 9309 robots parser: longest-match, allow-tie, Crawl-delay,
      404 → allow-all, fail-open on network errors (logged as data)
- [x] HTML extraction (cheerio): title, meta, body, outlinks, `<base href>`
- [x] Frontier (BFS by depth, seen-set) + per-host politeness scheduler

**Crawl orchestrator** (Phase C)
- [x] `HttpFetcher` (undici): 10 s timeouts, redirect cap 5 with recorded chain,
      transport retry + backoff, byte cap, `accept-encoding: identity`
- [x] Full §7 pipeline with hard budgets (maxPages/maxDepth/allowlist), MIME gate,
      content-hash dedup, failure-as-data; clock/sleep injected → deterministic
      politeness tests (`7 × 30 ms`, `durationMs = 210`)

**Persistent state, resume, CLI, E2E** (Phase D)
- [x] `run({resume})`: reload all rows, seal processed URLs, requeue pending (BFS)
- [x] Completed crawl resumed → **zero** network requests (idempotence proven)
- [x] `scripts/crawl.ts` + committed `configs/crawl.json` (seed, allowlist, budgets,
      UA) with per-event logging and DB-state summary
- [x] E2E on real embedded PG: partial → resume without refetch → idempotent re-run,
      in-memory and PG semantics identical

**Index integration** (Phase E)
- [x] `buildCrawlIndex`: PG documents (duplicate_of IS NULL, url order) → existing
      `IndexWriter` → `data/index/crawled.aidx` + `.ids.json`
- [x] Committed provenance manifest `data/eval/crawled.manifest.json` (counts, config
      sha256, git SHA, corpus hash, segment stats); `npm run index:crawl`

**Exit criteria** (milestone table: controlled crawl → Postgres; link graph; corpus
manifest) — **met**: 219 tests green (unit + fixture + PG E2E); live controlled crawl
of `info.cern.ch` produced 100 pages / 77 indexable docs / 796 link edges with 62 URLs
left resumable; manifest + query-latency artifact committed. Frozen at tag
**`m3-complete`** → `d6d598c`.

---

## M4 — status: IN PROGRESS

Sub-scoped per plan: **M4-A PageRank → M4-B hybrid fusion → M4-C fuzzy** — each with its
own experiment; PageRank is *hypothesized* to help, a null/negative result is equally
publishable ("does link-based authority improve lexical relevance?").

### M4-A — PageRank — COMPLETE

**Core (`src/core/link/pagerank.ts`)**
- [x] Power iteration; column-stochastic contributions (`d·π_u / outdeg(u)`)
- [x] Dangling-mass redistribution + teleport → disconnected components safe
- [x] Configurable d / tolerance / maxIterations (defaults 0.85 / 1e-6 / 100 per §6)
- [x] Deterministic: deduped+sorted edges, uniform start → bitwise-reproducible scores
- [x] Honest convergence reporting (`converged`, `residual`, `onIteration` trace hook)

**Persistence (`migrations/002_pagerank.sql`)**
- [x] `pagerank_runs` (params + convergence + graphHash + gitSha) / `pagerank_scores`
      (url-keyed, FK cascade); atomic save + deterministic latest-run load
- [x] Tests: roundtrip, latest-run supersession, >1-chunk score sets (16 PG tests)

**Job (`npm run pagerank:build`)**
- [x] Graph from PostgreSQL: nodes = indexable documents (url order); edges with both
      endpoints in the node set; dropped rows and dangling nodes counted, not hidden
- [x] `graphHash` = sha256 over canonical (N, sorted edges) serialization; artifact
      carries config + git SHA + corpus hash + residual trace (evidence rule)
- [x] Evidence run on the M3 graph: 77 nodes / 209 unique in-set edges (796 raw rows,
      482 dropped, 16 dangling) → **converged 52 iterations, residual 8.591e-7,
      1.9 ms**, Σπ = 1.0000000000000002; top authority `TheProject.html` (0.1088)

**Exit criteria A** (hand-computable tests; deterministic; persisted; convergence
benchmark artifact committed) — **met**: 239 tests green; artifact
`benchmarks/results/2026-10-08T02-29-21-953Z-pagerank.json`.

### M4-B — Hybrid ranking (BM25 + PageRank fusion) — pending

BM25 baseline · PageRank as independent signal · normalization + weighted/RRF fusion ·
BM25 vs BM25+PR comparison · ablation · latency impact — all via the existing
`eval:run` harness on judged data (SciFact for lexical metrics; the crawl corpus has no
qrels, so fusion quality is measured on SciFact with PageRank simulated/injected as a
controlled signal, or on any judged set with a link graph — decide at kickoff).

### M4-C — Fuzzy retrieval — pending

Bounded edit-distance candidate generation, typo cases, strict candidate-count limits,
benchmark separate from exact retrieval (exact vs fuzzy as its own experiment).

---

## Evidence log (append-only)

| Date | Milestone | Artifact | Notes |
|---|---|---|---|
| 2026-10-07 | M0 | repo scaffold | toolchain green: typecheck + smoke test |
| 2026-10-07 | M1 | `benchmarks/results/2026-10-07T13-22-21-192Z-index-benchmark.json` | index build/scan numbers at 1K/10K docs, git `44781e8`, corpus hashes in artifact; test evidence: 38 tests green incl. 23,531 Porter vectors and static-v1 E2E |
| 2026-10-07 | M2 | `runs/2026-10-07T14-52-*-scifact-*.json` (6 files) | strategy comparison + proximity ablation on BEIR SciFact (300 judged queries); git `7d9ef4c` clean; MAP: boolean 0.0049, tfidf 0.4421, bm25 0.6436, mode-C 0.6440 (params recorded per run); 149 tests green |
| 2026-10-07 | M2 | `benchmarks/results/2026-10-07T14-53-*-query-benchmark.json` (3 files) | e2e query latency (avg/median/p95/max per stage) on scifact 1,109 queries, static-v1, 20newsgroups; git `7d9ef4c` clean; parse-failure counts recorded |
| 2026-10-07 | M3 | `data/eval/crawled.manifest.json` | controlled crawl of `info.cern.ch` per `configs/crawl.json` (config sha256 in manifest): 100 pages, 78 docs / 77 indexable, 796 link edges, 22 failures recorded as data, 62 pending (resumable); corpus hash `4e5bf3b0…`, git SHA + clean flag recorded; built in 372 ms via `npm run index:crawl` |
| 2026-10-07 | M3 | `benchmarks/results/2026-10-07T17-12-21-990Z-query-benchmark.json` | e2e query latency on the crawled corpus (77 docs, vocab 4,151, 60 derived queries): BM25 avg 0.089 ms / p95 0.117 ms; git SHA recorded in artifact |
| 2026-10-07 | M3 | `data/eval/crawled.graph.json`, `data/index/crawled.aidx` | preservation: full 796-edge link-graph export (74 sources, 422 targets) + crawled index segment (77 docs, 0.27 MB, ids map) committed as frozen evidence; deterministic rebuild reproduced corpus hash `4e5bf3b0…`; frozen at git tag `m3-complete` |
| 2026-10-08 | M4-A | `benchmarks/results/2026-10-08T02-29-21-953Z-pagerank.json` | PageRank over the M3 crawl graph: 77 nodes / 209 unique in-set edges / 16 dangling, d=0.85, tol=1e-6 → converged 52 iterations, residual 8.591e-7, 1.9 ms, Σπ=1.0000000000000002, graphHash `1a3f3ec4…`, corpus hash from crawled manifest, git SHA in artifact; scores persisted as `pagerank_runs` run_id 1 |
