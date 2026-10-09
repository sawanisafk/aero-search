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
| **CQADupStack `cqadupstack-tierb`** | **default demo + evaluation corpus (Tier B)** | 147,742 docs (programmers + unix + tex), 4,854 queries | 8,522 judgments (evaluated per stack) | eval inputs yes; corpus via script |
| — per stack (`cqadupstack-programmers` / `-unix` / `-tex`) | individually evaluable Tier B stacks | 32,176 / 47,382 / 68,184 docs | 876 / 1,072 / 2,906 queries | eval inputs yes; corpus via script |
| **CQADupStack Tier C (`cqadupstack-tierc`)** | full 9-stack research config | 330,736 docs, 10,149 queries | 18,080 judgments (evaluated per stack) | eval inputs via `npm run corpus:cqadupstack -- --full`; corpus via script |
| BEIR SciFact | retired as primary — **baseline kept** (prior results + `static-v1` fixtures unaffected) | 5,183 docs, 1,109 queries | **test: 339 rows / 300 queries, grade 1** | eval inputs yes; corpus via script |

**CQADupStack provenance & verification** (`data/eval/cqadupstack.manifest.json`):

- Corpus + qrels: HTTP range fetch of individual members from BEIR's
  `cqadupstack.zip` (`public.ukp.informatik.tu-darmstadt.de`); queries: HuggingFace
  `BeIR/cqadupstack` rows API (the zip's `queries.jsonl` embeds duplicate bodies).
  Source revision and per-file SHA-256 recorded; in-memory validation (published
  counts, qrels↔queries equality, judged ⊆ corpus, no dup ids) before any write.
- Derived from the Stack Exchange data dump via BEIR (Thakur et al., EMNLP 2021);
  HF card lists CC-BY-SA-4.0. The original Melbourne host is unreachable — the exact
  CC BY-SA version must be verified before redistribution (recorded honestly).
- **Stack Exchange post ids collide across sites** → merged tiers prefix corpus ids
  with the stack (`unix:116498`); per-stack qrels stay on original ids. Merged-tier
  evals use the remapped copies `data/eval/cqadupstack-tierb-<stack>-qrels.tsv`.
- **Never aggregate metrics across datasets.** Each stack is evaluated against its own
  qrels; merged runs report one number per stack, not one global number.

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
6. **Unparseable queries (strict parser): 33 of 4,854** — unix 13/1,072,
   tex 20/2,906, programmers 0/876 — all ordinary titles where `(`/`"` are
   read as Boolean syntax (`(!)`, `"."`, stray `)`). The evaluation harness
   now runs the **strict-first lenient path** (`src/core/query/lenient.ts`,
   documented in SEARCH.md §1): each failure is repaired with a minimal
   position-targeted edit, so these queries rank for real instead of scoring
   zeros. Artifacts record every repair under `query_set.lenient_repairs`;
   any residual failures keep their category/stage/disposition under
   `query_set.parse_failures` (categories: `syntax`, `empty_query`,
   `unsupported_syntax`); internal engine errors are kept separately under
   `query_set.internal_errors` and never disguised as parse failures.
   Regression-tested for all 33 (`tests/query-lenient.test.ts`).
   The strict parser itself is unchanged (UI/API keep `400 QUERY_PARSE`).
7. **Cross-dataset numbers are not comparable.** MAP/NDCG on programmers vs unix vs
   tex reflect different collections and judgment densities; report per-stack values
   side by side, never averaged into a single "CQADupStack score".

## 7. Reproducing an experiment

```bash
# CQADupStack (default demo corpus, Tier B)
npm run corpus:cqadupstack                        # fetch + validate + merge programmers/unix/tex
npm run corpus:cqadupstack -- --full              # all 9 stacks (+ tierc merge)
npm run index:build -- --corpus cqadupstack-tierb
npm run eval:run -- --corpus cqadupstack-tierb --strategy bm25 --qrels data/eval/cqadupstack-tierb-unix-qrels.tsv --queries data/eval/cqadupstack-tierb-unix-queries.jsonl
npm run trace:sample                              # real per-stage Trace query artifact

# per-stack (independently evaluable; defaults resolve queries/qrels by corpus name)
npm run index:build -- --corpus cqadupstack-tex
npm run eval:run -- --corpus cqadupstack-tex --strategy bm25            # MAP@100: add --topk 100

# SciFact baseline (retired as primary; preserved for comparison)
npm run corpus:scifact                 # fetch + verify md5 + publish data/eval inputs
npm run index:build -- --corpus scifact
npm run eval:run -- --corpus scifact --strategy bm25            # mode B
npm run eval:run -- --corpus scifact --strategy bm25-phrase-proximity --proximity-k 0   # ablation
npm test                               # metrics golden tests
```

Each run writes `runs/<timestamp>-<corpus>-<strategy>.json` containing
`{experiment_id, timestamp, git{sha,clean,has_untracked}, corpus{hash,numDocs},
query_set{sha256,evaluated,parse_failures,internal_errors,lenient_repairs,zero_result_queries},
qrels{sha256,rows}, strategy{id,mode,params}, topk, k_values, metrics, latency_ms, wall_ms}`
— the evidence rule (DEVELOPMENT.md) applies verbatim: numbers in the report
must come from these files.

Query-disposition fields (added by the Plan A reporting patch; old artifacts
carry only `parse_failures` as `{queryId, code}` rows):

| Field | Meaning |
|---|---|
| `parse_failures[]` | non-internal query failures: `{queryId, corpus, text, code, category, stage, position, repairsApplied, disposition, retrievalExecuted}`; `category ∈ {syntax, empty_query, unsupported_syntax}` |
| `internal_errors[]` | non-`QueryParseError` exceptions: `{queryId, corpus, text, phase, message, disposition, retrievalExecuted}` — never merged into `parse_failures` |
| `lenient_repairs[]` | queries the lenient path had to edit: `{queryId, corpus, text, repairs:[{code, position, action, removed}]}` |
| `zero_result_queries` | `{count, queryIds}` — valid queries whose retrieval executed and returned nothing (not failures) |
