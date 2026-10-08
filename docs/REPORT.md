# Project Report — Aero Search (custom IR engine)

**State:** M0–M5 complete (M4 A/B/C + M5 API/UI), 312 root tests + 15 web tests green,
worktree clean (commit list for M5: see `docs/M5_FINAL_VERIFICATION.md`).
**Purpose:** the single reference document for demonstration & preparation — status,
architecture, live demos, experimental results, math, and evidence index.
**Rule this report follows:** every number below is read from a committed artifact
(`runs/`, `benchmarks/results/`, `data/eval/`) with a recorded git SHA — nothing is
recomputed by hand.

---

## 1. Checkpoint verification (run this first)

```powershell
git status                    # expect: clean
git log --oneline --decorate -16
git tag -l                    # m2-complete, m3-complete, m4-complete
npm run typecheck             # expect: no output = green (root + web)
npm test                      # expect: 312 passed (312) · 22 files
npm run web:test              # expect: 15 passed (15)
```

**Verified baseline: 312 + 15 tests, 0 failures, typecheck green.**
(Screenshot this — it is evidence in itself.)

Freeze the checkpoint (already tagged this session):

```bash
git tag -a m4-complete -m "M4 complete: PageRank, hybrid ranking, and fuzzy retrieval"
git push origin m2-complete m3-complete m4-complete
```

Milestone history (each tag = reproducible green state):

| Tag | Commit | State |
|---|---|---|
| `m2-complete` | `b23a551` | index + BM25 + eval harness, 149 tests |
| `m3-complete` | `d6d598c` | crawler + Postgres + link graph, 219 tests |
| `m4-complete` | `0e73bf8` | PageRank + fusion + fuzzy, **286 tests** |
| *(untagged)* | `9e95a45`…`61f2b75` + docs | M5 API/UI/demo/Docker, **312 + 15 tests** — commits in `M5_FINAL_VERIFICATION.md` |

---

## 2. What was built, per milestone

| Milestone | Deliverable | Key commits |
|---|---|---|
| **M0–M1** | toolchain, tokenizer/Porter/stopwords, inverted+positional index (typed arrays, segments), persisted format frozen (ADR-001) | scaffold → tag lineage before `m2-complete` |
| **M2** | query parser (AND/OR/NOT, phrases, both implicit modes), Boolean candidates, TF-IDF/BM25/phrase/proximity ranking, metrics (P/R/F1/MAP/NDCG), experiment runner, SciFact baseline | → `m2-complete` |
| **M3** | politeness/robots/frontier crawler, PostgreSQL schema + migrations, link-graph export, crawled index (77 docs) | → `m3-complete` |
| **M4-A** | pure power-iteration PageRank (dangling-safe, converged), `pagerank_runs` persistence, `npm run pagerank:build` | `1fd7f42`, `465b56a`, `9e1d660`, evidence `8621d06`, docs `a9040f2` |
| **M4-B** | mode-D fusion `score=(1−w)·ŝ_BM25+w·ŝ_PR`, corpus-global normalization, real citation graph (2,015 edges), weight ablation | `68d68f4`, `daae9c0`, `05601f9`, evidence `fdae01d`, docs `209048f` |
| **M4-C** | bounded edit-distance fuzzy expansion (k=1 generation / k=2 dictionary scan), strict caps, separate typo benchmark | `b713150`, evidence `f6a32b0`, docs `0e73bf8` |
| **M5** | Fastify REST layer (6 endpoints, JSON-Schema validation, error envelope, 26 contract tests), React 19 Aero desktop UI (windows/taskbar, signal bars, diagnostics, 15 tests), `scripts/demo.ts` (14/14), `bench:api` evidence, Docker stack, M5 doc set | `9e95a45`, `0817baf`, `9933ed2`, evidence `fe71c91`, `61f2b75` |

Test growth: 38 → 149 → 219 → 239 → 257 → 286 (M4) → **312 root + 15 web** (M5).

---

## 3. Architecture (diagram 1 — the system)

```
                    ┌───────────────┐
                    │   Web Corpus  │
                    └───────┬───────┘
                            ↓
                    ┌───────────────┐
                    │    Crawler    │   Undici + Cheerio, robots.txt,
                    │  (frontier,   │   politeness, bounded budget,
                    │   politeness) │   resumable state
                    └───────┬───────┘
                            ↓
                    ┌───────────────┐
                    │ PostgreSQL 16 │   system of record (documents, URLs,
                    │               │   links, crawl state, pagerank_runs)
                    └───────┬───────┘        NEVER in query hot path (ADR-003)
                            ↓
                    ┌───────────────┐
                    │ Text Analysis │   NFKC → tokenize → stop words →
                    │ (shared path) │   own Porter stemmer (23,531 vectors)
                    └───────┬───────┘   index-time = query-time (ADR-009)
                            ↓
                    ┌───────────────┐
                    │ Custom Index  │   term dictionary (hash) + delta-coded
                    │ inverted +    │   postings + positional runs,
                    │ positional    │   typed arrays, segment file (.aidx)
                    └───────┬───────┘
                            ↓
                         QUERY
                            ↓
                ┌─────────────────────┐
                │ Retrieval + Ranking │
                │ parse → analyze →   │
                │ fuzzy (absent       │
                │ terms, opt-in) →    │
                │ Boolean candidates  │
                │ → TF-IDF / BM25 /   │
                │ phrase / proximity  │
                │ → fusion (+PageRank)│
                └──────────┬──────────┘
                           ↓
                       REST API        ← M5 (src/api/)
                            ↓
                  React / Aero UI      ← M5 (web/)
```

Three planes (details `docs/ARCHITECTURE.md`): **Offline** (crawl → index → PageRank →
Postgres) · **Online** (query → retrieve → rank → explain) · **Evaluation** (qrels ×
strategies → metrics → committed artifacts).

---

## 4. Query journey (diagram 2 — "what happens when I search?")

```
"information retrieval"
        ↓   parseQuery(text, {implicitOperator:'or' | 'and'})
   AST: OR(term, term)                    — typed errors, quotes = phrase
        ↓   analyzeQuery(ast, reader.analysis)
   inform / retriev                       — same analyzer as indexing (ADR-009)
        ↓   expandFuzzyQuery(...)         — only if enabled AND term is absent
   [inform, retriev] ± variants           — bounded edit distance, strict caps
        ↓   retrieveAnalyzed → set algebra over sorted Uint32 docIds
   AND=intersect · OR=union · NOT=universe\operand · phrase=positional match
        ↓   strategy.rank(reader, analyzed, candidates)
   BM25 per term: tf · idf · length norm   — k1=1.2, b=0.75
   + phrase bonus / proximity window       — mode C
   + (1−w)·ŝ_BM25 + w·ŝ_pagerank          — mode D (PageRank precomputed)
        ↓   sort: score desc, docId asc → top-K → map docId → corpus id
   ranked results (+ per-signal breakdown for explain)
```

