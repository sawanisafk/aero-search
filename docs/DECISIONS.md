# Architectural Decision Records

Decision log for the project. Each record: **context → problem → alternatives → decision →
consequences**. These answer "why" questions (viva, code review, report §Technology Selection);
[ARCHITECTURE.md](ARCHITECTURE.md) answers "how".

**When to add an ADR:** any decision that would be expensive to reverse, that a panel member is
likely to ask about, or that rejects a plausible alternative.

---

## ADR-001: TypeScript as the implementation language

**Context.** The whole system (crawler, index, ranking, API, eval scripts) needs one language;
the UI is React/TS anyway.

**Problem.** The core is data-structure- and math-heavy; runtime memory behavior matters.

**Alternatives.**
- *Python* — fastest research iteration, but weakest runtime performance for the index and a
  second language for the API/UI glue.
- *Java* — good IR-course pedigree and predictable memory; slower delivery for a solo project,
  heavier project scaffolding.
- *Rust/C++* — best memory control; unacceptable delivery risk on a final-year timeline.

**Decision.** TypeScript on Node.js, with strict mode and `noUncheckedIndexedAccess`.

**Consequences.** One language across all layers, strong typing for index/score plumbing,
excellent async I/O for crawling. Costs: V8 heap ceiling (~1.5–4 GB) and no easy `mmap` —
mitigated by typed-array index representations (ADR-008) and segment files. If a future scale
target exceeds ~250K docs in memory, the runtime choice must be revisited (documented, not hidden).

---

## ADR-002: Custom inverted index — no external search engine

**Context.** Off-the-shelf engines (Elasticsearch, OpenSearch, Solr, Algolia, Typesense,
Postgres FTS) could produce a working search box quickly.

**Problem.** The project's academic contribution *is* the indexing and ranking implementation.
Using a search engine would reduce the work to configuration and make core panel questions
unanswerable.

**Alternatives.**
- *Elasticsearch et al.* — production features for free; zero learning value here; heavy
  operational footprint.
- *Postgres `tsvector`/`ts_rank`* — simple, but ranking math disappears into SQL.
- *Full scan over documents* — no data structure, no scalability story, O(Σ|d|) per query.

**Decision.** Implement term dictionary, posting lists, positions, and all statistics ourselves.
Off-the-shelf engines are permitted only as an *optional evaluation baseline*, never as a dependency.

**Consequences.** All core algorithms are ours to explain, test, and benchmark. We accept
responsibility for performance engineering and correctness (mitigated by unit tests and the
evaluation harness).

---

## ADR-003: PostgreSQL for metadata and state — not as the search engine

**Context.** Two kinds of data: mutable relational state (crawl frontier, documents, link graph,
qrels, experiment results) and the read-heavy search index.

**Problem.** Where does each live? Putting postings in Postgres risks making it the ranking
engine (ADR-002 violation) and puts a database round-trip in the query hot path.

**Alternatives.**
- *Postgres for everything* — single store; but per-posting rows destroy latency and hide the work.
- *SQLite only* — legitimate for a solo project (zero ops, embedded); loses concurrent writers
  (crawler + API) and the future `pgvector` path for the optional semantic layer.
- *Files only for state* — no concurrent updates, no queries over experiments.

**Decision.** PostgreSQL stores **system-of-record data** (documents, crawl state, link edges,
pagerank values, qrels, runs/metrics). The **query path reads only the in-memory index**;
document bodies are fetched from PG for top-K snippet generation only.

**Consequences.** Clear consistency story (index = derived, rebuildable artifact; PG = truth),
query latency independent of the database, experiments queryable with SQL. Cost: one offline
rebuild step after ingestion and a running Postgres (Docker Compose provided).

---

## ADR-004: BM25 as the primary lexical ranking function

**Context.** Need a default lexical ranker to compare everything else against.

**Problem.** Basic TF-IDF lacks term-frequency saturation and document-length normalization.

**Alternatives.**
- *TF-IDF* — simple, explainable baseline; retained as **Mode A** for comparison, not as default.
- *BM25F / BM25+ / DFR / language models* — refinements; BM25 subsumes the needed ideas with the
  least machinery and is the literature-standard comparator.
- *Learning-to-rank* — needs training data and hides the fundamentals; out of scope.

**Decision.** Implement BM25 from first principles with exposed `k1` (default 1.2) and
`b` (default 0.75); keep TF-IDF as a comparison mode; sweep parameters during evaluation.

