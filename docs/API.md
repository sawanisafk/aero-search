# REST API

The HTTP layer in `src/api/` (Fastify 5). Six JSON endpoints, all `GET`, no
auth (single-user project — see `docs/DEPLOYMENT.md` for exposure guidance).

```bash
npm run api            # dev: tsx src/api/server.ts  → http://127.0.0.1:3000
npm run build && npm start   # production: serves web/dist too
```

The API is a **thin layer over the shared pipeline** — every `/api/search`
request runs the same `parseQuery → analyzeQuery → [expandFuzzyQuery] →
retrieveAnalyzed → strategy.rank` chain the benchmarks measured
(`scripts/lib/retrieval-run.ts`). No ranking logic lives in `src/api/`.

## Conventions

| | |
|---|---|
| Transport | `GET` + query string, JSON responses (`content-type: application/json`) |
| Validation | declarative JSON Schema (AJV: `coerceTypes`, `useDefaults`, `removeAdditional`) — same caps as the service layer |
| Caps | `q` ≤ 512 chars · `k` ∈ [1, 50] · `page` ∈ [1, 1000] · `fuzzyEdits` ∈ {1, 2} |
| Errors | always `{"error": {"code": "...", "message": "..."}}` — never a stack trace, never a filesystem path |
| CORS | origin list from `AERO_CORS_ORIGINS` (default `localhost:5173` dev origins; empty string = same-origin only) |
| Static UI | if `web/dist/index.html` exists it is served at `/`; unknown non-`/api` paths fall back to it (SPA), unknown `/api/*` paths return JSON 404 |

### Error codes

| Code | HTTP | Raised when |
|---|---|---|
| `VALIDATION` | 400 | query-string schema violation (AJV) |
| `QUERY_PARSE` | 400 | query text does not parse (`… at position N`) |
| `INVALID_QUERY` | 400 | empty query / over the length cap |
| `INVALID_STRATEGY` | 400 | unknown `strategy` id |
| `INVALID_CORPUS` | 400 | unknown `corpus` |
| `INVALID_FUZZY` | 400 | invalid fuzzy configuration |
| `INVALID_PARAMS` | 400 | `k`/`page` out of range |
| `STRATEGY_UNAVAILABLE` | 400 | `bm25-pr` on a corpus without a PageRank source |
| `DOC_NOT_FOUND` | 404 | document id not in the corpus |
| `NOT_FOUND` | 404 | no route (`/api/…`) |
| `INDEX_UNAVAILABLE` | 503 | index segment missing / unreadable |
| `INTERNAL` | 500 | unexpected failure (logged server-side) |

Client-side (never sent by the server): `NETWORK` (fetch failed),
`BAD_RESPONSE` (non-JSON body) — see `web/src/api/client.ts`.

---

## `GET /health`

Liveness + what is loaded. No parameters.

```json
{ "status": "ok", "version": "0.1.0", "uptimeMs": 8124,
  "corpora": ["20newsgroups", "crawled", "scifact", "static-v1"],
  "loadedCorpora": ["scifact"], "searches": 42 }
```

## `GET /api/search`

The retrieval pipeline.

| Param | Type | Default | Notes |
|---|---|---|---|
| `q` | string | *required* | 1…512 chars; Boolean syntax: `AND OR NOT "phrases"` |
| `corpus` | string | `cqadupstack-tierb` (`AERO_CORPUS`) | must be built (`data/index/<name>.aidx`) |
| `strategy` | string | `bm25` (`AERO_STRATEGY`) | `boolean`, `tfidf`, `bm25`, `bm25-phrase`, `bm25-phrase-proximity`, `bm25-pr` |
| `k` | int | 10 | results per page (≤ 50) |
| `page` | int | 1 | 1-based paging over candidates |
| `fuzzy` | bool | `false` | bounded edit-distance expansion of absent terms |
| `fuzzyEdits` | 1 \| 2 | 1 | k=2 measured slower *and* less precise (M4-C) |
| `implicit` | `and` \| `or` | `or` | operator between bare terms |