Hand-traceable example (works in the demo): `seach`
→ analyzed `seach` ∉ dictionary → ∅ candidates (silent failure, baseline)
→ fuzzy expands to `[seach, search, …]` → union leaf → doc set of `search`
→ BM25 scores those docs with `search`'s real idf → ranked results.

---

## 5. Demonstrations you can run TODAY (terminal as control panel)

Discover commands first — never guess: `npm run`.

### Demo A — the engine end-to-end (retrieval + ranking)

```powershell
npm run corpus:scifact                 # md5-verified BEIR SciFact (once)
npm run index:build -- --corpus scifact
npm run eval:run -- --corpus scifact --strategy bm25
Get-ChildItem runs                     # committed + fresh artifacts
Get-Content .\runs\<latest>-scifact-bm25*.json
```

Expected inside the artifact: `strategy: bm25-k1.2-b0.75`, 300 judged queries,
**MAP 0.6436 · NDCG@10 0.6876 · P@10 0.0913 · R@100 0.9276**, latency ~1 ms avg.
Do not retype the number — show it *in the artifact* (it carries corpus hash + git SHA).

### Demo B — evaluation (the academic core)

```powershell
npm run eval:run -- --corpus scifact --strategy boolean
npm run eval:run -- --corpus scifact --strategy tfidf
npm run eval:run -- --corpus scifact --strategy bm25
```

The comparison table (§6.1) appears from three artifacts on the *same* corpus,
queries, and judgments — only the strategy changes.

### Demo C — the crawler

```powershell
Get-Content .\data\eval\crawled.manifest.json   # frozen crawl evidence
Get-ChildItem data -Recurse
```

Show: 100-page budget → 78 docs / 77 indexable · **796 link edges** · vocab 4,151 ·
0.27 MB index · corpus hash `4e5bf3b0…` · 22 failures recorded as data (resumable).
(`npm run crawl` only if you intentionally want to crawl again — not needed today.)

### Demo D — fuzzy (the "wow" demo)

```powershell
npm run bench:fuzzy                    # the typo experiment → benchmarks/results/
npm run eval:run -- --corpus scifact --strategy bm25 --fuzzy   # clean-query arm
```

Narrate with real numbers (all committed, §6.4): one wrong character costs
−0.0771 MAP; distance-1 expansion recovers **93.5%** of the loss; distance-2
recovers less and is noisier — the negative result is part of the story.

Also useful: `npm run pagerank:build` (M4-A over the crawl graph, persisted to PG),
`npm run bench:query -- --corpus scifact --queries data/eval/scifact-queries.jsonl`
(all latency stages incl. `bm25-pr`, `bm25-fuzzy`).

---

## 6. Experimental results (all from committed artifacts)

### 6.1 Strategy comparison — M2 baseline (SciFact, 300 judged queries)

| Strategy | MAP | Notes |
|---|---:|---|
| Boolean | 0.0049 | order = docId; proves ordering carries the signal |
| TF-IDF | 0.4421 | first real ranking |
| **BM25** (k1 1.2, b 0.75) | **0.6436** | NDCG@10 0.6876 · P@10 0.0913 · R@100 0.9276 |
| BM25 + phrase/proximity (mode C) | 0.6440 | proximity ≈ neutral on this corpus (ablation `--proximity-k 0`) |

Evidence: `runs/2026-10-07T14-52-*-scifact-*.json` (git `7d9ef4c` clean).
Talking point: *"Same corpus, same queries, same judgments — only the ranking
strategy changed. Every number is a committed artifact with its config hash."*

### 6.2 M4-A — PageRank over the real crawl graph

| Quantity | Value |
|---|---|
| Graph | 77 nodes · 209 unique in-set edges · 16 dangling (796 raw → 482 dropped) |
| Parameters | d = 0.85, tol = 1e-6, uniform start |
| Convergence | **52 iterations, residual 8.591e-7**, 1.9 ms, Σπ = 1.0000000000000002 |
| Top authority | `TheProject.html` (0.1088) |
| Persistence | `pagerank_runs` run_id 1 (params + convergence + graphHash + gitSha) |

Evidence: `benchmarks/results/2026-10-08T02-29-21-953Z-pagerank.json` (git clean).

### 6.3 M4-B — hybrid fusion: BM25 + citation-graph PageRank (mode D)

Signal: Semantic Scholar references → **4,879/5,183 papers resolved, 100,979
references → 2,015 in-corpus edges** (955 citing), graphHash `3d7b80d2…`;
PageRank converged 41 iters / 8.64e-7. Fusion: `score=(1−w)·ŝ_BM25+w·ŝ_PR`,
BM25 normalized per query over candidates, PageRank once over the corpus.

| Strategy | w | MAP | NDCG@10 | R@100 | run avg ms |
|---|---:|---:|---:|---:|---:|
| `bm25` baseline | — | 0.6436 | 0.6876 | 0.9276 | 1.042 |
| `bm25-pr-w0.01` | 0.01 | 0.6436 | 0.6876 | 0.9276 | 1.471 |
| `bm25-pr-w0.02` | 0.02 | 0.6434 | 0.6874 | 0.9276 | 1.435 |
| **`bm25-pr-w0.05`** | 0.05 | **0.6451** | **0.6886** | 0.9276 | 1.478 |
| `bm25-pr-w0.1` | 0.10 | 0.6440 | 0.6878 | 0.9309 | 1.456 |
| `bm25-pr-w0.2` | 0.20 | 0.6438 | 0.6866 | 0.9309 | 1.521 |
| `bm25-pr-w0.3` | 0.30 | 0.6413 | 0.6839 | 0.9316 | 1.443 |
| `bm25-pr-w0.5` | 0.50 | 0.5163 | 0.5788 | 0.9242 | 1.478 |

**Academic answer:** link authority helps *slightly* (best +0.0015 MAP at
w = 0.05), dose-response flat to ~0.2 then collapses at 0.5 — a marginal
tie-breaker, reported as measured. Documented negative results: per-candidate
PageRank normalization and a p95 outlier guard each destroyed MAP (0.64 → 0.12)
— mechanism in `docs/EXPERIMENTS.md` §3 and `src/core/ranking/fusion.ts`.
Latency: bm25 1.008 → bm25-pr 1.136 ms avg (+13%), PageRank computed outside
the timed loop.

