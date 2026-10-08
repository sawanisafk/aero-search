# Experiments — M2 & M4-B Results (SciFact)

> Every number below is copied from a committed artifact —
> `runs/*.json` and `benchmarks/results/*query-benchmark.json`.
> Evidence rule: [DEVELOPMENT.md](DEVELOPMENT.md) · Protocol: [EVALUATION.md](EVALUATION.md).

**§1–§2 suite:** git `7d9ef4c` (worktree clean in all artifacts) · 2026-10-07 ·
Node v24.13.0, Windows · corpus BEIR SciFact (5,183 docs, corpus hash `dec31c81…` in
artifacts) · queries: test split, 300 judged (339 judgments) · top-K = 1000,
k ∈ {1,5,10,100} · strategy params recorded per artifact (`strategy.params`).
**§3 suite (M4-B):** git `05601f9`, clean · 2026-10-08 · same corpus/protocol.

---

## 1. Strategy comparison (mode A vs B vs C vs floor)

| Strategy | MAP | P@5 | P@10 | P@100 | NDCG@5 | NDCG@10 | NDCG@100 | R@100 | latency avg/median/p95 (ms) |
|---|---|---|---|---|---|---|---|---|---|
| `boolean` (floor) | 0.0049 | 0.0013 | 0.0007 | 0.0006 | 0.0034 | 0.0034 | 0.0130 | 0.0590 | 0.60 / 0.49 / 1.22 |
| `tfidf-raw` (A) | 0.4421 | 0.1260 | 0.0747 | 0.0099 | 0.4626 | 0.4955 | 0.5405 | 0.8814 | 1.12 / 1.03 / 2.14 |
| `bm25-k1.2-b0.75` (B) | **0.6436** | **0.1613** | **0.0913** | 0.0105 | **0.6604** | **0.6876** | **0.7104** | **0.9276** | 1.37 / 1.27 / 2.47 |
| `bm25-phrase` (C−prox) | 0.6436 | 0.1613 | 0.0913 | 0.0105 | 0.6604 | 0.6876 | 0.7104 | 0.9276 | 1.55 / 1.48 / 2.96 |
| `bm25-phrase-proximity` (C) | **0.6440** | 0.1613 | 0.0913 | 0.0105 | 0.6608 | 0.6880 | 0.7109 | 0.9276 | 4.21 / 2.31 / 14.32 |
| C with `--proximity-k 0` (ablation) | 0.6436 | 0.1613 | 0.0913 | 0.0105 | 0.6604 | 0.6876 | 0.7104 | 0.9276 | 1.69 / 1.57 / 3.10 |

Artifacts (all `git.sha = 7d9ef4c…`, `git.clean = true`):

| File | Strategy | Params |
|---|---|---|
| `runs/2026-10-07T14-52-51-610Z-scifact-boolean.json` | boolean | `{}` |
| `runs/2026-10-07T14-52-52-959Z-scifact-tfidf-raw.json` | tfidf | `{tf: raw}` |
| `runs/2026-10-07T14-52-54-370Z-scifact-bm25-k1.2-b0.75.json` | bm25 | `{k1: 1.2, b: 0.75}` |
| `runs/2026-10-07T14-52-55-828Z-scifact-bm25-phrase.json` | bm25-phrase | `{k1: 1.2, b: 0.75, phraseBonus: 1.2}` |
| `runs/2026-10-07T14-52-58-094Z-scifact-bm25-phrase-proximity.json` | full mode C | `+proximityK: 1.0` |
| `runs/2026-10-07T14-52-59-604Z-scifact-bm25-phrase-proximity.json` | ablation | `+proximityK: 0` |

### Reading the table

1. **Boolean floor ≈ 0** — expected: mode BOOL orders candidates by docId. Confirms
   metric plumbing is not accidentally generous.
2. **TF-IDF → BM25: +0.20 MAP (0.442 → 0.644)** — saturation + length normalization
   doing what the theory says, on real judged data.
