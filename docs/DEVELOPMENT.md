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
| **M4** | PageRank + hybrid + fuzzy | sub-scoped: **A** PageRank job over link graphs (persisted, converged) · **B** hybrid BM25+PageRank fusion (normalize + weight ablation + latency) · **C** fuzzy edit-distance retrieval — original-scope leftovers deferred: `configs/` modes A–E, RRF arm, explanation payloads |
| **M5** | API + Aero UI | sub-scoped: **A** Fastify REST + OpenAPI (validated, tested, explain payloads, measured overhead) · **B** React "Aero" UI — window chrome, taskbar, search window with ranking-details panel, settings window, status dashboard |
| **M6** | Evaluation + benchmarks | 1K/10K/100K runs; latency, index size, RSS, throughput tables; mode comparison charts — **all numbers from committed artifacts** |

_(M7 removed from the production timeline by decision — documentation
consistency audits fold into each milestone's exit criteria.)_

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

## M4 — status: COMPLETE (A + B + C; tag decision pending)

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

### M4-B — Hybrid ranking (BM25 + PageRank fusion) — COMPLETE

Decision at kickoff: **real citation graph over SciFact** (Semantic Scholar
references, in-corpus pairs) as the PageRank source, same 300 judged queries as
M2 → directly comparable to the committed baseline. (Alternatives considered and
rejected: hand-judging the crawl corpus; synthetic graph injection.)

**Fusion core (`src/core/ranking/fusion.ts`)**
- [x] `normalizeScores`: min-max → [0, 1], strictly monotone, degenerate range → 0,
      deterministic, inputs never mutated
- [x] Optional quantile outlier guard (split-anchor mapping — never clamps
      distinct scores into a tie band), **default OFF**: p95 anchoring measured
      harmful on SciFact (candidate-pack condensation, MAP 0.64 → 0.12 at w=0.2);
      mechanism documented in `fusion.ts` + EXPERIMENTS.md §3
- [x] Tests: bounds, guard-band math, strict monotonicity, degenerate/empty,
      validation, determinism

**Mode D strategy (`bm25-pr`, `strategies.ts`)**
- [x] `score = (1−w)·ŝ_bm25 + w·ŝ_pagerank`; breakdown = weighted components (Σ = score)
- [x] Scope-correct normalization: BM25 per query over candidates; PageRank once
      over the corpus (per-candidate min-max amplifies PageRank's near-flat tail
      — observed MAP collapse; documented)
- [x] w=0 reproduces BM25 ordering exactly (unit test + scale check: MAP 0.6436
      identical); w=1 orders by PageRank; validation at construction/rank time
- [x] Artifacts record `{k1, b, prWeight, normBm25, normPr, normGuard}`; id encodes
      the weight (`bm25-pr-w0.05`); `STRATEGY_IDS` exposes data-dependent ids

**Eval plumbing**
- [x] `scripts/lib/pagerank-scores.ts`: citation-graph loader (graphHash verified
      from file, endpoints must map onto index ids or we throw — no silent edge
      drops) + PageRank via the shared core, computed once per run
- [x] `run-experiment --strategy bm25-pr --pr-weight <w> [--norm-guard …
      --linkgraph … --pr-damping/tolerance/max-iterations]`; artifacts carry
      `link_graph {file, sha256, graph_hash, edges, pagerank convergence meta}`
- [x] `bench:query` gains a `bm25-pr` stage whenever a corpus graph file exists
      (PageRank computed outside the timed loop)

**Ablation (SciFact, 300 judged; graph: 4,879/5,183 resolved → 2,015 in-corpus
edges, 955 citing papers, hash `3d7b80d2…`; PR converged 41 iters / 8.64e-7)**
- [x] BM25 vs BM25+PR at w ∈ {0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5}: best
      **w=0.05 → MAP 0.6436 → 0.6451 (+0.0015), NDCG@10 0.6876 → 0.6886**;
      flat/slightly negative through w=0.3; collapse at 0.5 (0.5163). Reported
      as measured: link authority is a marginal tie-breaker on this testbed
- [x] Latency impact: bench artifact — bm25 1.008 ms avg → bm25-pr 1.136 ms
      avg (+13%) over 1,109 queries

**Exit criteria B** (independent signal + normalization + fusion, BM25 vs
BM25+PR on judged data, ablation, latency — all committed artifacts) — **met**:
257 tests green; `runs/2026-10-08T03-26-*` (8 files) +
`benchmarks/results/2026-10-08T03-26-43-094Z-query-benchmark.json`;
walkthrough in EXPERIMENTS.md §3.

### M4-C — Fuzzy retrieval — COMPLETE

Decision: **query-time expansion, no index-layout change** (M1 freeze stands).
An absent analyzed term contributes ∅ silently; bounded edit distance recovers
it — measured as its own experiment, separate from exact retrieval.

**Core (`src/core/retrieval/fuzzy.ts`)**
- [x] `boundedEditDistance(a, b, max)` — row DP with row-min early exit,
      returns `max + 1` sentinel outside the bound; hand-computed test vectors
- [x] k=1: direct variant generation (~27·len delete/substitute/insert over
      a-z) → O(1) hash probes against the dictionary
- [x] k=2 (opt-in): bounded dictionary scan (length ±2 filter + early-exit
      DP) — the first implementation composed edit1×edit1 sets (quadratic),
      measured **max 1,554 ms** in the bench, replaced by the scan →
      max 7.773 ms, and complete (no truncation)
- [x] Expands ONLY absent term leaves; exact-match terms never expand;
      phrase + NOT subtrees untouched; identity pass-through when nothing to
      do (unit-tested with `toBe`)
- [x] Strict limits, all validated by `resolveFuzzy` and recorded in
      artifacts: `maxEdits ∈ {1,2}` (default 1), `minTermLength` 3,
      `maxExpansionsPerTerm` 10, `maxFuzzyTermsPerQuery` 10,
      `maxExpansionsPerQuery` 20; ordering (dist asc, df desc, term asc) is
      deterministic

**Integration (one rewrite feeds both layers)**
- [x] Expanded leaf = `[original, ...variants]`; `evalAnalyzed` treats a
      multi-term leaf as their union — candidates AND scoring
      (`positiveQueryTerms`, real idf per variant) see it; regression:
      baseline re-run reproduces M2 MAP 0.6436 / NDCG@10 0.6876 exactly
- [x] `runQuerySet(..., fuzzy)` expands inside the timed loop, aggregates cap
      counters; `run-experiment --fuzzy --fuzzy-*` → artifact
      `fuzzy {enabled, params, stats}` block, `-fuzzy` filename suffix
- [x] `bench:query` gains `bm25-fuzzy` / `bm25-fuzzy2` stages (expansion
      stats recorded per stage); new `npm run bench:fuzzy` — the separate
      typo experiment (`scripts/fuzzy-benchmark.ts`)

**Typo benchmark (SciFact, deterministic single-substitution corruption,
300/300 corruptible, identical judged subset in all arms, git `b713150` clean)**
- [x] clean 0.6436 MAP → typo-exact 0.5665 (−0.0771) → **typo + k=1 fuzzy
      0.6386 — recovers 0.0722/0.0772 = 93.5% of the gap** (NDCG@10: 92.8%);
      R@100 0.9309 ≥ clean 0.9276 (union adds recall)
- [x] k=2 reported as the measured negative it is: MAP 0.6157 (below k=1 —
      distance-2 noise), R@100 0.9342 highest, ~4× latency; k=1 is default
- [x] Clean-query cost measured honestly: fuzzy over uncorrupted queries
      expands 72 OOV terms in 30/300 queries → MAP 0.6436 → 0.6353 —
      expansion is a precision tradeoff, documented not hidden
- [x] Latency: 1,109 queries — bm25 0.887 ms avg → bm25-fuzzy 0.868 (no-op
      tax ≈ 0) → bm25-fuzzy2 1.232 avg / 7.773 max

**Exit criteria C** (bounded edit distance, typo cases, strict candidate
limits, separate benchmark — all committed artifacts) — **met**: 286 tests
green; `benchmarks/results/2026-10-08T03-59-{11-510,23-203}-*-fuzzy-benchmark.json`
+ `…03-59-43-121Z-query-benchmark.json` +
`runs/2026-10-08T03-59-45-029Z-scifact-bm25-k1.2-b0.75-fuzzy.json`;
walkthrough in EXPERIMENTS.md §4.

---

## M5 — status: IN PROGRESS

Goal: turn the engine into a product — an industry-grade REST API and a
distinctive "Aero" desktop-style web UI, where **every displayed number comes
from the same measured engine** the committed artifacts describe (ADR-003:
PostgreSQL never in the query hot path).

### M5-A — API (Fastify)

- [ ] `src/api/` Fastify app (strict tsconfig), `npm run dev:api`
- [ ] `GET /api/v1/search` — `q, corpus, mode, topk, fuzzy, explain` → hits with
      rank/score/breakdown (bm25 · phrase · proximity · pagerank), analysis trace
      (tokens after stemming, fuzzy expansions), timings, provenance
- [ ] `GET /api/v1/status` — index stats, corpus hash, git SHA, PageRank availability
- [ ] `GET /api/v1/document/:id` — document detail view
- [ ] Zod validation at the edge, uniform error envelope, CORS, pino logging
- [ ] OpenAPI 3 spec served at `/api/v1/docs`, generated from the Zod schemas
- [ ] contract tests (vitest + injected Fastify), typecheck green, full suite green
- [ ] evidence: `bench:api` artifact — HTTP-layer overhead p50/p95 vs core latency

### M5-B — Aero UI (React + Vite)

- [ ] `web/` Vite + React + TS (own tsconfig); `npm run dev:web`, `npm run build:web`
- [ ] Aero aesthetic: glass/translucent windows, window chrome, taskbar, wallpaper
- [ ] Search window: command bar, result rows with score bars, keyboard-first
      (Ctrl+K, ↑/↓, Enter), badges for fuzzy recovery / phrase / PR boost
- [ ] Ranking-details panel: per-hit score breakdown + analysis trace ("why did
      this rank here?")
- [ ] Settings window: corpus, mode A–D, topk, fuzzy radius, implicit AND/OR —
      persisted client-side
- [ ] Status dashboard: index stats, PageRank top authorities, crawl manifest,
      live latency
- [ ] states (loading/empty/error), accessibility basics, responsive layout
- [ ] component tests (Vitest + Testing Library)
- [ ] production path: `npm run build` (web + api) → `npm start` serves the built
      UI from Fastify

**Exit criteria:** the full demo runs in a browser — type a query containing a
typo, watch it recover with explained scores, switch ranking modes, inspect
index/PageRank status — with API contract tests + UI tests green and typecheck
clean.

**Non-goals:** auth/multi-user, DB in the hot path, deployment infrastructure —
those are M6+ concerns.

**Sequencing note:** M7 (validation/viva prep) removed from the production
timeline by decision (2026-10-08); documentation consistency is each
milestone's own exit duty.

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
| 2026-10-08 | M4-B | `data/eval/scifact-citations.json` | real citation graph over the SciFact corpus from Semantic Scholar (batch API, backoff): 5,183 ids requested → 4,879 resolved, 100,979 references → **2,015 in-corpus directed edges** (955 citing papers), 3,409 elided/no-refs counted as data; graphHash `3d7b80d2…` + corpus sha256 recorded in file; git `daae9c0` |
| 2026-10-08 | M4-B | `runs/2026-10-08T03-26-*` (8 files) | fusion ablation on SciFact (300 judged, same protocol as M2), git `05601f9` clean: bm25 MAP 0.6436 → best fusion w=0.05 MAP 0.6451 / NDCG@10 0.6886; flat to w=0.2, degradation at 0.3, collapse at 0.5 (0.5163); every artifact embeds link_graph (hash, edges) + PageRank convergence (41 iters, 8.64e-7) + full strategy params; 257 tests green |
| 2026-10-08 | M4-B | `benchmarks/results/2026-10-08T03-26-43-094Z-query-benchmark.json` | latency impact of mode D over 1,109 SciFact queries: bm25 1.008 ms avg / 0.953 median → bm25-pr 1.136 / 1.106 (+13%), all other stages unchanged; `bm25-pr` stage + `link_graph` block recorded; PageRank computed outside the timed loop; git `05601f9` clean |
| 2026-10-08 | M4-C | `benchmarks/results/2026-10-08T03-59-11-510Z-fuzzy-benchmark.json` + `…03-59-23-203Z-…` | typo-recovery benchmark on SciFact: deterministic single-substitution corruption, 300/300 corruptible (0 skipped), identical judged subset in all arms, git `b713150` clean: clean 0.6436 MAP → typo-exact 0.5665 → fuzzy k=1 **0.6386 (93.5% of the 0.0772 gap recovered)**; k=2 MAP 0.6157 (distance-2 noise — measured negative), R@100 0.9342; latency 1.005 / 0.890 / 1.136 (k=1) / 4.340 (k=2) ms avg; all 300 corrections + fuzzy params/stats embedded |
| 2026-10-08 | M4-C | `benchmarks/results/2026-10-08T03-59-43-121Z-query-benchmark.json` | fuzzy latency stages over 1,109 queries: bm25 0.887 ms avg → bm25-fuzzy 0.868 / max 2.966 → bm25-fuzzy2 1.232 / max 7.773; per-stage expansion stats recorded; documents the k=2 fix (first edit1×edit1 implementation measured max 1,554 ms in a pre-commit bench run, replaced by a bounded dictionary scan before this artifact); git `b713150` clean |
| 2026-10-08 | M4-C | `runs/2026-10-08T03-59-45-029Z-scifact-bm25-k1.2-b0.75-fuzzy.json` | clean-query fuzzy arm (no corruption): 72 absent terms attempted in 30/300 queries → 157 variants (caps fired: expansionsPerTerm 8, expansionsPerQuery 3), MAP 0.6436 → 0.6353 (expansion trades precision when the miss is genuine OOV, not a typo), R@100 0.9276 → 0.9309, latency 1.089 ms avg; `fuzzy {params, stats}` block; git `b713150` clean |