Evidence: `runs/2026-10-08T03-26-*` (8 files, git `05601f9` clean) +
`benchmarks/results/2026-10-08T03-26-43-094Z-query-benchmark.json`.

### 6.4 M4-C — fuzzy typo recovery (separate deterministic benchmark)

Protocol: every judged query gets **one deterministic single-character
substitution** (first eligible word, position last→first, letter a→z, accepted
only if the corrupted form is a dictionary miss at edit distance exactly 1).
**300/300 corruptible, 0 skipped**; all arms run the identical judged subset
through the full e2e pipeline (strategy `bm25`).

| Arm | query text | fuzzy | MAP | NDCG@10 | R@100 | avg ms |
|---|---|---|---:|---:|---:|---:|
| clean | original | off | 0.6436 | 0.6876 | 0.9276 | 1.005 |
| typo-exact | corrupted | off | 0.5665 | 0.6101 | 0.9040 | 0.890 |
| **typo-fuzzy k=1** | corrupted | on (default) | **0.6386** | 0.6819 | 0.9309 | 1.136 |
| typo-fuzzy k=2 | corrupted | on (maxEdits 2) | 0.6157 | 0.6624 | **0.9342** | 4.340 |

Findings to state out loud:

1. A single typo costs **−0.0771 MAP**; k=1 expansion recovers
   **0.0722 / 0.0772 = 93.5%** of the gap (NDCG@10: 92.8%), landing within
   0.005 MAP of clean — and R@100 slightly *exceeds* clean (union adds recall).
2. **k=2 is a measured negative result:** more recall (R@100 0.9342, highest)
   but MAP 0.6157 — distance-2 noise outweighs extra recovery, at ~4× latency.
   k=1 is the correct default; the negative stays in the report — it makes the
   evaluation look scientific, not promotional.
3. Clean-query cost, measured honestly: fuzzy over *uncorrupted* queries
   expands 72 genuine OOV terms (30/300 queries, 157 variants) → MAP 0.6436 →
   0.6353. Expansion pays when the miss is a typo; costs a little when it is real.
4. Engineering story: the first k=2 implementation (edit1×edit1 composition)
   was quadratic and measured **max 1,554 ms** in the bench — replaced by a
   bounded dictionary scan (length ±2 + early-exit DP) → **max 7.77 ms**,
   complete results, no truncation.

Evidence: `benchmarks/results/2026-10-08T03-59-11-510Z-fuzzy-benchmark.json` (k=1),
`…03-59-23-203Z-…` (k=2), `…03-59-43-121Z-query-benchmark.json` (stages),
`runs/2026-10-08T03-59-45-029Z-scifact-bm25-k1.2-b0.75-fuzzy.json` (clean arm) —
all git `b713150` clean.

### 6.5 Query latency (e2e per query, 1,109 SciFact queries)

| Stage | avg ms | median | p95 | max |
|---|---:|---:|---:|---:|
| candidates (parse+analyze+retrieve) | 0.211 | 0.176 | 0.457 | 2.678 |
| boolean | 0.307 | 0.261 | 0.692 | 1.494 |
| tfidf | 0.718 | 0.677 | 1.335 | 2.630 |
| bm25 | 0.887 | 0.856 | 1.614 | 2.616 |
| bm25-phrase | 0.929 | 0.903 | 1.650 | 2.477 |
| bm25-phrase-proximity | 2.514 | 1.448 | 7.698 | 42.077 |
| bm25-fuzzy | 0.868 | 0.845 | 1.525 | 2.966 |
| bm25-fuzzy2 | 1.232 | 0.906 | 3.894 | 7.773 |
| bm25-pr (fusion) | 1.111 | 1.088 | 1.955 | 4.075 |

Evidence: `benchmarks/results/2026-10-08T03-59-43-121Z-query-benchmark.json`
(git `b713150` clean). Talking point: *sub-millisecond median for full e2e
BM25; every added signal is measured, never assumed.*

---

## 7. The math (four things to be able to explain)

### BM25 (defaults k1 = 1.2, b = 0.75)

```
score(q, d) = Σ   IDF(t) · tf·(k1 + 1) ──────────────────────
              t∈q        └── tf + k1·(1 − b + b · |d|/avgdl) ──┘

IDF(t) = ln( 1 + (N − df + 0.5) / (df + 0.5) )
```

- **tf** — term frequency in the doc; **IDF** — rarity across the corpus.
- The denominator is **length normalization**: |d|/avgdl > 1 penalizes long
  docs; `b` controls how much, `k1` controls tf saturation (a 2nd occurrence
  helps far less than the 1st).
- Implemented in `src/core/ranking` (`bm25Idf`, `bm25TermScore`), hand-tested
  in `tests/ranking.test.ts` with a 4-doc closed-form fixture.

### MAP (and NDCG@10)

```
AP(q)  = (1 / |relevant|) · Σ  P@k · rel(k)     — precision at each hit, averaged
MAP    = mean of AP over all queries
NDCG@k = DCG@k / IDCG@k ,  DCG = Σ (2^rel − 1) / log2(rank + 1)
```

SciFact gives 1 judged query set (300 queries, graded qrels) — MAP is the
primary number; NDCG@10 cares about the top of the list.

### PageRank (power iteration, d = 0.85, tol 1e-6)

```
π ← (1 − d)/N + d · ( Aᵀπ + danglingMass/N )
```

- A = adjacency of the link graph; dangling mass (outdegree 0) redistributed
  uniformly; teleport handles disconnected components.
- Converges when ‖π_new − π_old‖ < tol — reported honestly (`converged`,
  `residual`, iteration count in every artifact).
- It is an **offline, query-independent** signal: computed once per run,
  never in the query loop (ADR-003 spirit), then min-max normalized over the
  whole corpus before fusion.

### Fuzzy (bounded Levenshtein)

```
lev(i, j) = min( lev(i−1, j) + 1,        // deletion
                 lev(i, j−1) + 1,        // insertion
                 lev(i−1, j−1) + cost )  // substitution (cost 0 if same char)
```

- `boundedEditDistance(a, b, k)` returns the true distance when ≤ k, else the
  sentinel k+1 — row-minimum early exit is what keeps it cheap.
- k=1 recovery = generate ~27·len variants (delete/substitute/insert over a-z)
  → O(1) hash probes against the dictionary. k=2 = bounded dictionary scan
  (length ±2 filter first). Strict caps: maxEdits, min length 3, 10
  variants/term, 10 absent terms/query, 20 variants/query.

