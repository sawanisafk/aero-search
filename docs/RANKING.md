# Ranking — Signals & Strategies

> How candidates become an ordered result list.
> Query language & retrieval: [SEARCH.md](SEARCH.md) · Formulas in the architecture:
> [ARCHITECTURE.md §6](ARCHITECTURE.md) · Measured behavior: [EXPERIMENTS.md](EXPERIMENTS.md).

---

## 1. Strategy contract

Everything in `src/core/ranking/` implements one interface (`types.ts`):

```ts
interface RankingStrategy {
  readonly id: string;                 // stable, param-encoded (bm25-k1.2-b0.75)
  readonly mode: 'A' | 'B' | 'C' | 'BOOL';
  rank(reader, analyzed, candidates): ScoredDoc[];
}

interface ScoredDoc {
  docId: number;
  score: number;                       // total
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

> ARCHITECTURE §6 sketches the field as `final`; the M2 implementation names it
> `score`. `final` arrives in M4 when normalized fusion produces a distinct total.

---

## 2. Registry & configured construction

| id | Mode | Signal | Factory |
|---|---|---|---|
| `boolean` | BOOL | unranked floor: every candidate scores 0, order = docId | `booleanStrategy` |
| `tfidf-raw` / `tfidf-log` / `tfidf-augmented` | A | TF-IDF, selectable tf weighting | `tfidfStrategy({tf})` |
| `bm25-k1.2-b0.75` | B | Okapi BM25 | `bm25Strategy({k1,b})` |
| `bm25-phrase` | C | + exact-phrase bonus (ablation arm) | `bm25PhraseStrategy({…,phraseBonus})` |
| `bm25-phrase-proximity` | C | + proximity window (full mode C) | `bm25PhraseProximityStrategy({…,proximityK})` |

- `RANKING_STRATEGIES` — id → default instance (registry).
- `createStrategy(id, options)` — configured instance; **validates eagerly**
  (RangeError on bad k1/b/bonus/k at construction, not first query); unknown ids throw
  with the registry's message. Used by the experiment runner so recorded parameters and
  the instance that produced the numbers are one source of truth.
- `resolveStrategyParams(id, options)` — the fully-resolved parameter set
  (`{k1:1.2, b:0.75, …}` with defaults applied) written into run artifacts.

Defaults: `k1 = 1.2`, `b = 0.75`, `tf = raw`, `phraseBonus = 1.2`, `proximityK = 1.0`
(`DEFAULT_BM25`, `DEFAULT_TF_WEIGHTING`, `DEFAULT_PHRASE_BONUS`, `DEFAULT_PROXIMITY_K`).

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
- **Raw additive is intentional**: min-max normalization and weighted/RRF fusion are
  M4 — M2 measures each signal as it is, so ablations attribute changes cleanly.
- Ablation arms (both runnable today):
  - `bm25-phrase` vs `bm25` → phrase signal alone
  - `bm25-phrase-proximity --proximity-k 0` vs full mode C → proximity signal alone

## 6. What NOT is in scoring

`positiveQueryTerms()` strips NOT subtrees: `lung cancer NOT smoking` scores documents
on `lung`+`cancer` only, while boolean candidates still exclude `smoking` hits.
Combining them would make relevance scores depend on exclusion clauses (a doc's score
would drop for containing an excluded word — not a relevance judgment).

---

## 7. Hand-verified tests

Every formula has a hand-calculated fixture — no tolerance-only assertions:

| Suite | Fixture |
|---|---|
| `tests/ranking.test.ts` | 4-doc index with df/tf/dl designed for closed-form TF-IDF + BM25 checks; NOT-scoring; registry; `createStrategy`/`resolveStrategyParams` |
| `tests/phrase.test.ts` | mode C ordering flip fixture: bm25 ranks `alpha zeta beta` first, mode C flips to `gamma gamma gamma alpha beta` (window 2 vs 3) with exact scores |
| `tests/boolean.test.ts` | candidates that the scores sit on |

Reproduce: `npm test`.
