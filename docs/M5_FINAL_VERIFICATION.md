# M5 final verification — acceptance matrix

Session: 2026-10-08, Windows 10 (PowerShell), Node v24.13.0, worktree
`…/website/search engine`. Every result below is a fresh run from this
session; nothing is quoted from an older state.

## 1. Acceptance criteria

| # | Criterion | Evidence | Result |
|---|---|---|---|
| 1 | No search engine / DB is used to serve queries (no Elasticsearch/Solr/Meilisearch/Typesense/Algolia) | query path is `src/core` via `src/api/search-service.ts`; `package.json` deps contain none of them | ✅ |
| 2 | No AI/LLM/embeddings/vector DB anywhere | grep of `src/`, `web/src/`, `scripts/` shows no model/vector dependencies; ranking is TF-IDF/BM25/phrase/proximity/PageRank/fusion | ✅ |
| 3 | M0–M4 not rewritten; tests not deleted/modified to accommodate M5 | only additive: `src/api/*`, `web/*`, `scripts/demo.ts`, `scripts/bench-api.ts`, `tests/api.test.ts`; core untouched (git log `9e95a45..61f2b75` — `git show --stat` shows no `src/core` or `tests/*` edits except new `tests/api.test.ts`) | ✅ |
| 4 | Retrieval pipeline not duplicated in the API | `SearchService.search()` calls the same `parseQuery/analyzeQuery/expandFuzzyQuery/retrieveAnalyzed/strategy.rank` as the benchmark harness (trace: `docs/CODE_WALKTHROUGH.md` §2) | ✅ |
| 5 | Historical results not fabricated or modified | no `runs/*`, `benchmarks/results/*` (pre-existing), `data/eval/*` touched; only one new artifact added (`…12-33-35-546Z-api-benchmark.json`) | ✅ |
| 6 | All existing npm commands still work | `npm run typecheck`, `npm test`, `npm run build` all green below; scripts only extended | ✅ |
| 7 | REST API: endpoints, validation, error envelope | `tests/api.test.ts` 26/26; envelope `{error:{code,message}}`; caps enforced twice (schema + service) | ✅ |
| 8 | Aero UI: windows/taskbar/search/details/status | `web/src/App.test.tsx` 5/5 behaviors; manual smoke below | ✅ |
| 9 | Tests green: API contract + UI | 312 root + 15 web | ✅ |
| 10 | Typecheck clean | root + `--workspace web`, no output | ✅ |
| 11 | Docker present | `Dockerfile`, `web/Dockerfile`, `web/nginx.conf`, `docker-compose.yml`, `.dockerignore` committed | ⚠️ inspection-only — **no Docker on this machine** (stated honestly in `docs/DEPLOYMENT.md`) |
| 12 | Docs: API/frontend/demo/deploy/walkthrough | `docs/API.md`, `FRONTEND.md`, `DEMO.md`, `DEPLOYMENT.md`, `CODE_WALKTHROUGH.md`, `M5.md`; README restructured to 12 sections | ✅ |
| 13 | No "complete" claim without verification | this document | ✅ |

## 2. Verification runs (fresh this session)

### typecheck

```text
> tsc --noEmit && npm --workspace web run typecheck
> tsc --noEmit
(no output — green)
```

### root suite

```text
Test Files  22 passed (22)
     Tests  312 passed (312)
  Duration  15.87s
```

includes `tests/api.test.ts (26 tests)` · `pipeline` · `postgres` ·
`crawl-e2e` (existing suites intact).

### web suite

```text
✓ src/api/client.test.ts (10 tests) 10ms
✓ src/App.test.tsx (5 tests) 842ms
Test Files  2 passed (2)
     Tests  15 passed (15)
  Duration  4.04s
```

### build

```text
tsc -p tsconfig.json && vite build
dist/index.html                   0.97 kB
dist/assets/index-DtgVBa1L.css   18.34 kB │ gzip: 5.16 kB
dist/assets/index-uWHKhK5q.js   262.28 kB │ gzip: 78.15 kB
✓ built in 315ms
```