Proximity (mode C, scoring only): `score = k / (1 + (window − |q|))` over the
smallest position window containing all query terms.

---

## 8. Evidence index (where every number lives)

| Claim | Artifact | Git |
|---|---|---|
| M2 baseline & strategy comparison | `runs/2026-10-07T14-52-*-scifact-*.json` (6) | `7d9ef4c` clean |
| M2/M3 latency benches | `benchmarks/results/2026-10-07T14-53-*.json`, `…17-12-21-990Z-*` | clean |
| M3 crawl corpus | `data/eval/crawled.manifest.json` + `crawled.graph.json` + `crawled.aidx` | `m3-complete` |
| M4-A PageRank run | `benchmarks/results/2026-10-08T02-29-21-953Z-pagerank.json` | clean |
| M4-B citation graph | `data/eval/scifact-citations.json` | `daae9c0` |
| M4-B fusion ablation (8 runs) | `runs/2026-10-08T03-26-*` | `05601f9` clean |
| M4-B latency | `benchmarks/results/2026-10-08T03-26-43-094Z-query-benchmark.json` | `05601f9` clean |
| M4-C typo bench k=1 / k=2 | `benchmarks/results/2026-10-08T03-59-11-510Z-…`, `…23-203Z-…` | `b713150` clean |
| M4-C latency stages | `benchmarks/results/2026-10-08T03-59-43-121Z-query-benchmark.json` | `b713150` clean |
| M4-C clean-query fuzzy arm | `runs/2026-10-08T03-59-45-029Z-scifact-bm25-k1.2-b0.75-fuzzy.json` | `b713150` clean |

Every artifact embeds `{config, git {sha, clean}, corpus {name, hash}, timestamp}`
plus strategy params — the evidence rule the whole project follows.

---

## 9. Design decisions worth defending (ADR highlights)

| Decision | Why |
|---|---|
| **Own index, no Elasticsearch/Solr** (ADR-001, format frozen at M1) | the project's premise: first-principles IR; frozen format keeps every milestone comparable |
| **Postgres never in the query hot path** (ADR-003) | system of record offline; queries hit the in-memory typed-array index (~1 ms) |
| **Index-time = query-time analysis** (ADR-009) | one analyzer (`normalize → tokenize → stopwords → Porter`) prevents silent mismatches |
| **Embedded PG fallback** (ADR-011) | Windows machine, no Docker/admin — tests spin ephemeral clusters on 5433/5434 |
| **Normalization scopes in fusion** | BM25 per query, PageRank per corpus — the two measured failure modes are documented, not hidden |
| **Null/negative results published** | k=2 fuzzy, w=0.5 fusion, proximity ≈ neutral — honesty is the methodology |
| **Evidence rule** | no number is quoted unless it comes from a committed artifact with git SHA |

---

## 10. One-page project explanation (the spoken version)

> **Problem.** Retrieve and rank relevant documents from a corpus using our own
> indexing and multiple relevance signals — and *prove* the ranking quality
> quantitatively, rather than asserting it.
>
> **What we built.** A complete retrieval pipeline in TypeScript with no
> off-the-shelf search engine: a crawler that produced a real 77-document
> corpus with 796 link edges; an inverted + positional index over typed
> arrays; the standard analysis chain including our own Porter stemmer
> (23,531 test vectors); Boolean retrieval with exact set semantics; TF-IDF,
> BM25, phrase and proximity ranking; query-time fuzzy expansion with bounded
> edit distance; PageRank over two real graphs (our crawl and a 2,015-edge
> citation graph); and weighted-linear score fusion. Evaluation runs every
> strategy through the same harness — P@K, R@K, F1, MAP, NDCG@K, latency —
> and writes self-describing artifacts with config hash, corpus hash and git SHA.
>
> **Headline results (SciFact, 300 judged queries, committed artifacts).**
> Boolean 0.0049 → TF-IDF 0.4421 → **BM25 0.6436 MAP**; adding citation
> PageRank at w = 0.05 reaches 0.6451 (+0.0015 — marginal, honestly reported);
> a single-character typo drops MAP to 0.5665 and distance-1 fuzzy expansion
> recovers **93.5%** of that loss, while distance-2 recovers less — an
> intentional negative result. Median e2e query latency is sub-millisecond.
>
> **Methodology.** Every claim traces to a committed artifact; every milestone
> ends with a green test suite (now 312 root + 15 web) and a reproducible checkpoint.

---

## 11. Terminal walkthrough — prompt-by-prompt demo guide

**How to read:** each step gives ► **TYPE** (exact command), ► **SEE** (what
appears), ► **SAY** (the narration line). Rehearse once end-to-end (~15 min).

**Ground rules for the terminal**

- Never dump a whole artifact with `Get-Content file.json` — they are
  thousands of lines. Always `ConvertFrom-Json` and select fields (examples below).
- Never guess a command: run `npm run` first and read the list.
- `Clear-Host` between stages so each demo gets a clean screen.
- Font size up; keep one PowerShell window for commands.
- Nothing here modifies committed files — runs only *add* timestamped artifacts.

### Stage 0 — Freeze & prove the checkpoint (~2 min)

► TYPE

```powershell
git status
git log --oneline --decorate -15
git tag -l
npm run typecheck
npm test
npm run web:test
```

► SEE: `nothing to commit, working tree clean` · history decorated with
`m2-complete`, `m3-complete`, `m4-complete` · typecheck runs with **no
errors** · **`Tests 312 passed (312)`** in ~10 s · **`Tests 15 passed (15)`**
for the web suite.

► SAY: *"This is a frozen, reproducible checkpoint — 312 plus 15 tests, zero
failures, clean worktree. Every milestone in the log ends in a green state, and
tags mark the ones we demonstrate from."*

Screenshot the `312 passed` block.

### Stage 1 — Show the command surface (~1 min)

► TYPE: `npm run`

► SEE: the script list — `eval:run`, `bench:query`, `bench:fuzzy`,
`corpus:scifact`, `crawl`, `index:crawl`, `pagerank:build`, `db:migrate`, …

► SAY: *"Every capability of the engine is one typed command — and none of
them wraps somebody else's search engine. Each command writes a
self-describing artifact with config hash, corpus hash and git SHA."*

### Stage 2 — Demo A: run the engine live (~3 min)

► TYPE

```powershell
npm run eval:run -- --corpus scifact --strategy bm25
```

► SEE (console):

