# System Architecture — Aero Search (working title)

> Engineering document. Explains **how the software is structured**.
> For *why each technology was chosen*, see [DECISIONS.md](DECISIONS.md).
> For *what to build when*, see [DEVELOPMENT.md](DEVELOPMENT.md).
> The academic report is a **separate** deliverable and is not derived by copying this file.

---

## 1. Problem statement

Given a corpus `D = {d1..dN}` and a query `q`, return an ordered subset of `D` relevant to `q`,
in time substantially lower than a full corpus scan, ranking with multiple evidence signals,
with quality **quantifiably measured** against human relevance judgments.

Target envelope: single machine, 10⁴–10⁴·⁵ documents, sub-100 ms queries.
Non-goals: web-scale crawl, distributed sharding, answering questions (AI layer is optional and external — §10).

**Core constraint:** the inverted index and every ranking formula (TF-IDF, BM25, PageRank,
phrase/proximity, fuzzy, fusion) are implemented in this repository. No external search engine
may serve queries.

---

## 2. Execution planes

The system is split into three planes with hard boundaries:

```
━━━━━━━━━━ OFFLINE PLANE (batch) ━━━━━━━━━━

 seeds → [CRAWLER] → frontier/visited → fetch (undici) → parse (cheerio)
            │                                        │
            ▼                                        ▼
      PostgreSQL ◄── link edges ──── [EXTRACTION] title/headings/body/links/meta
   system of record:                  │
   documents, urls,        [TEXT PROCESSING] normalize → tokenize → stop → stem
   crawl state, links,                  │
   qrels, runs, metrics                 ▼
            │                   [INDEX BUILDER] term dict + postings + positions
            │                             │        + doc statistics
            ▼                             ▼
      [PAGERANK JOB]              INDEX SEGMENT FILES (derived artifact,
   power iteration over           rebuildable from PostgreSQL)
   link graph → value/doc                │
            └──────► written to PG ◄─────┘  loaded at API boot

━━━━━━━━━━ ONLINE PLANE (per query) ━━━━━━━━━━

 UI ──REST──► [API]
                ▼
      parse → normalize (shared tokenizer) → term lookup
        → candidate retrieval (boolean over postings)
        → phrase/proximity (positional intersection)
        → fuzzy expansion (only for low-df terms)
                ▼
      [RANKING ENGINE] pluggable signals → raw scores
                ▼       → per-query normalization → fusion (mode config A–E)
      [POST-RANKING] snippet from stored positions, highlights, pagination
                ▼
      explain payload {bm25, phrase, proximity, pagerank, fuzzy, final}
                ▼
      [AERO UI] results + "Ranking Details" panel

━━━━━━━━━━ EVALUATION PLANE (research) ━━━━━━━━━━

 qrels + queries ──► [EVAL RUNNER] for each (mode × param set):
        run queries → metrics (P@K, R@K, F1, MAP, NDCG@K) + latency
        → run artifacts (config hash, git SHA, corpus hash, timestamp)
        → [REPORT GEN] tables / charts
```

---

## 3. Module dependency rules

| Layer | Path | May depend on | Must NOT depend on |
|---|---|---|---|
| **core** | `src/core/` | nothing (pure stdlib TS) | fs, net, pg, fastify, react |
| crawler | `src/crawler/` | core, storage adapters | api, web |
| storage | `src/storage/` | core interfaces | api, web |
| api | `src/api/` | core, storage | web |
| eval | `src/eval/` | core, api contract | web |

These rules are the architecture's load-bearing walls:

- `core` purity → retrieval logic is unit-testable without a database, and the same
  `tokenize()` function is used at **index time and query time** (guaranteed, not convention).
- Storage implements `IndexReader` / `IndexWriter` / repository interfaces → storage can be
  swapped without touching ranking code.
- The UI depends only on the REST contract (shared types), never on internals.

### Key interfaces

