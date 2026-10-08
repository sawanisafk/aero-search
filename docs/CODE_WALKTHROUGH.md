# Code walkthrough (M5)

Two readings: **the map** (what each new file is for) and **the trace**
(one query, browser to ranked results and back).

---

## 1. The map

### API layer — `src/api/`

| File | Lines | What it is |
|---|---|---|
| `config.ts` | ~64 | environment → typed `ApiConfig` (bind address, defaults, caps). Pure; no I/O. |
| `snippets.ts` | ~120 | `makeSnippet(text, tokens, positives)` — best-window snippet with character offsets for highlighting. Pure. |
| `doc-store.ts` | ~220 | metadata/text per corpus: scifact/20newsgroups → `corpus.jsonl`, static-v1 → metadata + `html/`, crawled → PostgreSQL **only if** `DATABASE_URL` is set, else `text: null`. |
| `search-service.ts` | ~1093 | **the seam.** Wraps the M0–M4 pipeline: runtime index cache, the six strategies, fuzzy options, PageRank sources, snippets, document detail, stats/config/benchmarks, latency ring, `ServiceError`. This is where HTTP-shaped results are produced — but all ranking stays in `src/core`. |
| `app.ts` | ~219 | Fastify factory: JSON-Schema validation, CORS, one error handler (envelope), six routes, static `web/dist` + SPA fallback. **Contains zero retrieval logic.** |
| `server.ts` | ~39 | process entry: `loadConfig → buildApp → listen`, graceful shutdown. |
| `index.ts` | ~18 | barrel for tests/scripts. |

Design rules enforced here:

1. **`src/core` never imports from `src/api`** — direction of dependency is
   one-way (core is pure, no fs/net/pg/fastify).
2. **`app.ts` never touches files or the index** — it validates, calls one
   service method, serializes; failures become `{error:{code,message}}`
   without filesystem paths (error handler, `app.ts:72`).
3. **The pipeline is not duplicated** — `service.search()` at
   `search-service.ts:480` calls the *same* `parseQuery / analyzeQuery /
   expandFuzzyQuery / retrieveAnalyzed / strategy.rank` functions the
   benchmark harness calls (`scripts/lib/retrieval-run.ts`).

### Frontend — `web/src/`

| File | What it is |
|---|---|
| `App.tsx` | window manager (state machine over `WinState[]`), desktop shell: icons, start menu, taskbar, clock. No fetching. |
| `windows/AeroWindow.tsx` | draggable/focusable/minimizable/maximizable chrome; geometry comes from App, content from the view components. |
| `windows/SearchWindow.tsx` | query → `api.search()` → results/snippets/signal bars/status line/diagnostics drawer; fuzzy note box; paging. |
| `windows/DocWindow.tsx` | `api.document()` → metadata grid (live PageRank), matched terms, phrase chips, text. |
| `windows/EvaluationWindow.tsx` | `api.benchmarks()` → read-only artifact tables (the locked numbers surface here). |
| `windows/StatusWindow.tsx` | `api.stats(corpus)` → live cards; corpus switcher. |
| `windows/SettingsWindow.tsx` | `api.config()` → defaults/strategies/endpoints/about. |
| `api/client.ts` | the single error path: envelope → `ApiError{status,code}`; fetch failure → `NETWORK`; bad body → `BAD_RESPONSE`. |
| `api/types.ts` | typed mirror of the API contract (kept honest by `tests/api.test.ts` server-side). |
| `components/SignalBars.tsx` | breakdown record → labeled bars (the "why did this rank here" visual). |
| `styles/aero.css` | the entire Win7 Aero design system as tokens + component classes. |

### Scripts & containers

| File | What it is |
|---|---|
| `scripts/demo.ts` | in-process end-to-end demo (14 checks, exit ≠ 0 on deviation). |
| `scripts/bench-api.ts` | real HTTP latency per route → `benchmarks/results/*-api-benchmark.json`. |
| `Dockerfile` | api image: build stage (tsc+vite) → runtime (prod deps, dist, data, runs, benchmarks). |
| `web/Dockerfile` + `web/nginx.conf` | SPA image; nginx proxies `/api` + `/health` to `api:3000`. |
| `docker-compose.yml` | postgres + api + web, health-gated startup. |
| `tests/api.test.ts` | 26 contract tests (inject, no port) incl. locked artifact values. |

---

## 2. Trace one search query

Take the demo case: type `stem cells`, corpus `scifact`, strategy `bm25`,
press Enter.

### Step 1 — the browser (UI)

1. `web/src/windows/SearchWindow.tsx:142` — `submit()` prevents the form
   POST and calls `run(q, opts, 1)`.
2. `SearchWindow.tsx:70` — `run()` sets `loading`, then calls
   `api.search({q:'stem cells', k:10, page:1, strategy:'bm25', …})`.
3. `web/src/api/client.ts:73` — `searchPath()` builds
   `/api/search?q=stem+cells&k=10&page=1&strategy=bm25&corpus=scifact&fuzzy=false&fuzzyEdits=1&implicit=or`
   and `fetch()` runs it.