```text
[experiment] scifact · bm25-k1.2-b0.75 (mode B)
  queries    300 evaluated, 1 parse failures
  MAP        0.6436
  @1         P 0.5533  R 0.5373  F1 0.5417  NDCG 0.5533
  @5         P 0.1613  R 0.7476  F1 0.2617  NDCG 0.6604
  @10        P 0.0913  R 0.8268  F1 0.1624  NDCG 0.6876
  @100       P 0.0105  R 0.9276  F1 0.0207  NDCG 0.7104
  latency    avg 1.076 ms · median 0.994 ms · p95 2.030 ms
  git        0e73bf86ad1a (clean)
  artifact   runs\2026-10-08T...-scifact-bm25-k1.2-b0.75.json
```

(MAP/NDCG/precision/recall reproduce **exactly** every run; only the latency
line moves by a few tenths of a millisecond. The `1 parse failures` line is
real — one SciFact query doesn't parse under implicit AND; it is counted and
reported, never silently dropped.)

► SAY: *"300 judged queries, full pipeline — parse, analyze, retrieve, BM25,
rank — in about a millisecond per query. MAP 0.6436 matches our committed
baseline exactly, because the system is deterministic."*

Now open the artifact **selectively**:

► TYPE

```powershell
$a = Get-Content (Get-ChildItem runs\*scifact-bm25-k1.2-b0.75.json | Sort-Object Name | Select-Object -Last 1).FullName -Raw | ConvertFrom-Json
$a.strategy | ConvertTo-Json        # id, mode, params: k1 1.2 / b 0.75
$a.metrics.map                      # 0.6436…
$a.metrics.ndcg.'10'                # 0.6876…
$a.metrics.recall.'100'             # 0.9276…
$a.latency_ms | ConvertTo-Json      # avg / median / p95 / max
$a.corpus | ConvertTo-Json          # name, hash, numDocs
$a.git  | ConvertTo-Json            # sha + clean flag
```

► SAY: *"This JSON is the evidence: strategy parameters, corpus hash, query
and qrels file hashes, latency distribution, git SHA. We never quote a number
that isn't in a committed artifact."*

### Stage 3 — Demo B: TF-IDF vs BM25 vs Boolean (~3 min)

Optionally run the two extra strategies live (`npm run eval:run -- --corpus
scifact --strategy boolean`, same for `tfidf`), then summarize **all** M2
artifacts in one table:

► TYPE

```powershell
Get-ChildItem runs\2026-10-07T14-52*.json | ForEach-Object {
  $j = Get-Content $_.FullName -Raw | ConvertFrom-Json
  [PSCustomObject]@{ strategy = $j.strategy.id; MAP = [Math]::Round($j.metrics.map, 4) }
} | Format-Table -AutoSize
```

► SEE (approximately):

```text
strategy                        MAP
--------------------- --------------
boolean                       0.0049
tfidf-raw                     0.4421
bm25-k1.2-b0.75               0.6436
bm25-phrase                   …
bm25-phrase-proximity         …      (×2 = one is the proximity ablation)
```

► SAY: *"Same corpus, same queries, same relevance judgments — we changed
only the ranking strategy. Boolean is essentially docId order and scores
~0.005; TF-IDF gets us to 0.44; BM25 with length normalization reaches
0.6436. The comparison is controlled, not curated."*

### Stage 4 — Demo D: fuzzy typo recovery (~5 min) — the "wow"

► TYPE: `npm run bench:fuzzy`

► SEE (console, ~2 s):

```text
[fuzzy-bench] scifact · 300/300 corruptible queries
  e.g. 1: "dimensional" -> "dimensionae" (dimension -> dimensiona)
  ...
  arm            MAP      NDCG@10  R@100    avg ms
  clean           0.6436   0.6876   0.9276    1.005
  typo_exact      0.5665   0.6101   0.9040    0.890
  typo_fuzzy      0.6386   0.6819   0.9309    1.136
  recovery       MAP 0.0722 of 0.0772 gap · NDCG@10 0.0718 of 0.0774 gap
```

(MAP/NDCG/R rows above reproduce **exactly** — verified twice; only the
`avg ms` column drifts ~10% per run. Each bench run appends a new
timestamped artifact in `benchmarks/results/` — untracked until committed.)

► SAY: *"We deterministically inject one wrong character into every query —
the corruption itself is listed in the artifact, no randomness. A single typo
costs 0.077 MAP. Bounded edit-distance expansion — distance 1 — gives back
93.5% of that loss, landing within 0.005 of the clean ceiling."*

Then the honest part:

► TYPE: `npm run bench:fuzzy -- --fuzzy-edits 2`

► SEE: `typo_fuzzy` MAP **0.6157** (worse than k=1), R@100 0.9342 (highest).

► SAY: *"Widening the radius to distance 2 finds more neighbors — recall
actually rises — but the noise outweighs it and MAP falls below distance 1.
We report the negative result: bounded means bounded for a reason."*

Show the actual injected typos:

► TYPE

```powershell
$f = Get-Content benchmarks\results\2026-10-08T03-59-11-510Z-fuzzy-benchmark.json -Raw | ConvertFrom-Json
$f.corrections | Select-Object -First 6 queryId, token, corrupted, originalTerm, corruptedTerm | Format-Table
```

And the clean-query side (expansion is a precision tradeoff):

► TYPE

```powershell
npm run eval:run -- --corpus scifact --strategy bm25 --fuzzy
```

► SEE: a line like `fuzzy  38/72 terms expanded · 157 variants · 30/300 queries`,
MAP 0.6353.

► SAY: *"On uncorrupted queries, the terms that miss the dictionary are
genuine out-of-vocabulary words, not typos — so expanding them costs a little
precision (0.6436 → 0.6353). We measured that too and keep it in the report."*

### Stage 5 — Demo C: the crawler's corpus (~2 min) — do NOT recrawl today

► TYPE

```powershell
$m = Get-Content data\eval\crawled.manifest.json -Raw | ConvertFrom-Json
$m.counts | ConvertTo-Json
$m.index  | ConvertTo-Json
```

► SEE: `documents 78, indexable 77, duplicates 1, failed 22, pending 62`;
`links: edgeCount 796, sourceCount 74, targetCount 422`;
`numDocs 77, vocabSize 4151, bytes 281075, corpusHash 4e5bf3b0…`.

► SAY: *"This manifest is the crawler's output as committed evidence: 100-page
budget, 77 indexable documents, 796 link edges, 22 failures recorded as data
and resumable — the crawl didn't have to succeed completely to be useful, it
had to be honest. The index was rebuilt from PostgreSQL, which stays the
source of truth."*

