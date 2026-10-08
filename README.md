# Aero Search (working title)

**A custom information-retrieval search engine** built from first principles: controlled
crawling, a hand-built inverted/positional index, TF-IDF and BM25 ranking implemented
ourselves, phrase/proximity/fuzzy retrieval, PageRank link analysis, hybrid score fusion —
an experimental evaluation framework that measures whether any of it actually works, a
REST API over the whole pipeline, and a Windows 7 Aero desktop UI on top.

> Final-year B.Tech Computer Engineering project. The search engine core is **our own
> implementation** — no Elasticsearch, Solr, Algolia, Typesense, or database full-text search
> is used to serve queries. AI/RAG is a deliberately separate, optional future layer.

**Now:** `npm run demo` (14 checks, one command) · API on `:3000` · desktop UI at the same
origin after `npm run build && npm start` · 312 + 15 tests green.

## Problem statement

How can we efficiently retrieve and accurately rank relevant information from a large
document/web corpus using custom indexing and multiple relevance signals — and *prove*
the ranking quality quantitatively?

## Key features

- Controlled web crawler (frontier, politeness, robots.txt, link graph)
- Text processing: normalization, tokenization, stop words, stemming (own Porter implementation)
- Custom inverted index + positional index (typed-array backed, persisted segments)
- Boolean retrieval, TF-IDF, **BM25 from first principles** (k1, b exposed)
- Phrase queries and proximity scoring via positional intersection
- Fuzzy / typo-tolerant search with bounded edit distance (k=1 default; k=2 measured negative)
- PageRank as a normalized authority signal (citation graph + crawl graph)
- Hybrid ranking: pluggable signals, modes A–D (+ weighted fusion), per-hit score breakdowns
- REST API with per-signal **score explanations** and per-stage timings (`docs/API.md`)
- Windows 7 Aero-inspired desktop UI: windows/taskbar/start menu, result signal bars,
  diagnostics drawer, evaluation + status dashboards (`docs/FRONTEND.md`)
- Evaluation harness: P@K, R@K, F1, MAP, NDCG@K, latency, index size — all numbers from
  committed artifacts

## Architecture overview

Three planes — details in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md):

- **Offline:** crawl → extract → text processing → index build → PageRank → Postgres (system of record)
- **Online:** query → parse → candidate retrieval → signals → normalize → fuse → explain → results
- **Evaluation:** qrels + modes × parameter grids → metrics → committed run artifacts

Delivery: `src/api/` (Fastify, six JSON endpoints) reuses the *same* pipeline the
benchmarks ran (`SearchService` seam); `web/` is a pure client of that API.

Why each technology: [`docs/DECISIONS.md`](docs/DECISIONS.md) (ADR-001…011).
What to build when: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Technology stack

| Layer | Choice |
|---|---|
| Language / runtime | TypeScript (strict) / Node.js ≥ 20 |
| API | Fastify 5 (declarative JSON Schema validation) |
| Crawling / parsing | Undici + Cheerio (Playwright deferred — ADR-007) |
| Metadata store | PostgreSQL 16 (never in query hot path — ADR-003) |
| Search index | **Custom**: term dictionary, postings, positions |
| Ranking | TF-IDF, BM25, phrase, proximity, fuzzy, PageRank, fusion |
| Frontend | React 19 + Vite 8, hand-written Aero design tokens |
| Tests / tooling | Vitest 5 (+ Testing Library for the UI), TypeScript, Docker Compose |

## Setup

```bash
npm install
npm run typecheck      # root + web
npm test               # 312 tests (engine + API contract)
npm run web:test       # 15 tests (client + desktop)

docker compose up -d   # optional: PostgreSQL (also runs on embedded
                       # PostgreSQL when no reachable DATABASE_URL — ADR-011)
```

## Usage

```bash
# product
npm run demo                      # scripted end-to-end demo (14 checks, no port needed)
npm run api                       # REST API            → http://127.0.0.1:3000
npm run web:dev                   # UI dev server       → http://localhost:5173 (proxies /api)
npm run build && npm start        # production: API + Aero UI on :3000
docker compose up --build         # postgres + api + web(:8080)   [docs/DEPLOYMENT.md]

# engine + evidence
npm run db:migrate                # PostgreSQL migrations
npm run corpus:scifact            # fetch + verify BEIR SciFact (md5-checked)
npm run index:build -- --corpus scifact
npm run eval:run -- --corpus scifact --strategy bm25            # → runs/*.json
npm run eval:run -- --corpus scifact --strategy bm25-pr --pr-weight 0.05
npm run eval:run -- --corpus scifact --strategy bm25 --fuzzy
npm run bench:fuzzy / bench:query / npm run bench:api            # → benchmarks/results/
npm run crawl && npm run index:crawl && npm run pagerank:build
```

### Example queries

```
stem cells                                  ← plain terms (implicit OR)
"neural network"                            ← phrase query
seach                                       ← typo → fuzzy recovery (M4-C)
A AND NOT B                                 ← Boolean operators
```