```ts
interface Tokenizer   { tokenize(text: string): string[] }

// implemented in src/core/index/ — the writer runs the shared analyzer
// itself, so addDocument takes raw text, not pre-tokenized terms
interface IndexWriter { addDocument(doc: AddDocumentInput): number; finalize(): IndexData }

interface IndexReader {
  getTermId(term: string): number | undefined;
  postings(termId: number): TermPostingsView;  // lazy view, not materialized arrays
  docLength(docId: number): number;
  stats(): IndexStats;   // { numDocs, vocabSize, numPostings, totalTokens, avgDocLength }
}

// postings are decoded on demand (delta encoding makes decoding sequential)
interface TermPostingsView {
  df: number;
  docIds(): Uint32Array;
  forEach(visit: (index: number, docId: number, tf: number) => void): void;
  positions(globalIndex: number): number[];   // O(tf) decode of one run
}

interface RankingSignal {
  id: 'tfidf' | 'bm25' | 'phrase' | 'proximity' | 'pagerank' | 'fuzzy';
  compute(q: ParsedQuery, candidates: number[], ctx: SearchContext): Map<number, RawScore>;
}

interface Ranker { mode: string; rank(q, candidates, ctx): ScoredDoc[] }
// ScoredDoc carries per-signal raw + normalized breakdown for explainability
```

---

## 4. Data architecture

**Principle: PostgreSQL = source of truth; index = derived rebuildable artifact; query path = memory.**

### PostgreSQL (never in the query hot path)

**As built in M3** (DDL: `migrations/001_init.sql`, details: [DATABASE.md](DATABASE.md)):

| Table | Contents |
|---|---|
| `urls` | crawl frontier: normalized_url (PK), status pending/fetched/failed/skipped, depth, http status, content_type, bytes, error, discovered_from, redirect_chain JSONB, fetch_ts — partial index drives BFS |
| `documents` | url (PK, FK → urls), title, headings JSONB, meta JSONB, text, word_count, unique_terms, content_hash (partial-unique while owning content), duplicate_of (FK → documents), fetch_ts |
| `links` | from_url (FK → documents, cascade) → to_url (free text — target may be pending/off-allowlist/uncrawled), anchor, position — the directed graph for PageRank |
| `pagerank_runs` / `pagerank_scores` | **M4-A:** run parameters + convergence outcome + graph hash + git SHA; url-keyed stationary scores (read once offline, never in the query path) |

Conceptual, deferred (PostgreSQL vs files decided when they land):

| Table (conceptual) | Contents |
|---|---|
| `queries` / `qrels` | query text; query_id × doc_id × grade — currently committed files under `data/eval/` |
| `runs` / `metrics` | mode, params JSON, git_sha, corpus hash, latency, P@K, NDCG@K — currently committed files under `runs/` |

### Custom index (in memory, persisted as segment files)

- **Term dictionary:** `term → termId` hash map + `termId → {term, df, postingsRef}`.
- **Postings:** per term, delta-encoded `Uint32Array` docIds + `Uint16Array` tfs.
- **Positions:** per-doc delta-encoded position runs (concatenated with per-doc offsets).
- **Doc stats:** `docLen` in a flat `Uint32Array` indexed by docId; corpus `N`, `avgdl`, `vocabSize`.
- **Presentation table:** docId → {title, url}. **Bodies stay in PostgreSQL**, fetched only for
  the top-K results during snippet generation (keeps text out of the JS heap).

### Storage strategy (phased)

1. **Build:** in-memory construction.
2. **Persist:** versioned segment files (binary varint deltas + a JSON debug format), loaded at API boot.
3. **Only if benchmarks demand:** lazy term loading, block postings with skip pointers.

**Rejected:** postings as PG rows (latency + hides the data-structure work); `tsvector` as engine
(not our implementation); in-memory only (no restart, no construction-time experiment); `mmap`
(no clean Node API — complexity without need).

**Consistency:** crawl/ingest writes PG → full offline index rebuild → new segment generation →
atomic swap at boot. No incremental indexing in v1 (segment generations leave the path open).

---

## 5. Index & query architecture

### Why an inverted index (design rationale)

A scan costs `O(Σ|d|)` per query. An inverted index answers "docs containing *t*" with an
`O(1)` dictionary lookup + `O(df_t)` traversal; multi-term AND is a merge over *query-term
postings only* — cost tracks query term frequencies, not `N`. Positions add phrase/proximity
capability without re-reading documents.

### Memory design (decisive for TypeScript)

Estimated at N = 100K docs, ~500 tokens/doc, ~300 unique terms/doc:

| Component | Estimate (typed arrays) |
|---|---|
| postings (~30M × 3–4 B) | 100–150 MB |
| positions (~50M × 1–2 B) | 50–100 MB |
| dictionary (~0.5M terms) | tens of MB |
| docLen + title/url table | tens of MB |
| **total** | **≈ 200–400 MB** |

The same data as JS objects (30M posting objects × ~80 B) is **≥ 2.5 GB → OOM on the default
heap**. Therefore **typed arrays + integer termIds are mandatory, not an optimization**.
Figures are estimates; benchmarks (`/benchmarks`) validate them.

### Retrieval layers

1. **Boolean** (AND intersect / OR union) — the substrate for everything above.
2. **TF-IDF** — selectable tf weighting (raw / augmented / log) as an experimental axis.
3. **BM25** — see §6.
4. **Phrase** — `"a b c"` → positional intersection at offsets `pos, pos+1, pos+2`.
5. **Proximity** — smallest window containing all query terms; score `k / (1 + (window − |q|))`.
6. **Fuzzy** — only for low-df terms: vocabulary bucketed by length (`|Δlen| ≤ k`) + first-char
   filter → bounded Levenshtein with early exit (threshold 1–2). Never all-pairs vocabulary scan.
7. **PageRank** enters at fusion, not retrieval.

### Query pipeline

```
parse (terms / quotes / fuzzy marker; bare adjacency = AND for the UI,
       = OR for evaluation — parseQuery(text, {implicitOperator}))
  → normalize (shared tokenize/stop/stem path with indexing)
  → term lookup → candidates (boolean over postings)
  → phrase/proximity (positional) → fuzzy expansion if needed
  → per-signal scoring → normalization → fusion (mode A–E)
  → snippets (positions → best window + highlight offsets) → paginate
```

**Explanation is a first-class output:** every signal returns raw + normalized components so
`/api/search?explain=true` can feed the UI's Ranking Details panel.

**Documented scale path (built only if measured need):** segment merging → skip pointers →
MaxScore/WAND pruning → sharding.

---

## 6. Ranking architecture

### Formulas (implemented in `src/core/ranking`, documented alongside the math)

**TF-IDF:** `score(q,d) = Σ tf(t,d) · ln(N / df_t)` with selectable tf weighting.

**BM25:**

```
score(q,d) = Σ  IDF(t) · tf·(k1+1) / ( tf + k1·(1 − b + b·|d|/avgdl) )
           t∈q
IDF(t) = ln( 1 + (N − df + 0.5)/(df + 0.5) )      defaults: k1 = 1.2, b = 0.75
```

- **tf saturation:** the 50th occurrence of a term is not 50× evidence (numerator/denominator asymptote).
- **length normalization:** a short doc matching fully is stronger evidence than a long doc
  that merely mentions the terms — `|d|/avgdl` penalizes verbosity.
- vs naive TF-IDF: no saturation control, no length control, common terms can dominate.

**PageRank:** `π ← (1−d)/N + d·(Aᵀπ + dangling/N)`, d = 0.85, iterate to `‖Δ‖₁ < 10⁻⁶`,
dangling mass redistributed. Complexity `O(iterations × E)`. Offline batch, after crawl.
Role: **bounded secondary authority signal** — never a replacement for lexical relevance.
As built (M4-A): `src/core/link/pagerank.ts` + `scripts/build-pagerank.ts`; evidence run
converged in 52 iterations (8.59e-7, 1.9 ms) over the crawl graph.

### Plug-in & fusion design

```
signals (from config, not code)
  → raw scores per signal
  → per-query normalization (min-max with outlier guard / z-score)
  → fusion:
      (a) weighted linear: Σ wᵢ·ŝᵢ     — weights live in configs/, swept in evaluation
      (b) RRF rank fusion (k=60)        — weight-free, normalization-free baseline
  → ScoredDoc { docId, score, breakdown: {bm25, phrase, proximity, pagerank, fuzzy} }
     // M2 field name is `score` (single total; per-signal breakdown already present);
     // a distinct `final` total appears in M4 when normalization/fusion land
```

BM25 (~0–40), PageRank (~0–0.02), phrase bonus (~0–2) are incommensurable — normalization is
mandatory before any weighted sum. RRF exists so the project has a defensible answer to
"how did you choose the weights?"

### Ranking modes (named config objects, used by API *and* evaluation)

