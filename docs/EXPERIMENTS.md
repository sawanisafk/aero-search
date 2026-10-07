# Experiments — M2 Results (SciFact)

> Every number below is copied from a committed artifact —
> `runs/*.json` and `benchmarks/results/*query-benchmark.json`.
> Evidence rule: [DEVELOPMENT.md](DEVELOPMENT.md) · Protocol: [EVALUATION.md](EVALUATION.md).

**Suite:** git `7d9ef4c` (worktree clean in all artifacts) · 2026-10-07 ·
Node v24.13.0, Windows · corpus BEIR SciFact (5,183 docs, corpus hash `dec31c81…` in
artifacts) · queries: test split, 300 judged (339 judgments) · top-K = 1000,
k ∈ {1,5,10,100} · strategy params recorded per artifact (`strategy.params`).

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
   *Resources for Brewing BEIR*, SIGIR 2024). Ours: **0.688 / 0.928** — same
   ballpark, slightly above, with fully documented differences: our tokenizer +
   Porter stemmer + stop list, disjunctive parsing, BM25 `k1 = 1.2, b = 0.75`
   (Anserini defaults are `k1 = 0.9, b = 0.4`), top-K 1000, TypeScript vs Lucene.
   This is an independent sanity anchor, **not** a parity claim — we do not tune
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

## 3. Reproduce

```bash
npm run corpus:scifact && npm run index:build -- --corpus scifact
npm run eval:run -- --corpus scifact --strategy bm25
npm run eval:run -- --corpus scifact --strategy bm25-phrase-proximity --proximity-k 0
npm run bench:query -- --corpus scifact --queries data/eval/scifact-queries.jsonl
npm run corpus:20news && npm run index:build -- --corpus 20newsgroups
npm run bench:query -- --corpus 20newsgroups
```

Artifact schema: EVALUATION.md §7 / `benchmarks/results/*query-benchmark.json`
(`{kind, timestamp, git, config, corpus, parse_failures, stages}`).
