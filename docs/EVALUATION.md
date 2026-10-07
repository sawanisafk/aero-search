# Evaluation — Metrics, Corpora, Protocol

> What "works" means, numerically.
> Metrics implementation: `src/eval/` · Runner: `scripts/run-experiment.ts` ·
> Results: [EXPERIMENTS.md](EXPERIMENTS.md) · Query semantics: [SEARCH.md](SEARCH.md).

---

## 1. Metrics (`src/eval/metrics.ts`)

For a ranking `r₁…r_K`, relevance judgments `rel(d) ∈ {0,1,…}` (grade > 0 = relevant),
and `R` = number of relevant documents for the query:

| Metric | Definition | Notes |
|---|---|---|
| **P@K** | (# relevant in top K) / **K** | always divided by K, even for short runs — a system returning 1 hit in 1 slot is not P@1 = 1 unless K = 1 |
| **R@K** | (# relevant in top K) / R | R = 0 → 0 |
| **F1@K** | harmonic mean of P@K, R@K | 0 if either is 0 |
| **AP** | (1/R) · Σ_i rel(rᵢ) · P@i | over the full ranking; unjudged docs contribute 0 |
| **MAP** | mean of AP over queries | |
| **NDCG@K** | DCG@K / IDCG@K | gain `g = 2^grade − 1`, discount `1/log₂(rank+1)` (rank starts at 1); IDCG = 0 → 0 |

All hand-calculated golden tests: `tests/eval.test.ts` — e.g. ranked `d1 d2 d3 d4 d5`
with relevant {d2, d4, d5}: AP = (P@2 + P@4 + P@5)/3 = (½ + 2⁄4 + 3⁄5)/3 = 0.5333…,
asserted to 10 decimal places.

## 2. Protocol (`src/eval/evaluate.ts`)

- **Evaluation iterates the QRELS, not the run.** A query present in judgments but
  missing from the run (or unparseable) counts as an **empty ranking → all zeros**.
  Retrieval failures can never be hidden by skipping queries.
- Aggregation = unweighted mean over judged queries.
- Cutoffs default to `k ∈ {1, 5, 10, 100}` (configurable via `--k`).

## 3. Input formats (strict parsers, `src/eval/qrels.ts`)

| Format | Shape | Strictness |
|---|---|---|
| qrels TSV (BEIR) | header `query-id\tcorpus-id\tscore`, then rows | wrong column count / negative score / duplicate judgment → error with 1-based line number; unknown header → error |
| queries JSONL (BEIR) | one object per line: `_id`, `text` | non-JSON / non-object / missing fields → error with line number |

Corpus ids are **strings** end-to-end (qrels `31715818` ↔ corpus `_id`); numeric ids
are a BEIR detail we never reinterpret. The runner maps corpus ids ↔ internal docIds
through `data/index/<corpus>.ids.json` (line order of the source corpus, written by
`scripts/build-eval-index.ts`).

## 4. Query interpretation: disjunctive (bag-of-words)

Evaluation parses every query with `{ implicitOperator: 'or' }` — bare adjacency is OR.
This is the standard IR convention behind published BEIR/TREC BM25 baselines: a query
is a bag of words whose terms *jointly* describe the need; conjunctive retrieval of a
6-term sentence would demand all six terms in one document and collapse recall
(measured: strict-AND gave MAP 0.0033 on SciFact before the mode existed — same code,
same corpus). Explicit `AND`/`OR`/`NOT`/quotes in a query are honored as written in
either mode. The UI (M5) defaults to the conjunction mode; the option lives in
`parseQuery(text, {implicitOperator})`.

## 5. Corpora

| Corpus | Role | Size | Qrels | Committed? |
|---|---|---|---|---|
| `static-v1` | regression fixture (M1) + latency dev | 84 docs (Gutenberg, public domain) | — | **yes** (corpus + manifest) |
| `20newsgroups-bydate` | latency/retrieval dev | 18,846 docs, 20 groups | **none — never used for metrics** | no (fetch script; manifest committed) |
| **BEIR SciFact** | formal evaluation | 5,183 docs, 1,109 queries | **test: 339 rows / 300 queries, grade 1** | eval inputs yes (queries, qrels, manifest); corpus via script |

**SciFact provenance & verification** (`data/eval/scifact.manifest.json`):

- URL: `https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip`
- MD5 checked against the value **published by the BEIR authors**
  (`5f7d1de60b170fc8027bb7898e2efca1`) before extraction; actual SHA-256 recorded
  (`536e1444…e0165`); every re-fetch must reproduce it.
- License: no license file in the archive; GitHub `allenai/scifact` = NOASSERTION;
  BEIR code is Apache-2.0. Used for research/evaluation with citation
  (Wadden et al., NAACL 2020). Recorded honestly in the manifest — no invented grant.
- 20 Newsgroups: figshare item 5975967; archive SHA-256 recorded; no explicit license
  on the source page (manifest says so); Lang, ICML 1995 attribution.

## 6. Known caveats (stated, not hidden)

1. **Binary judgments.** Every SciFact test judgment is grade 1 → NDCG's gain function
   degenerates to binary; graded-NDCG behavior is covered by unit tests, not by this
   corpus.
2. **One unparseable query.** SciFact query `42` contains `(+)-`: parentheses around
   punctuation lex to an empty group → `EMPTY_GROUP` (correct: the index holds no `+`
   token). It scores zeros; recorded in every artifact under
   `query_set.parse_failures` (2 of 1,109 in the latency benchmark — same query plus
   one other punctuation-paren case).
3. **Train split unused.** 919 train judgments exist in the corpus but evaluation uses
   the test split only (manifest records both).
4. **`boolean` strategy is a floor baseline**: mode BOOL orders candidates by docId
   with all scores equal — its candidate set is the full OR union (retrieval coverage
   is real), but the *order* is arbitrary, so relevant docs rarely land in the top 100
   (measured R@100 = 0.059). Its MAP measures chance-level ordering, not retrieval
   quality.
5. **20 Newsgroups feeds no metric numbers** — it has no judgments. It exists for
   latency and retrieval-path development only.

## 7. Reproducing an experiment

```bash
npm run corpus:scifact                 # fetch + verify md5 + publish data/eval inputs
npm run index:build -- --corpus scifact
npm run eval:run -- --corpus scifact --strategy bm25            # mode B
npm run eval:run -- --corpus scifact --strategy bm25-phrase-proximity --proximity-k 0   # ablation
npm test                               # metrics golden tests
```

Each run writes `runs/<timestamp>-<corpus>-<strategy>.json` containing
`{experiment_id, timestamp, git{sha,clean,has_untracked}, corpus{hash,numDocs},
query_set{sha256,evaluated,parse_failures}, qrels{sha256,rows}, strategy{id,mode,params},
k_values, metrics, latency_ms, wall_ms}` — the evidence rule (DEVELOPMENT.md) applies
verbatim: numbers in the report must come from these files.