**Consequences.** Defensible default with known behavior (saturation, length normalization);
parameter sensitivity becomes an experiment rather than a guess. Every BM25 claim in the report
must trace to a committed run artifact.

---

## ADR-005: PageRank as a bounded secondary signal, fused after normalization

**Context.** The crawler records hyperlinks; we want an authority signal.

**Problem.** High PageRank must not override topical relevance; scores live on incompatible scales
(BM25 ~0–40 vs PageRank ~0–0.02).

**Alternatives.**
- *Multiply PageRank into BM25* — opaque, makes high-PR pages unbeatable.
- *Use PageRank as primary ranker* — ignores the query entirely.
- *Skip PageRank* — loses the graph-analysis component of the project.

**Decision.** Compute PageRank offline by power iteration (d = 0.85, convergence 1e-6, dangling
handling). Fuse as one normalized signal with a **small measured weight**; evaluation includes a
guard: an irrelevant high-PR page must not outrank a strongly relevant low-PR page. RRF fusion
(ADR-009) is an additional weight-free option.

**Consequences.** Graph analysis stays in the project; lexical relevance stays in charge.
Risk: on a small sparse-link corpus the signal may be weak — if measurements show that, we
report the null result honestly (the corpus is chosen to have real link structure).

---

## ADR-006: Controlled corpus first — bundled static documents, then a small allowlisted crawl

**Context.** Ranking research needs documents; the crawler needs time to build.

**Problem.** If ranking waits for the crawler, the critical path lengthens and evaluation is
blocked. An uncontrolled crawl is neither legal nor reproducible.

**Alternatives.**
- *Crawl-only corpus* — single clean story; blocks M2 ranking work.
- *Public test collection only* — strongest evaluation tradition; extra adaptation work and may
  not exercise our crawler/PageRank.

**Decision.** Two-stage corpus: (1) **bundled static document set** (local HTML files, committed
manifest) to develop and evaluate retrieval/ranking from M2; (2) **small controlled crawl** over
a committed seed list + domain allowlist with real link structure, for the full system, PageRank,
and the demo. Corpus provenance (source, date, method, licensing) documented in `data/`.

**Consequences.** Ranking research is never blocked; crawler risk is isolated; PageRank gets a
corpus with actual links. Cost: results must state which corpus each experiment used.

---

## ADR-007: Undici-only HTTP crawling; Playwright deferred

**Context.** Proposed stack listed both Playwright and Undici.

**Problem.** Two fetching stacks double failure modes; Playwright costs ~300 MB of browser
binaries and 100–500 ms/page for pages our controlled corpus does not need.

**Alternatives.**
- *Playwright for everything* — handles SPAs; slow, memory-heavy, brittle at crawl scale.
- *Undici + Cheerio* — fast, light, sufficient for server-rendered HTML.
- *curl/wget wrappers* — poor programmatic control over politeness/redirects.

**Decision.** `HttpFetcher` (Undici) is the only fetcher in v1, behind a `Fetcher` interface.
`BrowserFetcher` (Playwright) may be added later **only if** the target corpus is JS-rendered.

**Consequences.** Simpler crawler, faster benchmarks, one set of HTTP failure semantics.
Documented limitation: no JavaScript-executed content (stated in report limitations).

---

## ADR-008: Typed-array index representation with file-backed segment persistence

**Context.** Node/V8 object overhead makes naive posting lists a memory problem:
~30M posting objects ≈ ≥2.5 GB vs ≈ 200–400 MB as packed typed arrays at 100K docs.

**Problem.** Represent postings/positions memory-efficiently, survive restarts, and keep the
"index construction time" experiment meaningful.

**Alternatives.**
- *Object-per-posting maps* — simplest; OOM above ~50K docs.
- *Postgres rows* — ADR-003 violation.
- *mmap* — no clean Node API; native-addon complexity.
- *Pure in-memory, no persistence* — every restart rebuilds; no cold-start story.

**Decision.** Dictionary of integer termIds; postings as delta-encoded `Uint32Array` docIds +
`Uint16Array` tfs; positions as per-doc delta-encoded runs; `docLen` in a flat array.
Built in memory, serialized to versioned segment files (binary + JSON debug form), loaded at
API boot. Bodies remain in PostgreSQL.

**Consequences.** ~5–10× memory reduction versus objects; predictable load path; persistence
enables construction-time and index-size metrics. Cost: serialization code and versioning
discipline (segment header carries format version + corpus hash). Lazy loading/skip pointers
remain a documented, benchmark-driven future step.