| Mode | Composition |
|---|---|
| A | TF-IDF |
| B | BM25 |
| C | BM25 + phrase + proximity |
| D | BM25 + PageRank |
| E | Hybrid (all signals, tuned weights / fusion strategy) |

### Field weighting

Title/headings extracted separately; simple BM25F-style weighted tf
(`tf' = w_title·tf_title + w_body·tf_body`) so "query in title > query in body" is an
**experiment**, not an assumption.

---

## 7. Crawler architecture

Controlled by construction: committed seed list → optional domain allowlist → hard page limit,
depth limit, per-host delay, byte/time budget.

```
seed list → frontier (BFS by depth)
  → normalize URL (lowercase host, strip fragment, sort params, resolve relative)
  → visited/queued? drop (dedupe)
  → robots.txt check (cached per host; disallow → skip + log)
  → per-host politeness delay → undici fetch (timeout, redirect cap 5, retry+backoff)
  → non-2xx / non-text/html / oversized → record failure, drop
  → content_hash (sha1) → exact-duplicate handling (configurable)
  → cheerio extraction: title, h1–h3, meta, body text, canonical, outlinks
  → upsert document + insert link edges + enqueue children (depth < max)
  → metadata: fetch_ts, bytes, http status, redirect chain, content type
```

Decisions:

- Frontier **queues in memory**, every transition **persisted to PostgreSQL** (resume after
  crash; multi-worker frontier later without interface changes).
- robots.txt parsing is peripheral (tiny own parser); the engineering point is that it is
  respected and decisions are logged.
- `canonical` link + content hash both feed duplicate detection.
- Failures are recorded data → crawler-quality table in the report.
- Fetching sits behind a `Fetcher` interface: `HttpFetcher` (Undici) now;
  `BrowserFetcher` (Playwright) only if the corpus is JS-rendered.

**As built (M3):** all of the above implemented in `src/crawler/` — see
[CRAWLER.md](CRAWLER.md) for the exact pipeline, normalization rules, robots semantics
(RFC 9309 subset, fail-open on network errors), three dedup layers, and resume behavior.
Deliberately *not* built yet: crawl-wide byte budget, retry policy for failed URLs,
browser fetcher. Controlled-crawl evidence: seed `info.cern.ch`, 100 pages / 77 indexable
documents / 796 link edges / 22 recorded failures, manifest committed as
`data/eval/crawled.manifest.json`.

---

## 8. API architecture

```
GET  /api/search?q=&k=&offset=&mode=&fuzzy=&explain=
GET  /api/documents/:id
GET  /api/stats                GET /api/health        GET /api/modes
GET  /api/experiments          GET /api/experiments/:id
```

Response shape (Fastify JSON Schema → generated OpenAPI):

```jsonc
{
  "query": "machine learning algorithms",
  "totalResults": 12483,
  "tookMs": 38,
  "rankingMode": "D",
  "results": [{
    "documentId": 12, "title": "...", "url": "...",
    "snippet": "relevant passage with <mark>highlights</mark>",
    "score": 9.66,
    "explanation": {                        // present when explain=true
      "bm25": 7.82, "phrase": 1.20, "proximity": 0.31,
      "pagerank": 0.14, "fuzzy": 0, "final": 9.66,
      "weights": { "bm25": 0.6, "phrase": 0.15, "pagerank": 0.1 },
      "matchedTerms": ["machine", "learn", "algorithm"],
      "docLength": 412,
      "normFactors": { "bm25": 0.87, "pagerank": 0.42 }
    }
  }]
}
```

- `mode=A..E` selects ranking config **server-side** so UI settings and eval runs share one
  source of truth (`configs/`).
- Snippets generated server-side: index positions + body text fetched for top-K only.
- Offset/k pagination; LRU query cache keyed by `(q, mode, params)`; CORS for Vite dev;
  error envelope `{ error: { code, message } }`.

---

## 9. Evaluation architecture

Turns "a search website" into a research project. Built at **M2, before the crawler**.

1. **Corpus manifest** — committed URL list / seed set + crawl date + content hashes → every
   run reproducible. Corpus must have size (scaling claims), real link structure (PageRank),
   documented provenance.
2. **qrels** — M2 starts from **existing public judgments** (BEIR SciFact test: 300 queries,
   339 binary judgments, committed under `data/eval/` with a verified manifest) so the
   harness is validated against a published reference before we judge anything ourselves;
   the pooled graded 0–3 qrels over *our* crawled corpus (≈30–50 queries) arrive with M3.