```bash
curl 'http://127.0.0.1:3000/api/search?q=stem%20cells&strategy=bm25&k=3'
```

Response (abridged — full shape `SearchResponse` in `src/api/search-service.ts`):

```json
{
  "query": "stem cells",
  "strategy": "bm25",
  "results": [
    { "rank": 1, "docId": "1048", "title": "Targeted therapy for cancer stem cells: the…",
      "url": null, "source": "scifact",
      "snippet": { "text": "…", "highlights": [{"start": 27, "end": 31, "term": "stem"}],
                   "matched": true, "sourceStart": 24 },
      "score": 6.2848,
      "signals": { "bm25": 6.2848 } }
  ],
  "meta": {
    "corpus": "scifact", "k": 3, "page": 1, "totalPages": 1, "totalCandidates": 41,
    "returned": 3, "latencyMs": 14.94,
    "timing": { "parseMs": 0.04, "analyzeMs": 0.06, "fuzzyMs": 0, "retrieveMs": 11.2,
                "rankMs": 3.4, "mapMs": 0.05 },
    "fuzzyApplied": false, "expandedTerms": [],
    "fuzzy": { "applied": false, "edits": 1, "expansions": [], "stats": null },
    "strategyDetail": { "id": "bm25", "engineId": "bm25-k1.2-b0.75",
                        "mode": "B", "params": { "k1": 1.2, "b": 0.75 } },
    "diagnostics": { "implicitOperator": "or",
                     "parsed": { "…": "query AST" },
                     "analyzedTerms": ["stem", "cell"],
                     "positiveTerms": ["stem", "cell"], "candidates": 41 }
  }
}
```

Reading the payload:

- `results[].signals` — per-signal score components exactly as the strategy
  produced them (`boolean` / `tfidf` / `bm25` / `phrase` / `proximity` /
  `pagerank`); this is what the UI draws as bars ("why did this rank here?").
- `meta.strategyDetail.engineId` — the engine-internal strategy identity
  (e.g. `bm25-k1.2-b0.75`, `tfidf-raw`, `bm25-pr-w0.2`); `id` echoes what you asked.
- `meta.fuzzy` — when `fuzzy=true`: which absent terms were attempted and
  which variants were added (`wonderlan → [wonderland]`, distance 1).
- `meta.timing` — per-stage milliseconds inside the service (parse, analyze,
  fuzzy, retrieve, rank, map-to-ids); `latencyMs` is the total.

Fuzzy contrast (the demo case):

```bash
curl '…/api/search?q=wonderlan&corpus=static-v1'                       # results: []
curl '…/api/search?q=wonderlan&corpus=static-v1&fuzzy=true'            # results: 10,
                                                                       # meta.fuzzy.expansions[0].variants=["wonderland"]
```

`bm25-pr` needs a PageRank source: scifact → committed citation graph
(`data/eval/scifact-citations.json`); crawled → PostgreSQL `pagerank_runs`
only when `DATABASE_URL` is set; otherwise `400 STRATEGY_UNAVAILABLE`.

## `GET /api/documents/:corpus/:id`

Full document view. `:id` is a wildcard path segment (crawled ids are raw
URLs, so URL-encode them; a second decode pass runs only when `%` survives).
Optional `q` adds this query's matched terms and phrase matches.

| Param | Type | Notes |
|---|---|---|
| `q` | string | if present: `matchedTerms[]` (tf/df) and `phrases[]` (matched?) are computed |
| `fuzzy` | bool | apply the same fuzzy expansion when resolving `q` |

```bash
curl 'http://127.0.0.1:3000/api/documents/scifact/1048?q=stem%20cells'
```