3. **`bm25-phrase` ≡ `bm25` bit-for-bit** — a *sanity check*, not a dud: SciFact
   queries contain no quoted phrases, so the phrase component never fires. The
   signal is query-driven — the machinery is exercised by unit tests and will
   matter once the UI accepts quoted queries (M5) and on M3's own qrels.
4. **Proximity: +0.0004 MAP / +0.0005 NDCG@10, at ~3× median latency** — on
   plain bag-of-words queries the min-window term is a weak but real co-occurrence
   prior; it flips **1 query's rank-1** (P@1 0.5533 → 0.5567). Honest conclusion:
   on this corpus/query set proximity is a marginal gain at real cost — its value
   proposition (phrase-heavy queries) will be tested properly when the UI accepts
   quoted queries and on M3's own qrels.
5. **Ablation closes the loop**: `--proximity-k 0` reproduces `bm25-phrase` exactly
   (every metric), proving proximity only touches scoring, never candidates.
6. **External corroboration (cited, not tuned to):** BEIR's reference Lucene BM25
   (Anserini) reports **nDCG@10 = 0.665, Recall@100 = 0.908** on SciFact
   (Thakur et al., NeurIPS 2021 Datasets & Benchmarks; same numbers reproduced in
   *Resources for Brewing BEIR*, SIGIR 2024). Ours: **0.688 / 0.928**. The correct
   claim is: **our implementation achieved comparable performance to the BEIR
   reference BM25 configuration on SciFact, with differences attributable to
   implementation and configuration details** — our tokenizer + Porter stemmer +
   stop list, disjunctive parsing, BM25 `k1 = 1.2, b = 0.75` (Anserini defaults
   are `k1 = 0.9, b = 0.4`), top-K 1000, TypeScript vs Lucene. This is an
   independent sanity anchor, **not** a claim that we beat Lucene — we do not tune
   parameters against published numbers.

---

## 2. Query latency (e2e per query: parse → analyze → retrieve → rank → top-K map)

`benchmarks/results/2026-10-07T14-53-*` · git `7d9ef4c`, clean ·
**avg / median / p95 in ms** · `candidates` = parse+analyze+boolean retrieval only.

### SciFact — 1,109 queries, vocab 26,299 (formal corpus)

| Stage | avg | median | p95 | max |
|---|---|---|---|---|
| candidates | 0.285 | 0.235 | 0.643 | 3.463 |
| boolean | 0.417 | 0.365 | 0.889 | 1.775 |
| tfidf | 0.973 | 0.915 | 1.832 | 3.241 |
| bm25 | 1.171 | 1.145 | 2.080 | 4.369 |
| bm25-phrase | 1.238 | 1.193 | 2.201 | 3.673 |
| bm25-phrase-proximity | 3.353 | 1.952 | 10.032 | 53.917 |

### static-v1 — 60 derived queries, vocab 9,145 (committed fixture)

| Stage | avg | median | p95 | max |
|---|---|---|---|---|
| candidates | 0.161 | 0.064 | 0.595 | 1.442 |
| boolean | 0.081 | 0.061 | 0.188 | 0.282 |
| tfidf | 0.117 | 0.070 | 0.265 | 0.888 |
| bm25 | 0.096 | 0.069 | 0.220 | 0.367 |
| bm25-phrase | 0.105 | 0.065 | 0.300 | 0.388 |
| bm25-phrase-proximity | 0.240 | 0.104 | 0.812 | 1.341 |

### 20 Newsgroups — 60 derived queries, vocab 140,162 (dev/latency corpus, no qrels)

| Stage | avg | median | p95 | max |
|---|---|---|---|---|
| candidates | 7.713 | 0.257 | 49.870 | 110.072 |
| boolean | 7.702 | 0.919 | 47.892 | 85.208 |
| tfidf | 8.470 | 1.794 | 48.786 | 75.689 |
| bm25 | 9.488 | 2.862 | 52.591 | 74.878 |
| bm25-phrase | 16.429 | 3.066 | 95.684 | 177.420 |
| bm25-phrase-proximity | 82.873 | 5.222 | 334.594 | 1333.481 |

