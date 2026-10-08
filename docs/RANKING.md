# Ranking — Signals & Strategies

> How candidates become an ordered result list.
> Query language & retrieval: [SEARCH.md](SEARCH.md) · Formulas in the architecture:
> [ARCHITECTURE.md §6](ARCHITECTURE.md) · Measured behavior: [EXPERIMENTS.md](EXPERIMENTS.md).

---

## 1. Strategy contract

Everything in `src/core/ranking/` implements one interface (`types.ts`):

```ts
interface RankingStrategy {
  readonly id: string;                 // stable, param-encoded (bm25-k1.2-b0.75, bm25-pr-w0.2)
  readonly mode: 'A' | 'B' | 'C' | 'D' | 'BOOL';
  rank(reader, analyzed, candidates): ScoredDoc[];
}

interface ScoredDoc {
  docId: number;
  score: number;                       // total (fused in mode D)
  breakdown: Record<string, number>;   // per-signal components (explainability)
}
```

Rules:

- Strategies consume **(analyzed query, boolean candidates)** — they never re-run
  boolean logic and never see raw text.
- Scoring walks the **postings of the query's positive terms** (O(Σ df), cost tracks
  query terms, not corpus size) and accumulates only into flagged candidates.
- Output ordering is deterministic: score descending, ties broken by `docId` ascending
  (`sortScored`) — equal scores can never flip between runs.
- Core is I/O-free: strategies take an `IndexReader`, touch no `fs`/network.

> ARCHITECTURE §6 sketches the field as `final`; we keep `score` as the fused
> total (mode D produced the distinct multi-signal total) and expose per-signal
> contributions through `breakdown`.

---

## 2. Registry & configured construction

| id | Mode | Signal | Factory |
|---|---|---|---|
| `boolean` | BOOL | unranked floor: every candidate scores 0, order = docId | `booleanStrategy` |
| `tfidf-raw` / `tfidf-log` / `tfidf-augmented` | A | TF-IDF, selectable tf weighting | `tfidfStrategy({tf})` |
| `bm25-k1.2-b0.75` | B | Okapi BM25 | `bm25Strategy({k1,b})` |
| `bm25-phrase` | C | + exact-phrase bonus (ablation arm) | `bm25PhraseStrategy({…,phraseBonus})` |
| `bm25-phrase-proximity` | C | + proximity window (full mode C) | `bm25PhraseProximityStrategy({…,proximityK})` |
| `bm25-pr-w0.2` | D | weighted fusion: min-max BM25 + min-max PageRank | `bm25PageRankStrategy({pagerank, prWeight, normGuard})` |

- `RANKING_STRATEGIES` — id → default instance (registry). Mode D is **not** in
  it: it cannot exist without a PageRank vector. `STRATEGY_IDS` lists every id
  `createStrategy` accepts (what experiment tooling validates against);
  constructing `bm25-pr` without `options.pagerank` throws.
- `createStrategy(id, options)` — configured instance; **validates eagerly**
  (RangeError on bad k1/b/bonus/k/prWeight/normGuard at construction, not first
  query; `bm25-pr` additionally checks the PageRank length against the index at
  rank time). Used by the experiment runner so recorded parameters and the
  instance that produced the numbers are one source of truth.
- `resolveStrategyParams(id, options)` — the fully-resolved parameter set
  (`{k1:1.2, b:0.75, …}` with defaults applied) written into run artifacts.

Defaults: `k1 = 1.2`, `b = 0.75`, `tf = raw`, `phraseBonus = 1.2`, `proximityK = 1.0`,
`prWeight = 0.2`, `normGuard = 1` (plain min-max)
(`DEFAULT_BM25`, `DEFAULT_TF_WEIGHTING`, `DEFAULT_PHRASE_BONUS`, `DEFAULT_PROXIMITY_K`,
`DEFAULT_PR_WEIGHT`, `DEFAULT_NORM_GUARD`).

---

## 3. Mode A — TF-IDF (`tfidf.ts`)

```
idf(t)      = ln(N / df_t)
tf weighting (selectable experimental axis):
  raw       = tf
  log       = 1 + ln(tf)                (tf=0 → 1 by construction, tf≥1)
  augmented = 0.5 + 0.5 · tf / maxTf(d) (per-document, requires maxTf)
score(q,d)  = Σ_t∈q⁺  idf(t) · tfw(t,d)
```

`maxTf` needs a per-document forward statistic; the M1 freeze forbids extending the
index layout, so `maxTermFrequencies(reader)` is computed lazily and cached per reader
in a `WeakMap` (one pass, reused across queries).

## 4. Mode B — BM25 (`bm25.ts`)

```
score(q,d) = Σ_t∈q⁺  IDF(t) · tf·(k1+1) / ( tf + k1·(1 − b + b·|d|/avgdl) )
IDF(t)     = ln( 1 + (N − df + 0.5)/(df + 0.5) )     // always ≥ 0
```