```json
{ "corpus": "scifact", "docId": 1048, "id": "1048",
  "title": "…", "url": null, "source": "scifact",
  "text": "…", "textTruncated": false,
  "pagerank": 0.000161,
  "matchedTerms": [{ "term": "stem", "tf": 3, "df": 120 }],
  "phrases": [{ "terms": ["stem", "cell"], "matched": true }] }
```

`text` is the stored body (capped at 20 000 chars → `textTruncated: true`).
Metadata source per corpus: scifact/20newsgroups `data/corpora/<n>/corpus.jsonl`,
static-v1 metadata + `html/`, crawled → PostgreSQL (needs `DATABASE_URL`),
otherwise `text: null`.

## `GET /api/stats?corpus=<name>`

Index + service status for one corpus (default: `AERO_CORPUS`):

`corpus` block (docs/vocab/postings/tokens/avg length/index bytes/
`corpusHash`/metadata store), `corpora[]` with sizes, `strategies[]` with
availability + reason, `pagerank` (available, source, nodes/edges, iterations,
residual, converged, damping, graphHash), `fuzzy.defaults`, `crawl` manifest
when present, `search` traffic (total + recent avg/p95 from a 100-sample ring).

## `GET /api/config`

Runtime configuration for UIs: `version`, `defaultCorpus/defaultStrategy/defaultK`,
`maxK/maxPage`, `implicitOperator`, `corpora[]`, `strategies[]`
(`id, label, available, reason?`), `fuzzyDefaults`.

## `GET /api/benchmarks`

Committed experiment artifacts, **read from disk, never recomputed**
(`runs/*.json` + `benchmarks/results/*`):

- `runs[]` — quality runs: strategy, mode, corpus, `map`, `ndcg10`,
  `recall100`, latency, fuzzy flag, git SHA, timestamp
- `fuzzyBenches[]` — clean/typo/fuzzy arms with all metrics
- `queryBenches[]` — per-stage latency distributions
- `pagerankRuns[]` — convergence (iterations/residual), graph size, top URLs

```bash
curl '…/api/benchmarks' | jq '.runs[] | select(.strategy=="bm25-k1.2-b0.75" and (.fuzzy|not)) | .map'
# 0.6436   ← the locked SciFact baseline, served from runs/
```

## Measured latency

From the committed API benchmark artifact
(`benchmarks/results/2026-10-08T12-33-35-546Z-api-benchmark.json`,
30 requests/route after 5 warmups, loopback HTTP + JSON, `npm run bench:api`):

| Route | avg ms | median | p95 |
|---|---|---|---|
| `/health` | 1.16 | 1.02 | 2.13 |
| `/api/config` | 0.75 | 0.59 | 1.25 |
| `/api/stats` | 2.24 | 2.20 | 2.89 |
| `/api/search` (bm25) | 2.19 | 2.07 | 3.14 |
| `/api/search` (tfidf) | 1.90 | 1.89 | 2.56 |
| `/api/search` (phrase) | 14.70 | 16.11 | 16.98 |
| `/api/search` (fuzzy k=1) | 1.60 | 1.42 | 2.65 |
| `/api/search` (page 2) | 1.88 | 1.69 | 3.14 |
| `/api/documents/…` | 0.56 | 0.46 | 1.00 |
| `/api/benchmarks` | 20.80 | 20.47 | 22.51 |
| **overall** | **4.78** | **1.83** | **20.49** |

(`benchmarks` re-reads 20+ JSON files per request on purpose — it is the
evidence endpoint; `phrase` pays positional intersection over 1,109-token
average docs. Engine-internal stage timings stay in `*-query-benchmark.json`.)

## Contract tests

`tests/api.test.ts` — 26 tests over `app.inject()` (no port): happy paths,
validation 400s, fuzzy contrast, all six strategies, document detail with
live PageRank, stats/config/benchmarks with **locked artifact values**
(MAP 0.6436, nDCG@10 0.687552, PageRank 52 iterations / 77 nodes), CORS,
SPA fallback, error envelope. Run: `npm test`.