*(Dev: Vite proxies to `:3000`. Prod: same origin — nginx or Fastify static
serves the page and the API from one host.)*

### Step 2 — HTTP edge (Fastify)

4. `src/api/app.ts:52` — Fastify parses the query string against the JSON
   Schema at `app.ts:102`: `q` required (1…512), `k` coerced to integer
   (1…50), `page` (1…1000), `fuzzy` to boolean, `fuzzyEdits` ∈ {1,2},
   `implicit` ∈ {and,or}; unknown params are dropped (`removeAdditional`).
   A violation short-circuits as `400 {"error":{"code":"VALIDATION",…}}`.
5. `app.ts:120` — the handler does one thing: forward the validated query
   object to `service.search(...)`. No engine imports are used here.

### Step 3 — the service seam (`search-service.ts:480`)

6. `runtime(corpus)` (`:339`) — cache lookup for `scifact`; on first use it
   runs `loadIndexBundle('scifact')` (mmap-style read of
   `data/index/scifact.aidx` + ids map + corpus hash) and creates the
   corpus's doc store. This is also where `503 INDEX_UNAVAILABLE` comes from.
7. Caps re-checked in the service (defence in depth) →
   `400 INVALID_PARAMS` if violated; `strategy` resolved via
   `strategyFor()` → `400 INVALID_STRATEGY` / `STRATEGY_UNAVAILABLE`
   (`bm25-pr` needs a PageRank source).

### Step 4 — the shared pipeline (identical to benchmarks)

8. **parse** (`:527`) `parseQuery('stem cells', {implicitOperator:'or'})`
   → AST (`src/core/query/`). Syntax errors → `400 QUERY_PARSE … position N`.
9. **analyze** (`:542`) `analyzeQuery(parsed, analysis)` — lowercase →
   tokenize → stop words → Porter stem, using the *index-time* analysis
   chain so query and index agree (`stem cells → stem cell`).
10. **fuzzy?** (`:570`) with `fuzzy=false` this is skipped; with
    `fuzzy=true`, `expandFuzzyQuery` probes absent terms against the
    dictionary within k edits and rewrites the AST, recording
    `termsAttempted / termsExpanded / variantsAdded` for `meta.fuzzy`.
11. **candidates** (`:579`) `retrieveAnalyzed(reader, analyzed)` walks the
    postings lists for the boolean structure → candidate doc set +
    `meta.diagnostics.candidates`.
12. **rank** (`:584`) `strategy.rank(reader, analyzed, candidates)` — for
    BM25 that is Σ idf · tf-norm with the strategy's k1/b
    (`bm25-k1.2-b0.75`); the strategy also returns the **breakdown**
    (`{bm25, phrase, proximity, pagerank, …}`) per hit — the data the UI
    draws as bars.
13. **page + map + snippets** — top `k·page` ids sliced, docIds mapped via
    the ids map, `makeSnippet()` picks the best window and emits highlight
    offsets (`snippet.ts` → `snippets.ts`), titles/urls come from the doc
    store. Timing marks (parse/analyze/fuzzy/retrieve/rank/map) are
    assembled into `meta.timing`; total → `meta.latencyMs`, pushed into the
    100-entry `latencyRing` (`:613`) that `/api/stats` reports.

### Step 5 — back to the browser

14. The JSON body (see [`API.md`](API.md)) is returned by Fastify with
    `content-type: application/json`.
15. `client.ts` validates nothing — it hands the typed body back; on non-2xx
    it throws `ApiError` with the server's code.
16. `SearchWindow.tsx:86` — `setData(res)` renders:
    - results list → rank/title/snippet (`<mark>` from `highlights`),
    - `SignalBars` from `results[].signals`,
    - status line from `meta` (engine id, latency, corpus),
    - diagnostics drawer from `meta.diagnostics` + `meta.timing`.
17. Clicking a title → `App.tsx:132` `openDoc(corpus, docId, q)` opens a
    `doc:<corpus>:<id>` window → `DocWindow` calls
    `/api/documents/scifact/<id>?q=stem+cells` → matched terms, phrase
    matches and the live PageRank value for that document.

### The same trace in one process

`npm run demo` performs steps 4–13 **without HTTP** (`buildApp()` +
`app.inject()`), which is exactly how `tests/api.test.ts` exercises the
contract — so the demo, the tests, the curl session, and the UI are four
views over one code path.

---

## 3. Invariants worth keeping

- Numbers on screen ⇐ API ⇐ committed artifacts / live index — no component
  fabricates a score, metric, or timing.
- `src/core` stays pure; if a change needs `fs`/`pg`/`fastify`, it belongs
  in `scripts/`, `src/api/`, or `src/storage/`.
- A new endpoint = one route in `app.ts` + one service method + one
  contract test; a new UI panel = one window component + fixtures in
  `App.test.tsx` mirroring the contract.