- **tf saturation** (k1) and **length normalization** (b) are the two dials; both are
  configurable and swept in evaluation, not hard-coded dogma.
- `resolveBm25` validates `k1 > 0`, `0 ≤ b ≤ 1` → `RangeError`.
- IDF uses the `+1`-guarded form so a term appearing in every document cannot produce
  a negative score.

## 5. Mode C — composition (raw-additive, deliberately)

```
score = bm25 + phraseBonus·[each exact phrase leaf matched] + proximityScore
```

- **phrase component** (`accumulatePhraseBonus`): for every phrase leaf of the
  analyzed query, +`phraseBonus` per exactly-matched candidate. Terms under NOT never
  contribute (positive terms only).
- **proximity component** (`accumulateProximity`): `k/(1+(window−|q|))` over **all**
  positive query terms (see [SEARCH.md §5](SEARCH.md)); `< 2` terms → 0; `k = 0`
  disables the component entirely (ablation arm).
- **Raw additive was intentional for M2**: normalization + fusion landed in M4
  as mode D (§6) — measuring each raw signal first is what makes the later
  ablations attribute their changes cleanly.
- Ablation arms (both runnable today):
  - `bm25-phrase` vs `bm25` → phrase signal alone
  - `bm25-phrase-proximity --proximity-k 0` vs full mode C → proximity signal alone

## 6. Mode D — normalized fusion (`fusion.ts` + `bm25-pr`)

```
score(q,d) = (1 − w)·ŝ_BM25(q,d) + w·ŝ_PageRank(d)        w ∈ [0, 1], default 0.2
ŝ_BM25      = min-max over the query's candidates          (query-dependent signal)
ŝ_PageRank  = min-max over the whole corpus, once          (query-independent signal)
breakdown   = { bm25: (1−w)·ŝ_BM25, pagerank: w·ŝ_PageRank }   Σ = score
```

- **Why scopes differ:** PageRank is computed offline and does not depend on the
  query; normalizing it per query over candidates would stretch its near-flat
  tail (~75% of papers share the teleport floor) to the full [0, 1] and amplify
  rounding-level differences into full-scale noise — measured MAP collapse
  0.64 → 0.12 at w = 0.2 (EXPERIMENTS.md §3).
- **Normalization (`normalizeScores`):** plain min-max → [0, 1] by default,
  strictly monotone (ties only for equal inputs), degenerate ranges → 0 (a
  signal that cannot discriminate contributes nothing). An optional quantile
  outlier guard is available (`normGuard < 1`, split-anchor mapping, still
  strictly monotone — never clamps distinct scores to a tie band); it defaults
  to **off** because p95 guarding measured harmful on SciFact (it condenses the
  top of large candidate sets into [0.95, 1], handing the winner to any second
  signal). Both mechanisms are hand-tested in `tests/fusion.test.ts`.
- **PageRank input:** `scripts/lib/pagerank-scores.ts` maps a committed citation
  graph onto docIds and runs the shared power-iteration core (`src/core/link/pagerank.ts`)
  once per experiment run — the query loop never touches graph data.
  `w = 0` reproduces BM25's ordering exactly (asserted in tests and at scale:
  MAP 0.6436 identical).
- Ablation arms (runnable): `eval:run --strategy bm25-pr --pr-weight <w>` for
  w ∈ {0, …, 1}; results + `--norm-guard` variant in EXPERIMENTS.md §3.

## 7. What NOT is in scoring

`positiveQueryTerms()` strips NOT subtrees: `lung cancer NOT smoking` scores documents
on `lung`+`cancer` only, while boolean candidates still exclude `smoking` hits.
Combining them would make relevance scores depend on exclusion clauses (a doc's score
would drop for containing an excluded word — not a relevance judgment).

Conversely, fuzzy-expanded variants (M4-C, SEARCH.md §6) *are* positive terms: an
expanded leaf `[seach, search, …]` scores every variant with its own idf (the absent
original contributes nothing — no postings), so recovered terms are ranked exactly
like typed ones.

---

## 8. Hand-verified tests

Every formula has a hand-calculated fixture — no tolerance-only assertions:

| Suite | Fixture |
|---|---|
| `tests/ranking.test.ts` | 4-doc index with df/tf/dl designed for closed-form TF-IDF + BM25 checks; NOT-scoring; registry; `createStrategy`/`resolveStrategyParams` |
| `tests/phrase.test.ts` | mode C ordering flip fixture: bm25 ranks `alpha zeta beta` first, mode C flips to `gamma gamma gamma alpha beta` (window 2 vs 3) with exact scores |
| `tests/fusion.test.ts` | `normalizeScores` bounds/guard-band/strict-monotonicity/degenerate cases; mode D: w=0 ≡ bm25 ordering, w=1 = PageRank order, w=0.5 hand-computed fused scores (PR flips the top hit), breakdown Σ = score; citation-graph loader (2,015-edge file, mapping-bug refusal, Σπ=1, determinism) |
| `tests/boolean.test.ts` | candidates that the scores sit on |

Reproduce: `npm test`.