**Derived queries** (when `--queries` is omitted): deterministic templates over the
index's top-df terms — 20 singles, 10 `AND`, 10 `OR`, 10 phrase, 10 `AND NOT` —
same bytes every run (artifact `config.query_source = derived-top-df-templates`).

### Reading the tables

- **Sub-millisecond medians on the formal corpus** for every non-proximity stage;
  worst observed e2e p95 = 10 ms (proximity) — far inside the <100 ms envelope
  (ARCHITECTURE §1).
- **Proximity cost is real and super-linear in candidates**: min-window sweeps every
  candidate's merged positions (20 News worst case 1.33 s on a query with enormous
  OR-candidates — median there is still 5.2 ms; the tail is the known risk and the
  reason `proximityK = 0` and candidate caps exist as knobs).
- The 20 News p95 ≈ median of other stages ≈ 50 ms across *all* stages — dominated by
  the same giant-OR candidate sets, not by scoring.
- Parse failures recorded per stage in the artifacts: SciFact 2/1,109 (see
  EVALUATION.md caveat 2), other corpora 0.

---

## 3. M4-B — hybrid fusion: BM25 + PageRank (mode D)

**Signal:** PageRank over the *real* citation graph of the corpus — Semantic Scholar
references restricted to in-corpus pairs (`data/eval/scifact-citations.json`:
4,879/5,183 papers resolved, 100,979 references → **2,015 directed edges**, 955
citing papers, graphHash `3d7b80d2…`, corpus sha256 recorded). Power iteration,
d = 0.85, tol = 1e-6 → **converged in 41 iterations, residual 8.64e-7** (recorded
in every run artifact under `link_graph.pagerank`).

**Fusion:** `score = (1−w)·ŝ_BM25 + w·ŝ_PageRank`, both signals min-max normalized
to [0, 1] with different scopes — BM25 per query over the query's candidates,
PageRank once over the whole corpus (a query-independent signal gets a
query-independent scale). Normalization + the outlier-guard experiment are
`src/core/ranking/fusion.ts`; `w = 0` reproduces BM25 exactly.

| Strategy | w | MAP | NDCG@10 | P@10 | R@100 | run avg ms |
|---|---|---|---|---|---|---|
| `bm25` (baseline) | — | 0.6436 | 0.6876 | 0.0913 | 0.9276 | 1.042 |
| `bm25-pr-w0.01` | 0.01 | 0.6436 | 0.6876 | 0.0913 | 0.9276 | 1.471 |
| `bm25-pr-w0.02` | 0.02 | 0.6434 | 0.6874 | 0.0913 | 0.9276 | 1.435 |
| `bm25-pr-w0.05` | 0.05 | **0.6451** | **0.6886** | 0.0913 | 0.9276 | 1.478 |
| `bm25-pr-w0.1` | 0.10 | 0.6440 | 0.6878 | 0.0913 | 0.9309 | 1.456 |
| `bm25-pr-w0.2` | 0.20 | 0.6438 | 0.6866 | 0.0910 | 0.9309 | 1.521 |
| `bm25-pr-w0.3` | 0.30 | 0.6413 | 0.6839 | 0.0907 | 0.9316 | 1.443 |
| `bm25-pr-w0.5` | 0.50 | 0.5163 | 0.5788 | 0.0853 | 0.9242 | 1.478 |

`run avg ms` = per-query e2e latency inside the run artifact (300 queries,
top-K 1000) — cross-stage comparisons belong to the bench artifact below.

### Reading the table

1. **The academic answer: weakly positive.** Citation authority helps *slightly*
   at low weights — best w = 0.05 gives **+0.0015 MAP / +0.0010 NDCG@10** over the
   BM25 baseline, and recall@100 improves for w ≥ 0.1 (0.9276 → 0.9316). Honest
   conclusion: on this corpus/query set link-based authority is a marginal
   tie-breaker, not a new ranking regime. A null-ish result is still a result —
   it is reported as measured, not oversold.
