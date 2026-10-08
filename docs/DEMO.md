# Demo guide

Everything below was run from the repository root on Windows/Node 24.
Screenshots are taken by the presenter — this doc only tells you what to run
and what you should see.

## 0. Checkpoint (30 seconds)

```bash
npm install
npm run typecheck     # silent = green (root + web)
npm test              # 312 passed (root) — engine + API contract
npm run web:test      # 15 passed (web) — client + desktop behavior
```

## 1. Terminal demo — the whole product in one command

```bash
npm run demo
```

Runs the API **in-process** (no port needed) and walks 14 steps through every
subsystem; exits non-zero if anything deviates. Actual output:

```text
[1/7] service
  ✓ GET /health                        version 0.1.0 · corpora [20newsgroups, crawled, scifact, static-v1]
  ✓ GET /api/config                    defaults scifact/bm25/k=10 · 6/6 strategies available
[2/7] ranked search
  ✓ GET /api/search (bm25)             10 hits · 14.94 ms · #1 "Targeted therapy for cancer stem cells: the…" score 6.2848
[3/7] strategy sweep (same query)
  ✓ strategy boolean                   #1 … score 0.0000 · engine boolean
  ✓ strategy tfidf                     #1 … score 48.4339 · engine tfidf-raw
  ✓ strategy bm25                      #1 … score 6.2848 · engine bm25-k1.2-b0.75
  ✓ strategy bm25-phrase               #1 … score 6.2848 · engine bm25-phrase
  ✓ strategy bm25-phrase-proximity     #1 … score 7.2848 · engine bm25-phrase-proximity
  ✓ strategy bm25-pr                   #1 "Induced pluripotent stem cell lines der…" · score 0.9116 · engine bm25-pr-w0.2
[4/7] phrase + proximity
  ✓ phrase query                       5 hits · phrase=1.200 proximity=—
[5/7] fuzzy recovery
  ✓ fuzzy contrast                     exact 0 hits → fuzzy 10 hits · expansions [wonderland]
[6/7] document detail
  ✓ GET /api/documents/scifact/:id     "…" · pagerank 0.000161 · 2 matched terms
[7/7] stats + recorded experiments
  ✓ GET /api/stats                     scifact · 5183 docs · vocab 26299 · PR citation-graph:scifact
  ✓ GET /api/benchmarks                15 runs · 2 fuzzy · 6 latency · bm25 MAP 0.6436

demo: 14/14 steps ok
```

Narration points: same query, six strategies, six different #1s (rankings are
real, not canned); the typo query returns **nothing** exactly and **10 hits**
with one expansion; the benchmark step proves the UI's numbers are the
committed ones.

## 2. Live API (two curls worth showing)

```bash
npm run api          # terminal A → http://127.0.0.1:3000
```

```bash
# fuzzy contrast (static-v1 contains "wonderland", scifact does not)
curl 'http://127.0.0.1:3000/api/search?q=wonderlan&corpus=static-v1'
curl 'http://127.0.0.1:3000/api/search?q=wonderlan&corpus=static-v1&fuzzy=true'
#   → meta.fuzzy.expansions: [{ term: "wonderlan", variants: ["wonderland"], distance: 1 }]

# the locked baseline, read from runs/ (never recomputed)
curl -s 'http://127.0.0.1:3000/api/benchmarks' | jq \
  '.runs[] | select(.strategy=="bm25-k1.2-b0.75" and (.fuzzy|not)) | .map'
#   0.6436
```

API reference: [`docs/API.md`](API.md).

## 3. Browser demo (the Aero desktop)

Fastest full path (one terminal, production build):

```bash
npm run build        # tsc + vite → dist/ and web/dist/
npm start            # Fastify on :3000 serves API + UI together
```

Dev path (two terminals): `npm run api` + `npm run web:dev`
(→ http://localhost:5173, Vite proxies `/api`).

Walkthrough (≈ 5 minutes):

1. **Boot** — the desktop opens with the Search window already querying
   `stem cells`; results arrive with score badges and signal bars.
2. **Strategy switch** — change strategy to *BM25 + PageRank*: status pill
   shows engine id `bm25-pr-w0.2`; the #1 hit changes (fusion is real).
3. **Phrase** — query `"stem cell"`: results carry a `phrase` component in
   their bars; diagnostics shows the parsed AST.
4. **Typo** — corpus `static-v1`, query `wonderlan`, enable **fuzzy
   recovery**: green note box `wonderlan → [wonderland]`, 10 hits. Disable
   it → empty state suggesting fuzzy.
5. **Why did this rank here?** — every result's bars + the diagnostics
   drawer (timing, terms, params).
6. **Document** — click a title: PageRank value, matched terms with tf/df,
   phrase chips, full text.
7. **Evaluation** — open from the desktop icon: the runs table shows MAP
   **0.6436** / nDCG@10 **0.687552**, fuzzy arms (0.5665 → 0.6386, k=2
   0.6157), PageRank card (52 iterations, residual 8.59e-7, 77 nodes) —
   read-only, served from committed artifacts.
8. **Status** — index sizes, strategy dots, PageRank source
   `citation-graph:scifact`, live search counters; switch corpus in the
   dropdown.
9. **Settings** — defaults, endpoint table, about.

Exit-code reality check while the UI is open:

```bash
curl -s http://127.0.0.1:3000/health   # {"status":"ok",…}
```

## 4. API latency benchmark (evidence)

```bash
npm run bench:api     # boots the API on an ephemeral port, 10 routes × 30 requests
```

Writes `benchmarks/results/<timestamp>-api-benchmark.json` and prints, e.g.
for the committed run `2026-10-08T12-33-35-546Z`:

```text
search-bm25   avg 2.19 ms · median 2.07 · p95 3.14
benchmarks    avg 20.80 ms · median 20.47 · p95 22.51
OVERALL       avg 4.78 ms · median 1.83 · p95 20.49 · 300 requests
```

## 5. Docker (optional)

```bash
docker compose up --build
# web → http://localhost:8080  (nginx: SPA + /api proxy)
# api → http://localhost:3000  (REST directly)
# pg  → localhost:5432
docker compose exec api node dist/scripts/db-migrate.js   # first run: migrations
```

> Verified note: executed on 2026-10-08 with Docker Desktop 4.94 (WSL 2) —
> `docker compose config` clean, both images built, postgres + api healthy,
> `http://localhost:8080` returned the SPA and proxied `/api/search` (200,
> 10 hits), direct `/health` on `:3000` returned 200.

## 6. Where the evidence lives

| Question | Artifact |
|---|---|
| ranking quality | `runs/*.json` (MAP/nDCG per strategy, git SHA embedded) |
| query latency | `benchmarks/results/*-query-benchmark.json` |
| typo recovery | `benchmarks/results/*-fuzzy-benchmark.json` |
| PageRank convergence | `benchmarks/results/*-pagerank.json` |
| API latency | `benchmarks/results/*-api-benchmark.json` |
| crawl | `data/eval/crawled.manifest.json`, `data/eval/crawled.graph.json` |

Tables built from these: [`docs/EXPERIMENTS.md`](EXPERIMENTS.md).
