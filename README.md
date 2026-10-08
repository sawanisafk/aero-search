# Aero Search (working title)

**A custom information-retrieval search engine** built from first principles: controlled
crawling, a hand-built inverted/positional index, TF-IDF and BM25 ranking implemented
ourselves, phrase/proximity/fuzzy retrieval, PageRank link analysis, hybrid score fusion —
and an experimental evaluation framework that measures whether any of it actually works.

> Final-year B.Tech Computer Engineering project. The search engine core is **our own
> implementation** — no Elasticsearch, Solr, Algolia, Typesense, or database full-text search
> is used to serve queries. AI/RAG is a deliberately separate, optional future layer.

## Problem statement

How can we efficiently retrieve and accurately rank relevant information from a large
document/web corpus using custom indexing and multiple relevance signals — and *prove*
the ranking quality quantitatively?

## Key features (planned → see Status)

- Controlled web crawler (frontier, politeness, robots.txt, link graph)
- Text processing: normalization, tokenization, stop words, stemming (own Porter implementation)
- Custom inverted index + positional index (typed-array backed, persisted segments)
- Boolean retrieval, TF-IDF, **BM25 from first principles** (k1, b exposed)
- Phrase queries and proximity scoring via positional intersection
- Fuzzy / typo-tolerant search with bounded edit distance
- PageRank as a normalized authority signal
- Hybrid ranking: pluggable signals, config-driven modes A–E, weighted-linear + RRF fusion
- REST API with per-signal **score explanations**
- Windows 7 Aero-inspired desktop search UI with a "Ranking Details" panel
- Evaluation harness: P@K, R@K, F1, MAP, NDCG@K, latency, index size

## Architecture overview

Three planes — details in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md):

- **Offline:** crawl → extract → text processing → index build → PageRank → Postgres (system of record)
- **Online:** query → parse → candidate retrieval → signals → normalize → fuse → explain → results
- **Evaluation:** qrels + modes × parameter grids → metrics → committed run artifacts

Why each technology: [`docs/DECISIONS.md`](docs/DECISIONS.md) (ADR-001…011).
What to build when: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Technology stack

| Layer | Choice |
|---|---|
| Language / runtime | TypeScript (strict) / Node.js ≥ 20 |
| API | Fastify (JSON Schema → OpenAPI) |
| Crawling / parsing | Undici + Cheerio (Playwright deferred — ADR-007) |
| Metadata store | PostgreSQL 16 (never in query hot path — ADR-003) |
| Search index | **Custom**: term dictionary, postings, positions |
| Ranking | TF-IDF, BM25, phrase, proximity, fuzzy, PageRank, fusion |
| Frontend | React + Vite, hand-written Aero design tokens |
| Tests / tooling | Vitest, TypeScript, Docker Compose |

## Setup

```bash
npm install
npm run typecheck
npm test

docker compose up -d     # Postgres for metadata (M3 also runs on embedded
                         # PostgreSQL if no reachable DATABASE_URL — ADR-011)
cp .env.example .env
```

## Usage

The search service (REST/UI) arrives at M5. What runs today:

```bash
npm test / npm run typecheck        # 257 tests
npm run db:migrate                  # apply PostgreSQL migrations
npm run corpus:scifact              # fetch + verify BEIR SciFact (md5-checked)
npm run index:build -- --corpus scifact
npm run eval:run -- --corpus scifact --strategy bm25     # → runs/*.json
npm run eval:run -- --corpus scifact --strategy bm25-pr --pr-weight 0.05  # M4-B fusion
npm run bench:query                 # → benchmarks/results/*.json

npm run crawl                       # controlled crawl (configs/crawl.json)
npm run crawl -- --resume           # continue a partial crawl
npm run index:crawl                 # PG docs → data/index/crawled.aidx
                                    # + committed data/eval/crawled.manifest.json
npm run pagerank:build              # PageRank over the crawl graph (M4-A)
```

Crawler details: [`docs/CRAWLER.md`](docs/CRAWLER.md) · schema & persistence:
[`docs/DATABASE.md`](docs/DATABASE.md).
Milestone plan: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Example queries (planned)

```
machine learning algorithms
"neural network"                 ← phrase query
seach  ← fuzzy/typo-tolerant     ← (low-df term expansion)
```

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

## Screenshots

_pending (M5)_

## Project status

| Milestone | State |
|---|---|
| M0 Foundation | **done** |
| M1 Indexing core | **done** |
| M2 Retrieval + ranking + eval harness | **done** |
| M3 Crawler + Postgres + link graph | **done** |
| M4 PageRank + hybrid ranking + fuzzy | in progress |
| M5 API + Aero UI | pending |
| M6 Benchmarks + evaluation | pending |
| M7 Validation + viva prep | pending |

## Future work

- Optional AI/RAG layer (embeddings + LLM) consuming top-K results — strictly separable
- Incremental indexing, skip-pointer/WAND pruning (only if benchmarks justify)
- Optional Elasticsearch baseline row for comparison — never a dependency

## Repository structure

```
src/core      pure IR logic (tokenizer, index, ranking, query) — no I/O
src/crawler   frontier, fetching, extraction, robots, politeness
src/storage   Postgres adapters + repository interfaces, index segment persistence
src/api       Fastify routes and schemas
src/eval      metrics, experiment runner, report generation
web/          React + Windows 7 Aero UI
migrations/   numbered SQL migrations (PostgreSQL schema)
tests/        Vitest suites (unit, fixture, PostgreSQL E2E)
benchmarks/   benchmark configs and committed results
runs/         committed experiment-run artifacts (evidence)
configs/      ranking mode definitions (A–E) + crawl.json
docs/         ARCHITECTURE · DECISIONS · DEVELOPMENT · CRAWLER · DATABASE
              (+ SEARCH, RANKING, EVALUATION, EXPERIMENTS)
data/         corpora and index artifacts (gitignored; manifests + eval inputs committed)
```

## Documentation vs academic report

This README and `/docs` answer *"how is this software built and used?"*.
The final-year academic report is a **separate deliverable** answering
*"what problem, what methodology, what evidence."* They are kept consistent by a
pre-submission audit (README ↔ implementation ↔ benchmark results ↔ report).

## Contributors

- [your name]
