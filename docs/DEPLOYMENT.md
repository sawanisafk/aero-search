# Deployment

Two supported ways to run the product: **local production build** and
**Docker Compose** — both verified on this machine (2026-10-08: compose
stack `config → build → up` green; postgres + api healthchecks healthy;
`http://localhost:8080` serves the SPA and proxies `/api` to the api
container). Docker Desktop 4.94 with the WSL 2 backend.

## 1. Local production (verified)

```bash
npm install
npm run build        # tsc → dist/  +  vite → web/dist/
npm start            # node dist/src/api/server.js  → http://127.0.0.1:3000
```

`npm start` serves **everything from one process**: the REST API and, when
`web/dist/index.html` exists, the Aero desktop at `/` (SPA fallback for
client-side routes, JSON 404 for unknown `/api/*`).

Development loop:

```bash
npm run api          # API with reload: npm run api:dev
npm run web:dev      # Vite on :5173 proxying /api + /health to :3000
```

## 2. Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | bind address (use `0.0.0.0` in containers) |
| `PORT` | `3000` | HTTP port |
| `AERO_CORPUS` | `scifact` | default corpus for `/api/search` and `/api/stats` |
| `AERO_STRATEGY` | `bm25` | default ranking strategy |
| `AERO_IMPLICIT` | `or` | default operator between bare terms (`and`\|`or`) |
| `AERO_CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | comma list; **empty string = same-origin only** |
| `DATABASE_URL` | *(unset)* | PostgreSQL; needed only for crawled-corpus text, crawled PageRank, crawler metadata |

Validation and caps live in `src/api/config.ts` (`MAX_K=50`, `MAX_PAGE=1000`,
`MAX_QUERY_LENGTH=512`); the same numbers are enforced by the JSON Schemas
(defence in depth).

Data directories the runtime reads from `process.cwd()` (the repo root):

```
data/index/      *.aidx segments + ids maps        (required)
data/corpora/    corpus.jsonl + static-v1 html/    (document text/metadata)
data/eval/       scifact-citations.json (bm25-pr), manifests
runs/, benchmarks/results/                         (/api/benchmarks evidence)
web/dist/        built frontend (optional; API works without it)
```

`data/pg/` (embedded development PostgreSQL, 48 MB) is **not** needed at
runtime and is excluded from images.

## 3. Docker Compose

`docker-compose.yml` — three services:

| Service | Image | Ports | Notes |
|---|---|---|---|
| `postgres` | `postgres:16-alpine` | 5432 | user/pass/db `aero`/`aero`/`aero_search`, volume `pgdata`, `pg_isready` healthcheck |
| `api` | build `Dockerfile` | 3000 | `HOST=0.0.0.0`, `DATABASE_URL → postgres`, `AERO_CORS_ORIGINS=""` (browser talks to nginx), healthcheck on `/health` |
| `web` | build `web/Dockerfile` | 8080 → 80 | nginx: static SPA + `location /api/` and `/health` → `http://api:3000` |

```bash
docker compose up --build
docker compose exec api node dist/scripts/db-migrate.js   # first start: migrations
docker compose down          # stop;  docker compose down -v  also drops pgdata
```

Startup order is health-gated (`postgres` healthy → `api` healthy → `web`).

### Image design

**`Dockerfile` (api)** — multi-stage:

1. `build` (node:22-slim): `npm ci` (dev deps for `tsc`), copy
   `src scripts benchmarks web`, `npm run build` (= `tsc` + `vite build`).
2. `runtime` (node:22-slim): `npm ci --omit=dev`, then `dist/`,
   `web/dist/`, `data/{index,corpora,eval}`, `runs/`, `benchmarks/`.
   CMD `node dist/src/api/server.js`; HEALTHCHECK hits `/health`.

**`web/Dockerfile`** — builds the SPA from the workspace root (context must
be the repo root: `web/` is an npm workspace), then copies `web/dist` into
`nginx:1.27-alpine` with `web/nginx.conf`.

**`.dockerignore`** — `node_modules`, `dist`, `.git`, `data/pg` (keeps the
build context ~140 MB smaller).

## 4. Operational notes

- **No authentication.** The API is open by design (single-user final-year
  project). Do not publish port 3000/8080 to an untrusted network; put a
  reverse proxy with auth in front if you must share it.
- **PostgreSQL is never in the query hot path** (ADR-003): searches work
  fully without the database; `DATABASE_URL` only unlocks crawled-corpus
  document text, crawled PageRank, and offline jobs.
- **Evidence endpoint** `/api/benchmarks` re-reads JSON files per request —
  fine for demos, cache it (nginx) if you care.
- **Rebuilding an index** after deleting `data/index/`:
  `npm run index:build -- --corpus <name>` (otherwise `503 INDEX_UNAVAILABLE`
  with exactly that hint in the message).

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `503 INDEX_UNAVAILABLE` | index missing → `npm run index:build -- --corpus <name>` |
| `400 STRATEGY_UNAVAILABLE` (`bm25-pr`) | corpus has no PageRank source (scifact citation graph committed; crawled needs `DATABASE_URL` + `pagerank_runs`) |
| browser `NETWORK` error in UI | API not running (`npm run api`) or dev port mismatch |
| CORS error in dev | `AERO_CORS_ORIGINS` must include your Vite origin |
| UI 404 at `/` | `web/dist` missing → `npm run web:build` (Fastify only registers static when `index.html` exists) |