2. **Dose-response:** flat through w ≈ 0.2, degradation at 0.3, collapse at 0.5
   (MAP −20%, 0.64 → 0.52) where authority starts overriding lexical fit. The
   usable band is w ∈ [0.01, 0.2]; that band is what a future mode config would
   expose as its default range.
3. **Ablation controls:** `--pr-weight 0` reproduces baseline MAP exactly and a
   unit test asserts w = 0 yields byte-identical ordering to `bm25` — the fusion
   plumbing cannot silently change results. Graph provenance (`graph_hash`,
   edges, corpus sha256) and PageRank convergence are embedded in every artifact,
   so any row is reproducible from committed inputs alone.
4. **Normalization is the whole game — a documented negative result.** The first
   implementation normalized PageRank per query over candidates and guarded
   min-max at p95; both *destroyed* MAP (0.64 → 0.12 at w = 0.2). Two independent
   failure modes: (a) per-candidate min-max stretches PageRank's near-flat tail —
   ~75% of papers share the teleport floor — to the full [0, 1], amplifying
   rounding-level differences into full-scale noise; (b) the p95 guard condenses
   a 1,700–3,000-candidate query's top ~100 docs into a [0.95, 1] band where any
   second signal picks the winner. Fixes: corpus-global PageRank scale, guard off
   by default (kept as a strictly-monotone knob). Numbers above are the corrected
   protocol; the failure and its mechanism are recorded in `fusion.ts` and RANKING.md.
5. **Latency impact (+13%, bench artifact):** `bm25` 1.008 ms avg → `bm25-pr`
   1.136 ms avg over 1,109 queries (median 0.953 → 1.106, p95 1.847 → 1.996) —
   the cost of one extra min-max pass over candidates. PageRank itself is
   computed once per run, outside the timed loop: the query path never touches
   graph data (ADR-003 spirit).

Artifacts (git `05601f9`, `git.clean = true`): quality rows = `runs/` files
`2026-10-08T03-26-06-009Z-scifact-bm25-k1.2-b0.75.json` +
`2026-10-08T03-26-{07-942,09-906,11-923,13-896,15-909,17-895,19-869}Z-scifact-bm25-pr-w*.json`
(8 files); latency = `benchmarks/results/2026-10-08T03-26-43-094Z-query-benchmark.json`
(includes a `bm25-pr` stage + `link_graph` block).

---

## 4. M4-C — fuzzy retrieval: typo recovery with bounded edit distance

**Question:** does bounded edit-distance expansion recover queries whose terms
miss the dictionary — and at what precision/latency cost?

**Protocol — separate benchmark, same judged data.** `npm run bench:fuzzy`
corrupts every judged SciFact query *deterministically* (no seeds): the first
word token (length ≥ 4, indexed, non-stopword) gets a single-character
substitution (position last → first, letter a → z) accepted only when the
corrupted form analyzes to a dictionary miss at edit distance exactly 1.
**300/300 queries corruptible, 0 skipped.** Arms run over the identical judged
subset through the full e2e pipeline (strategy `bm25`):

| Arm | query text | fuzzy | MAP | NDCG@10 | R@100 | avg ms |
|---|---|---|---|---|---|---|
| clean | original | off | 0.6436 | 0.6876 | 0.9276 | 1.005 |
| typo-exact | corrupted | off | 0.5665 | 0.6101 | 0.9040 | 0.890 |
| typo-fuzzy (k=1) | corrupted | on (default) | **0.6386** | 0.6819 | 0.9309 | 1.136 |
| typo-fuzzy (k=2) | corrupted | on (maxEdits 2) | 0.6157 | 0.6624 | **0.9342** | 4.340 |

### Reading the table