(A live crawl is `npm run crawl` — only if you actually want to crawl again.)

### Stage 6 — PageRank (~2 min)

► TYPE (no database needed — show the committed artifact):

```powershell
$p = Get-Content benchmarks\results\2026-10-08T02-29-21-953Z-pagerank.json -Raw | ConvertFrom-Json
$p.graph | ConvertTo-Json          # nodes 77, uniqueEdges 209, dangling 16, graphHash
$p.convergence.iterations          # 52
$p.convergence.residual            # 8.59e-7
$p.convergence.wallMs              # ~1.9
$p.scores.sum                      # 1
$p.scores.top | Select-Object -First 3 | Format-Table
```

Optionally live (uses PostgreSQL, embedded fallback per ADR-011):

```powershell
npm run db:migrate
npm run pagerank:build
```

► SAY: *"Power iteration over the crawled link graph — dangling pages and
disconnected components handled by teleport — converged in 52 iterations to
residual 8.6e-7, sums to 1, persisted with parameters and convergence trace.
The same engine later ran over a real 2,015-edge citation graph for the
fusion experiment."*

### Stage 7 — Latency bench (optional, ~20 s)

► TYPE: `npm run bench:query -- --corpus scifact --queries data/eval/scifact-queries.jsonl`

► SEE: `WARNING: 2 parse failures …` lines first (2 of the 1,109 queries
don't parse — recorded, not hidden), then the stage table:

```text
[bench] scifact · 1109 queries · vocab 26299
  stage                     avg      median     p95      min      max
  candidates                 0.226    0.183    0.500    0.030    2.601  (ms)
  boolean                    0.325    0.278    0.720    0.039    1.481  (ms)
  tfidf                      0.753    0.714    1.421    0.051    2.658  (ms)
  bm25                       0.940    0.903    1.676    0.050    2.893  (ms)
  bm25-phrase                0.976    0.926    1.775    0.061    3.215  (ms)
  bm25-phrase-proximity      2.634    1.572    8.096    0.081   41.274  (ms)
  bm25-fuzzy                 0.943    0.925    1.676    0.085    2.905  (ms)
  bm25-fuzzy2                1.290    0.929    4.128    0.066    8.695  (ms)
  bm25-pr                    1.145    1.110    2.011    0.079    3.289  (ms)
```

(exact values drift a few percent per run; the committed table is §6.5)

► SAY: *"End-to-end median under a millisecond, and every signal we added
(phrase, proximity, PageRank fusion, fuzzy) is a measured increment — not a
guessed one."*

### If something goes wrong (recovery)

| Symptom | Fix |
|---|---|
| `missing index: data/index/scifact.aidx` | `npm run index:build -- --corpus scifact` |
| corpus missing / md5 mismatch | `npm run corpus:scifact` |
| `npm run` shows no command | never guess — read the list first |
| Postgres connection refused | `npm run db:migrate`; tests/jobs fall back to embedded PG (ADR-011) |
| dirty worktree before a demo | `git status` — should be clean; do **not** commit mid-demo |
| artifact looks huge on screen | always `ConvertFrom-Json` + select fields |

---

## 12. File-by-file reference — what every file is for

Read this once before the demo; you should not need to open source files
*live* — but if asked "where is this implemented?", this is your index.

### 12.1 Root & tooling

| File | What it is |
|---|---|
| `package.json` | the command surface — every `npm run` script above lives here, plus dependencies |
| `tsconfig.json` | strict TypeScript (incl. `noUncheckedIndexedAccess`) — type safety as engineering evidence |
| `vitest.config.ts` | test runner config (21 suites) |
| `README.md` | front door: features, usage, status table, result headlines |
| `docker-compose.yml`, `.env.example` | optional PostgreSQL setup; embedded PG works without them (ADR-011) |

### 12.2 `src/core/text/` — analysis chain (index-time = query-time)

| File | What it is |
|---|---|
| `analyze.ts` | the shared pipeline: NFKC normalize → tokenize → stop words → stem; emits `Token {term, position, offsets}` |
| `porter.ts` | **our own Porter stemmer** implementation (23,531 test vectors) |
| `stopwords.ts` | English stop-word list |
| `index.ts` | barrel exports |

### 12.3 `src/core/index/` — the custom index

| File | What it is |
|---|---|
| `growable.ts` | doubling `Uint32` buffer used while staging postings — amortized O(1) appends, no object churn |
| `writer.ts` | builds term dictionary, delta-encoded postings, positional runs from documents (`IndexWriter.finalize()`) |
| `reader.ts` | reads a segment: lazy postings decode, `df`/`postingsForTerm`, stats, frozen analysis config |
| `types.ts` | pure segment data structures (no I/O) — the frozen format (ADR-001) |
| `index.ts` | barrel |

### 12.4 `src/core/query/` — parser

| File | What it is |
|---|---|
| `lexer.ts` | raw query string → structural tokens (terms, quotes, operators, parens) |
| `parser.ts` | recursive-descent parser; precedence; `implicitOperator: 'and' \| 'or'` modes |
| `ast.ts` | `Query` AST types (term / phrase / and / or / not) |
| `errors.ts` | typed parse errors with `code` + position (failures are recorded, never silent) |
| `index.ts` | barrel |

### 12.5 `src/core/retrieval/` — candidate generation & M4-C

| File | What it is |
|---|---|
| `boolean.ts` | set algebra on sorted `Uint32Array`: intersect / union / difference / universe |
| `analyze-query.ts` | query-side analysis over the AST (ADR-009) + `positiveQueryTerms` (what scoring may reward) |
| `evaluate.ts` | AST → candidate docIds (`evalAnalyzed`); multi-term leaves (fuzzy) = union |
| `phrase.ts` | positional phrase matching — consecutive positions, not mere co-occurrence |
| `positions.ts` | position-list access helpers |
| `proximity.ts` | smallest window over all query terms → `k / (1 + (window − \|q\|))` |
| `fuzzy.ts` | **M4-C**: `boundedEditDistance`, edit-1 variant generation, k=2 dictionary scan, strict caps, `expandFuzzyQuery` |
| `index.ts` | barrel |

### 12.6 `src/core/ranking/` — modes A–D

| File | What it is |
|---|---|
| `bm25.ts` | Okapi BM25 primitives (`bm25Idf`, `bm25TermScore`, k1/b resolution) — ADR-004 |
| `tfidf.ts` | TF-IDF primitives (raw / log / augmented tf) |
| `strategies.ts` | the strategy registry: boolean, tfidf, bm25, bm25-phrase, bm25-phrase-proximity; `createStrategy` / `resolveStrategyParams` / `STRATEGY_IDS`; BM25 accumulation loop |
| `fusion.ts` | **M4-B**: `normalizeScores` (min-max, optional guard) + `bm25PageRankStrategy` mode D |
| `types.ts` | `ScoredDoc`, `RankingStrategy`, mode letters A–D |
| `index.ts` | barrel |

### 12.7 `src/core/link/`

| File | What it is |
|---|---|
| `pagerank.ts` | **M4-A**: pure power iteration — `π ← (1−d)/N + d·(Aᵀπ + dangling/N)`, honest convergence reporting |

### 12.8 `src/crawler/` — controlled crawler (M3)

| File | What it is |
|---|---|
| `url.ts` | URL normalization — two forms of a page must hash byte-identically |
| `robots.ts` | our own RFC 9309 robots.txt parser |
| `politeness.ts` | per-host delay gate; robots crawl-delay overrides default |
| `frontier.ts` | in-memory BFS/priority frontier — every transition persisted to PG |
| `fetcher.ts` | HTTP via undici (ADR-007; Playwright deferred) |
| `extract.ts` | Cheerio extraction: title, readable text, outgoing links |
| `dedupe.ts` | exact-duplicate detection — sha1 over extracted text |
| `crawler.ts` | orchestrator: frontier → robots → politeness → fetch → extract → store |

### 12.9 `src/storage/` — persistence

| File | What it is |
|---|---|
| `segment.ts` | `.aidx` segment read/write (frozen format, ADR-001) |
| `corpus.ts` | fixture-corpus loader (manifest + documents.jsonl + html) |
| `repositories.ts` | repository interfaces (crawl state, documents, links) |
| `index.ts` | barrel incl. `AIDX_VERSION` |
| `postgres/pool.ts` | pg pool (DATABASE_URL or embedded fallback) |
| `postgres/store.ts` | concrete repository implementations |
| `postgres/migrate.ts` | migration runner |

### 12.10 `src/eval/` — the harness

| File | What it is |
|---|---|
| `metrics.ts` | P@K, R@K, F1, MAP, NDCG@K — textbook formulas, hand-verified arithmetic |
| `qrels.ts` | pure parsers: qrels TSV + queries JSONL (I/O stays in scripts/) |
| `evaluate.ts` | `evaluateQuery` / `evaluateRun` — a missing/failed query scores zeros, never dropped |
| `types.ts` | `Run`, `Qrels`, `EvaluationSummary` |
| `index.ts` | barrel |

### 12.11 `scripts/` — jobs (and `scripts/lib/` shared plumbing)

| File | What it is |
|---|---|
| `run-experiment.ts` | **the experiment runner**: strategy + corpus + flags → `runs/*.json` (metrics, latency, provenance) |
| `fuzzy-benchmark.ts` | **M4-C typo benchmark**: deterministic corruption, 3 arms, `bench:fuzzy` |
| `build-pagerank.ts` | **M4-A job**: graph from PG → PageRank → persist (`pagerank:build`) |
| `crawl.ts` | runs the crawler per `configs/crawl.json` (resumable `--resume`) |
| `fetch-scifact.ts` | fetches BEIR SciFact (md5-verified) + publishes eval inputs |
| `fetch-20newsgroups.ts` | 20 Newsgroups dev/latency corpus |
| `fetch-sci-citations.ts` | **M4-B**: Semantic Scholar citation graph over SciFact |
| `build-eval-index.ts` | builds `data/index/<corpus>.aidx` + id map |
| `build-crawl-index.ts` | PG → crawled index + committed manifest |
| `build-static-corpus.ts` / `generate-synthetic-corpus.ts` | fixture/synthetic corpora |
| `db-migrate.ts` | applies migrations, reports tables |
| `lib/retrieval-run.ts` | `loadIndexBundle` + `runQuerySet` — shared by runner & benches (timed e2e loop, optional fuzzy) |
| `lib/pagerank-scores.ts` | citation-graph loader (hash-checked) + `pageRankForBundle` |
| `lib/dataset.ts` | download / hash / archive / git-provenance helpers |
| `lib/embedded-pg.ts` | ephemeral embedded PostgreSQL for tests & jobs (ADR-011) |
| `lib/build-crawl-index.ts`, `lib/synthetic.ts` | logic behind the correspondingly named jobs |

### 12.12 `benchmarks/`

| File | What it is |
|---|---|
| `index-benchmark.ts` | M1 indexing evidence generator |
| `query-benchmark.ts` | latency stages: candidates → each strategy → `bm25-pr` → `bm25-fuzzy`/`bm25-fuzzy2` |
| `results/*.json` | **committed evidence** — every table in §6 comes from here |

### 12.13 `tests/` — 22 suites (312 tests) + `web/` (15 tests)

| Suite | Proves |
|---|---|
| `smoke.test.ts` | app boots; basic sanity |
| `analyze.test.ts` / `porter.test.ts` | analysis pipeline; **23,531 Porter vectors** |
| `query.test.ts` | lexer/parser, both implicit modes, precedence, every error code |
| `boolean.test.ts` | set ops + retrieval over a built index |
| `phrase.test.ts` | positional matching vs plain-AND counterexamples; mode C fixtures |
| `ranking.test.ts` | hand-computed TF-IDF/BM25 on a 4-doc fixture; registry |
| `fusion.test.ts` | normalization bounds/monotonicity; mode D w=0≡BM25, w=1=PageRank; graph loader |
| `fuzzy.test.ts` | hand-computed edit distances, typo recovery, every strict cap, identity pass-through, scoring integration |
| `eval.test.ts` | metrics arithmetic written out by hand |
| `index.test.ts` / `segment.test.ts` | index build/read roundtrip, persistence |
| `pipeline.test.ts` | end-to-end persistence pipeline |
| `url.test.ts` / `robots.test.ts` / `frontier.test.ts` / `extract.test.ts` / `crawler.test.ts` | crawler units (own RFC 9309 parser, normalization, dedupe…) |
| `crawl-e2e.test.ts` | controlled crawl against a fixture server |
| `postgres.test.ts` | schema + repositories + PageRank persistence on an ephemeral cluster |
| `pagerank.test.ts` | hand-computable graphs, dangling handling, determinism, convergence |
| `api.test.ts` | **M5** REST contract: six endpoints, validation, error envelope, locked artifact values |
| `helpers/`, `fixtures/` | fixture HTTP server, in-memory store, static test corpus |
| `web/src/api/client.test.ts` | **M5** client: URL building, envelope → `ApiError`, NETWORK/BAD_RESPONSE |
| `web/src/App.test.tsx` | **M5** desktop: boot/results, Evaluation 0.6436, doc window, status cards, minimize/restore |

### 12.14 `migrations/`, `configs/`

| File | What it is |
|---|---|
| `001_init.sql` | documents, urls, links, crawl state |
| `002_pagerank.sql` | `pagerank_runs` (params+convergence+gitSha) / `pagerank_scores` (url-keyed, FK cascade) |
| `configs/crawl.json` | crawl policy (budget, delays) — its sha256 is stamped into the manifest |

### 12.15 `data/`, `runs/`, `benchmarks/results/` — inputs & evidence

| Path | What it is |
|---|---|
| `data/corpora/static-v1/` | committed fixture corpus (80 HTML pages + manifest) — offline tests never need the network |
| `data/eval/scifact-qrels.tsv`, `scifact-queries.jsonl` | committed judgment/query inputs (the evaluation contract) |
| `data/eval/crawled.manifest.json`, `crawled.graph.json` | **M3 evidence**: crawl counts + 796-edge link graph |
| `data/eval/scifact-citations.json` | **M4-B evidence**: 2,015-edge citation graph + graphHash |
| `data/eval/*.manifest.json` | corpus provenance (hashes, counts, git) |
| `data/index/*.ids.json` | docId → corpus-id maps; `.aidx` segments (mostly gitignored; `crawled.aidx` frozen at `m3-complete`) |
| `runs/*.json` | committed experiment artifacts (§8 index) |
| `benchmarks/results/*.json` | committed benchmark artifacts |

### 12.16 `docs/`

| File | What it is |
|---|---|
| `README.md` (root) | status, usage, headlines |
| `ARCHITECTURE.md` | planes, module rules, query pipeline, ranking design |
| `DECISIONS.md` | ADR-001…011 (why each technology/choice) |
| `DEVELOPMENT.md` | milestone plan M0–M6 + append-only evidence log |
| `SEARCH.md` | syntax, analysis, set semantics, phrase/proximity, **fuzzy (§6)** |
| `RANKING.md` | modes A–D, formulas, what is deliberately *not* scored |
| `INDEXING.md` | segment format, postings, positions |
| `EVALUATION.md` | metrics, artifact schema, protocol |
| `EXPERIMENTS.md` | results tables with "how to read them" (M2 §1–2, M4-B §3, **M4-C §4**, reproduce §5) |
| `CRAWLER.md`, `DATABASE.md` | crawler behavior; schema & persistence |
| `REPORT.md` | **this document** |

### 12.17 M5 — API + Aero UI (`src/api/`, `web/`, `scripts/demo.ts`)

| File | What it is |
|---|---|
| `src/api/app.ts` | Fastify factory: six routes, JSON-Schema validation, CORS, error envelope, static `web/dist` + SPA fallback |
| `src/api/search-service.ts` | the M5 seam — wraps parse → analyze → fuzzy → retrieve → rank with runtime cache, snippets, stats, latency ring |
| `src/api/{config,snippets,doc-store,server,index}.ts` | env config; snippet windowing; per-corpus doc text (PG only for crawled); process entry; barrel |
| `web/src/App.tsx` + `web/src/windows/*` | window manager + Search/Doc/Evaluation/Status/Settings windows (signal bars, diagnostics drawer) |
| `web/src/api/client.ts` | single client error path: envelope → `ApiError`; `types.ts` mirrors the contract |
| `web/src/styles/aero.css` | hand-written Aero design system (no UI kit) |
| `scripts/demo.ts` / `scripts/bench-api.ts` | 14-check in-process demo / HTTP latency artifact generator |
| M5 docs | `API.md` (endpoint reference) · `FRONTEND.md` · `CODE_WALKTHROUGH.md` (one query traced) · `DEMO.md` · `DEPLOYMENT.md` · `M5.md` · `M5_FINAL_VERIFICATION.md` (acceptance matrix) |

---

## 13. Today's checklist (in order, then stop)

```text
[x] git status                          → clean
[x] npm run typecheck                   → green (root + web)
[x] npm test                            → 312/312
[x] npm run web:test                    → 15/15
[x] npm run                             → command list inspected
[x] git tag -a m4-complete              → tagged at 0e73bf8 (command in §1)
[x] npm run demo                        → 14/14 in-process checks (M5)
[ ] screenshot: 312 + 15 tests
[ ] read §11 walkthrough once           → then rehearse Stages 0–7 end-to-end (~15 min)
[ ] read §12 file guide once            → so "where is this implemented?" has an answer
[ ] browser walkthrough (M5)            → docs/DEMO.md §3 — search, strategy switch, fuzzy, doc, Evaluation, Status
[ ] inspect runs/                       → §11 Stage 2 commands (open artifacts *selectively*)
[ ] inspect benchmark artifacts         → §6 tables match the JSON
[ ] inspect crawled.manifest.json       → §11 Stage 5 (Demo C evidence)
[ ] screenshot: BM25 evaluation artifact (Demo A)
[ ] screenshot: fuzzy benchmark artifact (Demo D)
[ ] architecture diagram                → §3 (move to Figma/slides as-is)
[ ] query-journey diagram               → §4 (second slide)
[ ] comparison table (Boolean/TF-IDF/BM25) → §6.1 (third slide)
[ ] one-page explanation                → §10 (speak it, don't read it)
[ ] practice: one query end-to-end      → §4 hand-trace (`seach` example)
[ ] practice the 4 SAY-lines            → Stage 0, 3, 4, 5 narrations from §11
```

**Directive update:** M5 (Fastify API + React Aero UI) is **done** — API,
Aero UI, demo script, Docker stack and M5 docs are committed; the
checkpoint was tagged `m4-complete` first, as directed (M7 remains removed
from the production timeline). Acceptance matrix and commit list:
`docs/M5_FINAL_VERIFICATION.md`.

---

*Regenerated at the M5 completion session (commit list in
`docs/M5_FINAL_VERIFICATION.md`), typecheck green, 312/312 + 15/15 tests,
worktree clean. §11 = prompt-by-prompt demo walkthrough, §12 = file-by-file
reference. All numbers sourced from committed artifacts listed in §8; every
§11 stage command was executed live and matched (the only exceptions are the
two commands explicitly labeled "optionally live" in Stage 6, which need a
database).*