In the UI: switch corpus/strategy/k/fuzzy in the Search window; diagnostics drawer shows
the parsed AST, stemmed terms, and per-stage timings. Walkthrough: [`docs/DEMO.md`](docs/DEMO.md).

## Benchmarks & evaluation

- Benchmarks: `benchmarks/` — configs committed, results committed as evidence
  (1K / 10K / 100K documents; indexing time, query latency, index size, RSS).
- Evaluation: metrics in `src/eval` (P@K, R@K, F1, MAP, NDCG@K) over committed BEIR
  SciFact judgments (md5-verified corpus, 300 test queries). Experiment runs land in
  `runs/`. Every reported number carries a config hash + git SHA.
- **First results** (mode A vs B vs C + latency): [`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md) —
  e.g. BM25 MAP **0.6436** vs TF-IDF 0.4421 on SciFact, sub-4 ms median e2e queries.
- **Hybrid fusion** (M4-B, same protocol): BM25 + citation-graph PageRank at
  w = 0.05 → MAP **0.6451** (+0.0015); weight ablation from 0.01 to 0.5, latency
  +13% — real but marginal gain, reported as measured (EXPERIMENTS.md §3).
- **Fuzzy typo recovery** (M4-C): a single-character typo costs −0.0771 MAP; bounded
  (k=1) edit-distance expansion recovers **93.5% of the gap** (0.5665 → 0.6386 vs 0.6436
  clean) at +0.13 ms; k=2 measured negative (EXPERIMENTS.md §4).
- **API latency** (M5): loopback HTTP round trips, 10 routes — overall avg **4.78 ms**,
  median 1.83, p95 20.49 (`benchmarks/results/*-api-benchmark.json`).
- The UI's Evaluation window serves these same artifacts via `/api/benchmarks` —
  read-only, never recomputed.

## Screenshots

Capture after `npm run build && npm start` (walkthrough in [`docs/DEMO.md`](docs/DEMO.md) §3):
boot desktop with populated Search window · strategy switch (engine-id pills) ·
fuzzy recovery note box · diagnostics drawer · document window with PageRank ·
Evaluation window (0.6436 table) · Status dashboard · compose stack.

## Project status

| Milestone | State |
|---|---|
| M0 Foundation | **done** |
| M1 Indexing core | **done** |
| M2 Retrieval + ranking + eval harness | **done** |
| M3 Crawler + Postgres + link graph | **done** |
| M4 PageRank + hybrid ranking + fuzzy | **done** (tagged `m4-complete` at `0e73bf8`) |
| **M5 API + Aero UI** | **done** — see [`docs/M5.md`](docs/M5.md) + [`docs/M5_FINAL_VERIFICATION.md`](docs/M5_FINAL_VERIFICATION.md) |
| M6 large-scale benchmarks (100K, throughput) | pending |

_(M7 validation/viva prep removed from the production timeline by decision —
doc consistency happens per-milestone.)_

## Future work

- Optional AI/RAG layer (embeddings + LLM) consuming top-K results — strictly separable
- Incremental indexing, skip-pointer/WAND pruning (only if benchmarks justify)
- Optional Elasticsearch baseline row for comparison — never a dependency
- M6: 1K/10K/100K benchmark tables + charts from committed artifacts

## Repository structure

```
src/core      pure IR logic (tokenizer, index, ranking, query) — no I/O
src/crawler   frontier, fetching, extraction, robots, politeness
src/storage   Postgres adapters + repository interfaces, index segment persistence
src/api       Fastify routes, validation, SearchService seam (docs/API.md)
src/eval      metrics, experiment runner, report generation
web/          React + Vite Aero desktop (docs/FRONTEND.md)
migrations/   numbered SQL migrations (PostgreSQL schema)
tests/        Vitest suites (unit, fixture, API contract, PostgreSQL E2E)
benchmarks/   benchmark configs + committed results (query/fuzzy/pagerank/api)
runs/         committed experiment-run artifacts (evidence)
configs/      ranking mode definitions + crawl.json
scripts/      jobs (crawl, index, eval, demo, bench-api…) + lib/ shared plumbing
docs/         ARCHITECTURE · DECISIONS · DEVELOPMENT · SEARCH · RANKING ·
              INDEXING · EVALUATION · EXPERIMENTS · CRAWLER · DATABASE ·
              API · FRONTEND · DEMO · DEPLOYMENT · CODE_WALKTHROUGH ·
              M5 · M5_FINAL_VERIFICATION · REPORT
data/         corpora + index artifacts (gitignored; manifests + eval inputs committed)
Dockerfile, web/Dockerfile, docker-compose.yml   container stack
```

## Documentation & contributors

This README and `/docs` answer *"how is this software built and used?"* — start with
[`docs/DEMO.md`](docs/DEMO.md) (run it), then [`docs/CODE_WALKTHROUGH.md`](docs/CODE_WALKTHROUGH.md)
(one query traced end-to-end). The final-year academic report is a **separate
deliverable** answering *"what problem, what methodology, what evidence"* — kept
consistent by a pre-submission audit (README ↔ implementation ↔ benchmark results ↔ report).

Contributors: [your name]