3. **Pooling** — judge the merged top-10/20 pool from *all* ranking modes plus a random
   baseline (judging one system's output biases evaluation toward that system) — M3 onward
   on our own corpus.
4. **Metrics, implemented in `src/eval`:** P@K, R@K, F1@K, AP → MAP, NDCG@K (graded),
   latency p50/p95 per mode, indexing throughput (docs/s), index size (disk + RSS),
   crawler throughput (pages/min), vocabulary growth.
5. **Runner:** `for mode × params × query → ranked list + latency → metrics vs qrels →
   run JSON {config, git_sha, corpus_hash, metrics, latency}` under `runs/`
   (experiment runs) and `benchmarks/results/` (benchmarks).
6. **Rules:** configs + qrels committed; corpora gitignored with manifest; every reported
   number carries its config hash; a re-runnable mini-benchmark exists.
   **No number in the report that the system did not produce.**

---

## 10. UI architecture (Windows 7 Aero)

Desktop-like search environment: *alternate-universe Windows 7 search application* — not a
parody, not a modern SaaS glass clone.

- **Tokens** (`web/src/styles/tokens.css`): Aero glass ramp, 1px inner light border + outer
  shadow, glossy top highlight, `"Segoe UI"` stack, 11–13 px type, radii 3–4 px.
- **Shell:** `Desktop` (wallpaper gradient) → `WindowFrame` (glossy title bar, functional
  min/max/close, Aero border) → `Taskbar` (start orb, app buttons, clock).
- **Main window:** glossy search input + glass button; header shows `N results · 38ms · Mode D`;
  results show title, URL, highlighted snippet, relevance bar, `[Why this result?]` →
  **Ranking Details** table (BM25 7.82 / Phrase +1.20 / PageRank 0.64 / Final 9.66).
- **Settings window:** mode A–E, k, fuzzy toggle, weight sliders → writes mode overrides.
- **Tech:** React + Vite; glass via `backdrop-filter: blur(≤16px) saturate(1.3)` + gradient
  overlays. Performance guardrails: no animated blur, no full-page blur. Inline SVG icons.
  Motion 100–150 ms. Desktop-first; windows collapse on narrow viewports.
- **State:** query/mode/k in the URL (shareable, matches eval configs).
- **Usability non-negotiables:** `/` focuses search, Enter submits, contrast tested against
  glass, pagination, latency/mode always visible.

---

## 11. Optional future AI/RAG layer

The seam already exists: `ScoredDoc[]` with snippets + explanations is what a RAG layer consumes.

```
query → our search engine (works with no API key)
      → top-K {docId, title, url, snippet, score}
      → [optional] semantic signal: offline embeddings → ANN store →
        fused as ONE MORE RankingSignal (reuses §6 machinery, zero redesign)
      → LLM (separate service, key in .env) → grounded answer + citations
```

Rules: AI lives in a separate package depending on `core`, never the reverse; no AI code runs
unless enabled; retrieval quality is still measured by our eval harness.

---

## 12. Repository layout

```
src/core      pure IR: tokenizer, stemmer, index, ranking, query, snippet, link (pagerank)
src/crawler   frontier, fetch, extract, robots, politeness (pure, deps injected)
src/storage   postgres adapters + repository interfaces, index persistence (segments)
src/api       fastify routes + schemas
src/eval      metrics, runner, report generation
web/          React + Aero UI
migrations/   numbered forward-only SQL (001_init.sql)
tests/        vitest unit + integration (fixture server, in-memory store, PG E2E)
benchmarks/   configs + results (JSON/CSV — committed evidence)
runs/         experiment run artifacts (JSON — committed evidence)
configs/      mode-a…mode-e.json, parameter grids, crawl.json
data/         corpora/, index/, eval inputs (gitignored except manifests + eval inputs)
scripts/      crawl, db-migrate, build-crawl-index, corpus import, reports, lib/
docs/         ARCHITECTURE · DECISIONS · DEVELOPMENT · (INDEXING, SEARCH, RANKING,
              EVALUATION, EXPERIMENTS — M2; CRAWLER, DATABASE — M3; API, VIVA later)
```