1. **The typo is real damage; k=1 recovers most of it.** One wrong character
   costs −0.0771 MAP / −0.0774 NDCG@10 (0.6436 → 0.5665). Bounded (k=1)
   expansion recovers **0.0722 of the 0.0772 MAP gap = 93.5%** (NDCG@10:
   92.8%) — the recovered arm lands within 0.005 MAP of the clean ceiling, and
   R@100 actually exceeds clean (0.9309 vs 0.9276) because an expanded leaf is
   a union (variants add recall).
2. **k=2 is a measured negative result.** The wider radius finds more
   neighbors — highest R@100 (0.9342) — but distance-2 noise outweighs the
   extra recovery: MAP 0.6157, *below* k=1, only 63.9% of the gap, at ~4×
   latency on the typo set (4.34 vs 1.14 ms avg). k=1 is the correct default;
   k=2 stays opt-in with the same strict caps.
3. **Expansion is a precision tradeoff — measured on clean queries too.**
   Fuzzy over the *uncorrupted* queries (run artifact) attempts 72 absent
   terms across 30/300 queries, adds 157 variants: those absences are genuine
   OOV terms, not typos, so their expansions are noise — MAP 0.6436 → 0.6353
   (−0.0083) while R@100 rises 0.9276 → 0.9309. Fuzzy pays when the miss is a
   typo; it costs a little when the miss is real.
4. **Strict limits, all recorded, all firing.** In the k=1 arm the
   `expansionsPerTerm` cap fired 8× and `expansionsPerQuery` 3× across 300
   queries (artifact `fuzzy.stats.caps`); defaults are 10 variants/term, 10
   absent terms/query, 20 variants/query, min length 3, `maxEdits` 1.
5. **Latency (bench artifact, 1,109 queries):** `bm25` 0.887 ms avg →
   `bm25-fuzzy` 0.868 ms (the no-op expansion tax is indistinguishable from
   noise — clean queries rarely miss) → `bm25-fuzzy2` 1.232 avg / 3.894 p95 /
   7.773 max. History worth recording: the first k=2 implementation composed
   edit1×edit1 sets — quadratic — and measured **max 1,554 ms** in the same
   bench; it was replaced by a bounded dictionary scan (length ±2 filter +
   early-exit DP), which is both faster and *complete* (no truncation), giving
   the max above.
6. **Integration semantics:** expansion rewrites only absent term leaves
   (exact-match terms never expand; phrases and NOT subtrees stay exact) into
   `[original, …variants]`, evaluated as a union — one transformation feeds
   both candidate retrieval and BM25 scoring (variants carry their real idf).
   `run-experiment --fuzzy` records resolved params + aggregate stats in the
   artifact.

Artifacts (git `b713150`, `git.clean = true`):
`benchmarks/results/2026-10-08T03-59-11-510Z-fuzzy-benchmark.json` (k=1, all
300 corrections listed), `…03-59-23-203Z-fuzzy-benchmark.json` (k=2),
`…03-59-43-121Z-query-benchmark.json` (latency stages),
`runs/2026-10-08T03-59-45-029Z-scifact-bm25-k1.2-b0.75-fuzzy.json`
(clean-query arm).

---

## 5. Reproduce

```bash
npm run corpus:scifact && npm run index:build -- --corpus scifact
npm run eval:run -- --corpus scifact --strategy bm25
npm run eval:run -- --corpus scifact --strategy bm25-phrase-proximity --proximity-k 0
npm run eval:run -- --corpus scifact --strategy bm25-pr --pr-weight 0.05   # M4-B
npm run eval:run -- --corpus scifact --strategy bm25 --fuzzy               # M4-C clean arm
npm run bench:fuzzy                                                        # M4-C typo recovery
npm run bench:fuzzy -- --fuzzy-edits 2                                     # M4-C k=2 (negative)
npm run bench:query -- --corpus scifact --queries data/eval/scifact-queries.jsonl
npm run corpus:20news && npm run index:build -- --corpus 20newsgroups
npm run bench:query -- --corpus 20newsgroups
```

Artifact schema: EVALUATION.md §7 / `benchmarks/results/*query-benchmark.json`
(`{kind, timestamp, git, config, corpus, parse_failures, stages}`).