### scripted demo (`npm run demo`, in-process, no port)

```text
demo: 14/14 steps ok
```

Highlights: health + config (6/6 strategies) · bm25 10 hits, #1 score
6.2848 · six-strategy sweep with distinct engine ids (boolean score 0.0000
→ tfidf 48.4339 → bm25 6.2848 → phrase 6.2848 → proximity 7.2848 → bm25-pr
0.9116) · phrase 5 hits (phrase=1.200) · fuzzy contrast 0 → 10 hits
(expansions `[wonderland]`, corpus static-v1) · doc detail pagerank
0.000161 · stats 5,183 docs / vocab 26,299 · benchmarks 15 runs, MAP 0.6436.

### live production smoke (`node dist/src/api/server.js`, PORT 4310)

```text
200 /                    → <!doctype html> (built Aero UI)
200 /status              → <!doctype html> (SPA fallback)
200 /api/search?q=stem%20cells&k=3 → {"query":"stem cells","strategy":"bm25","results":[…]}
404 /api/nope            → JSON error envelope
```

server log: `aero-search api listening http://127.0.0.1:4310`.

### measured API latency (committed artifact)

`benchmarks/results/2026-10-08T12-33-35-546Z-api-benchmark.json` —
10 routes × 30 requests after 5 warmups (real loopback HTTP, full body
read): **overall avg 4.78 ms · median 1.83 ms · p95 20.49 ms** (n = 300);
per-route: health 1.16, config 0.75, stats 2.24, search-bm25 2.19,
search-tfidf 1.90, search-phrase 14.70, search-fuzzy 1.60, page2 1.88,
document 0.56, benchmarks 20.80 (artifact re-read by design).

## 3. Commit list (M5 series)

| Commit | Contents |
|---|---|
| `9e95a45` | feat(api): Fastify JSON API (6 endpoints, schema validation, error envelope, static+SPA, 26 contract tests) |
| `0817baf` | feat(web): React 19 + Vite 8 Aero desktop (22 files, 15 tests) |
| `9933ed2` | feat(api): `scripts/demo.ts` (14 checks) + `scripts/bench-api.ts` |
| `fe71c91` | chore(evidence): API latency benchmark artifact |
| `61f2b75` | chore(docker): api/web Dockerfiles, nginx conf, `.dockerignore`, compose extension |
| *(this docs commit)* | docs(m5): API/FRONTEND/DEMO/DEPLOYMENT/CODE_WALKTHROUGH/M5/README+REPORT+DEVELOPMENT updates + this file |

Tags: `m2-complete` (`b23a551`), `m3-complete` (`d6d598c`) pushed earlier;
`m4-complete` created on `0e73bf8` this session and pushed with this batch.

## 4. Known limitations (not hidden)

1. **Docker is untested at runtime** — no Docker on this machine; the
   files are config-inspection-verified only. First run on a Docker host:
   `docker compose up --build` (`docs/DEPLOYMENT.md`).
2. **Screenshots pending** — all UI proof so far is automated tests + live
   HTTP smoke; capture sequence in `docs/DEMO.md` §3.
3. **Descoped by documented decision** (see `docs/M5.md` scope table):
   generated OpenAPI endpoint (readable `API.md` instead), Zod (Fastify
   JSON Schema instead), Ctrl+K/arrow keybinding layer, client-side
   settings persistence.
4. **M6 (1K/10K/100K scale tables, throughput charts) still pending** —
   out of M5 scope; evidence so far is query/fuzzy/pagerank/api latency.
5. Dev server note: use `npm run api` (tsx) or `npm start` (dist);
   raw `node src/api/server.ts` fails on `.js` specifiers — documented in
   `DEPLOYMENT.md` troubleshooting.

## 5. Reproduce everything

```powershell
npm run typecheck     # silent
npm test              # 312/312
npm run web:test      # 15/15
npm run build         # dist + web/dist
npm run demo          # 14/14
npm start             # http://127.0.0.1:3000 (UI + API)
npm run bench:api     # writes a fresh latency artifact
```