---

## ADR-009: Config-driven ranking modes with normalized fusion + RRF baseline

**Context.** Modes A–E must be comparable and weights must not be arbitrary hard-coded constants.

**Problem.** Signals have incompatible scales; any fixed weighting is indefensible without
measurement; evaluation must reproduce exactly what the UI serves.

**Alternatives.**
- *Hard-coded weights in code* — unexplainable, unreproducible.
- *Per-query min-max only* — sensitive to outliers; needs a guard.
- *Rank-based fusion (RRF) only* — weight-free, but hides score magnitudes from the explain UI.

**Decision.** Signals implement a `RankingSignal` interface; modes are **JSON configs in
`configs/`** consumed by both API and eval runner. Fusion supports (a) weighted linear over
normalized scores with weights swept in evaluation, and (b) RRF (k = 60) as a weight-free
baseline arm. Every ScoredDoc carries its per-signal breakdown.

**Consequences.** "How did you choose the weights?" has a real answer (sweep + report, or RRF);
the eval runner and the UI can never disagree about what a mode means. Cost: normalization
must be implemented and tested carefully (documented in RANKING docs).

---

## ADR-010: Evaluation by pooled graded qrels, metrics implemented in-repo

**Context.** Claims like "BM25 improved NDCG@10 by X%" require ground truth.

**Problem.** Judging is expensive; biased pooling invalidates comparisons; borrowed metric
libraries hide the definitions from the defense.

**Alternatives.**
- *No evaluation, subjective demo* — not a research project.
- *Binary judgments only* — simpler; weakens NDCG (its advantage is graded relevance).
- *External metric library* — fast, but we cannot explain the formulas line by line.

**Decision.** Graded qrels (0–3) over ~30–50 queries, built by **pooling the merged top-10/20
of all ranking modes plus a random baseline**; P@K, R@K, F1, MAP, NDCG@K and latency
percentiles implemented in `src/eval`; every run persisted with config hash, git SHA, corpus
hash under `benchmarks/results/`.

**Consequences.** Comparisons are defensible and reproducible; metric math is ours to explain.
Cost: manual judgment effort (bounded by query count and pool depth) and residual pooling bias —
acknowledged in report limitations.

---

## ADR-011: Embedded PostgreSQL as the development/test runtime — compose stays the contract

**Context.** M0 provided `docker-compose.yml` (PostgreSQL 16, user `aero`, db `aero_search`)
as the metadata store. At ADR time the development machine had no Docker and no admin
rights for a system-wide install — and regardless, tests must never *require* Docker.

**Problem.** M3 needs a real PostgreSQL (crawl state, documents, link graph) that tests can
exercise hermetically. Fake/embedded SQL engines (pg-mem) do not run real PostgreSQL, so
compatibility claims would be hollow.

**Alternatives.**
- *pg-mem (SQL emulator)* — zero install, but not PostgreSQL; divergent semantics; weak evidence.
- *PGlite (WASM Postgres)* — real engine, but PG17 (docs claim 16) and single-connection
  semantics that fight the `pg.Pool` code path we ship.
- *Require Docker/system PG* — correct contract, but blocks development and tests here.
- *embedded-postgres (real PostgreSQL 16 binaries via npm)* — real server, real wire protocol,
  `pg.Pool` exactly as in production; data directory under `data/pg/` (gitignored).

**Decision.** `scripts/lib/embedded-pg.ts: startDatabase()` prefers a reachable `DATABASE_URL`
(docker-compose or system install, unchanged) and otherwise boots **embedded PostgreSQL 16.14**
on `localhost:5432` with the compose credentials — drop-in interchangeable. Tests use a fresh
cluster under `data/pgtest/` (port 5433). Clusters are initialised `--encoding=UTF8
--locale=C` for byte-deterministic ordering across machines. Docker Compose remains the
documented deployment path.

**Consequences.** No Docker/admin requirement; tests run a real PostgreSQL in ~12 s; the
`DATABASE_URL` contract is untouched. Cost: an extra dev dependency with native binaries
(~50 MB) and a second runtime path to document. The cluster is not a service — long-running
state (the crawl) keeps a process open or restarts via resume (`loadPending`).

---

## Change log

| ADR | Status | Date |
|---|---|---|
| 001–010 | Accepted | 2026-10-07 |
| 011 | Accepted | 2026-10-07 |
