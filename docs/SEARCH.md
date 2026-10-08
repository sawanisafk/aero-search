# Search — Query Language & Retrieval

> How a raw query string becomes an ordered list of documents.
> Ranking formulas: [RANKING.md](RANKING.md) · Evaluation semantics: [EVALUATION.md](EVALUATION.md) ·
> Index structures: [INDEXING.md](INDEXING.md).

---

## 1. Query syntax

Implemented by `src/core/query/` (lexer + recursive-descent parser).

```
orExpr   := andExpr ( OR andExpr )*
andExpr  := notExpr ( AND? notExpr )*        // explicit AND or bare adjacency
notExpr  := NOT notExpr | primary
primary  := '(' orExpr ')' | PHRASE | TERM
PHRASE   := '"' words '"'                     // quoted, ordered
```

| Element | Syntax | Notes |
|---|---|---|
| term | `biomaterials`, `alpha-beta` | split on punctuation; analyzed like index terms |
| phrase | `"neural network"` | exact consecutive positions (§4) |
| AND | `a AND b` | **uppercase only** — `a and b` is three terms |
| OR | `a OR b` | uppercase only |
| NOT | `NOT a` | prefix, binds to one operand |
| grouping | `(a OR b) c` | parentheses override precedence |
| adjacency | `a b` | implicit operator — see below |

**Precedence:** `NOT` > `AND` > `OR` (Boolean standard). `a OR b AND c` ≡ `a OR (b AND c)`.
Binary operators are left-associative.

**Implicit operator (two modes):**

| Mode | `a b` means | Used by |
|---|---|---|
| `'and'` (default) | `a AND b` | UI / general search — free text is a conjunction |
| `'or'` | `a OR b` | evaluation + latency runs — standard bag-of-words IR convention (BEIR/TREC BM25 baselines) |

```ts
parseQuery('lung cancer');                                // AND (default)
parseQuery('lung cancer', { implicitOperator: 'or' });     // OR (evaluation mode)
```

Explicit `AND`/`OR`/`NOT`, quotes and parentheses behave identically in both modes;
the option only changes what bare adjacency does. See `parseQuery` in
`src/core/query/parser.ts` and the rationale in [EVALUATION.md §4](EVALUATION.md).

### Parse errors

Failures are typed `QueryParseError { code, position, message }` — never bare strings
(`src/core/query/errors.ts`). Closed code set:

| Code | Thrown when | Example |
|---|---|---|
| `EMPTY_QUERY` | no searchable words | `"... !!!"` |
| `UNBALANCED_QUOTE` | odd number of `"` | `ok "unclosed` |
| `EMPTY_PHRASE` | quotes with no words | `a "" b` |
| `UNBALANCED_PAREN` | `(` without `)` (or stray `)`) | `(a` |
| `EMPTY_GROUP` | `()` or a group that lexes empty | `()` , `(+)-` |
| `MISSING_OPERAND` | operator without an operand | `a AND` |
| `UNEXPECTED_TOKEN` | reserved for unreachable lexer/parser states | — |

`position` is a character offset into the raw string so a UI can underline the fault.
Note the interaction with indexing: punctuation is not indexed, so a group containing
only punctuation (`(+)`) is genuinely empty — the error mirrors what the index holds.

---

## 2. Query analysis (index-time = query-time)

`analyzeQuery(parsed, analysis)` (`src/core/retrieval/analyze-query.ts`) walks the AST and
maps each leaf through **the same analyzer used at index time**: normalize (NFKC,
lowercase) → tokenize → stop-word removal → Porter stem. A leaf expands to:

- exactly one term → `{ kind: 'term', terms: [t] }`
- a phrase leaf whose words survive analysis → ordered analyzed terms
- a term that stops-words/stems away entirely → `terms: []` (**empty leaf**)

After analysis, fuzzy expansion (§6) may annotate a term leaf with dictionary
variants: `{ kind: 'term', terms: [t, v1, v2, …] }` — evaluated as their
union; a plain single-word leaf keeps the fast path.

Set semantics of empty leaves (matters for NOT):

- empty leaf = ∅ (matches no documents); `NOT ∅` = universe — evaluating `NOT` against
  ∅ would otherwise silently return everything or nothing depending on implementation.
- `positiveQueryTerms(analyzed)` returns deduped terms of the query **excluding NOT
  subtrees** — retrieval keeps NOT candidates, scoring ignores them (a document is
  rewarded for what the query asked for, never penalized for what it excluded).

---

## 3. Boolean candidate retrieval

`retrieveBoolean(reader, parsed)` (`src/core/retrieval/boolean.ts`) evaluates the raw
AST against postings as **set algebra over sorted `Uint32Array` docIds**:

| Operator | Implementation | Cost |
|---|---|---|
| AND | `intersect(a, b)` — merge join | O(\|a\|+\|b\|) |
| OR | `union(a, b)` — merge join | O(\|a\|+\|b\|) |
| NOT | `difference(universe, a)` | O(N) once, cached universe |
| term | postings `docIds()` view | O(df) |

Candidates are the **substrate every ranking strategy scores** — strategies never
re-do boolean logic (see [RANKING.md](RANKING.md)). Cost tracks query terms' df, not N.

---

## 4. Phrase retrieval (positional, not plain AND)

`matchPhrase(reader, terms)` (`src/core/retrieval/phrase.ts`) — two stages:

1. **Doc-list filter:** intersect the df-lists of all phrase terms (a doc missing any
   term cannot match).
2. **Positional verification:** for each surviving doc, collect each term's position
   run (binary search `containsPosition`) and check for some `p` where every term
   occurs at `p, p+1, …` — i.e. consecutive **after analysis**.

Properties (all tested in `tests/phrase.test.ts`):

- *`"red the fox"` matches `red fox`* — stop-words consume no position (dense
  positions), because the phrase's own words are checked in order after analysis.
- single-word phrase `"quantum"` degrades to a term lookup (no positional work).
- `"state of the art"` → analyzed to `state of the art` ordered terms; adjacency is
  over analyzed positions, so morphological variants inside the phrase still match
  (stemmed identically at index and query time).

---

## 5. Proximity signal

`minimumWindow(reader, terms, docId)` (`src/core/retrieval/proximity.ts`) finds the
smallest window of positions containing **all** query terms in one document
(two-pointer sweep over the merged sorted position lists), then

```
proximityScore = k / (1 + (window − |q|))        window ≥ |q|, |q| = #query terms
```

- `window == |q|` (terms adjacent) → score `k` (max); larger windows decay smoothly.
- fewer than 2 query terms → 0 (a window over one term carries no signal).
- It is a **scoring-only** signal: it never adds/removes candidates — boolean
  retrieval is unaffected by proximity (ablation `--proximity-k 0` proves it).

---

## 6. Fuzzy retrieval (bounded edit distance)

An absent query term — a typo (`seach`) or a genuine OOV word — silently
contributes ∅ to Boolean retrieval. `expandFuzzyQuery(reader, analyzed, opts)`
(`src/core/retrieval/fuzzy.ts`) recovers it **at query time**: no index
changes, the M1 format freeze stands.

**What expands, what never does**

| Leaf / node | Behavior |
|---|---|
| term **absent** from the dictionary | expanded (the whole point) |
| term present in the dictionary | never expanded — exact match wins |
| phrase leaf | untouched — positional matching stays exact |
| term under `NOT` | untouched — a negated typo must not exclude documents wrongly |
| nothing to do | the *identical* tree is returned (identity pass-through) |

**Two radii, both bounded**

- `maxEdits = 1` (default): the ~27·len variants (delete / substitute / insert
  over `a–z`) are generated directly and probed against the reader's O(1) term
  hash.
- `maxEdits = 2` (opt-in): a **bounded dictionary scan** — length ±2 filter,
  then `boundedEditDistance(.., 2)` with row-min early exit. Only runs when
  distance-1 did not already fill the per-term cap (closer terms outrank
  farther ones anyway) and only for terms of length ≥ 5. (The first
  implementation composed edit1×edit1 sets: quadratic, measured 1.55 s worst
  case in the bench — replaced by the scan, which is faster and complete.)

**Strict limits** (validated by `resolveFuzzy`, all recorded in artifacts):
`maxEdits ∈ {1, 2}`, `minTermLength` 3, `maxExpansionsPerTerm` 10,
`maxFuzzyTermsPerQuery` 10, `maxExpansionsPerQuery` 20. Candidates are ordered
(distance asc → df desc → term asc) — deterministic across runs.

**Integration — one transformation, both layers.** An expanded leaf becomes
`[original, …variants]`; `evalAnalyzed` evaluates a multi-term leaf as their
**union**, and `positiveQueryTerms` walks every leaf term — so candidate
retrieval *and* scoring (BM25 with each variant's real idf) see the
alternatives from a single rewrite. `runQuerySet(..., fuzzy)` performs the
expansion inside the timed query loop and aggregates the cap counters.

**Measured (M4-C, EXPERIMENTS.md §4):** a single-character typo costs −0.0771
MAP on SciFact; k=1 expansion recovers 93.5% of that gap at +0.13 ms/query,
while k=2 recovers less (63.9%) at higher cost — reported as measured.

---

## 7. End-to-end pipeline (implemented)

```
raw text
  → parseQuery(text, {implicitOperator})         // AST, typed errors
  → analyzeQuery(ast, reader.analysis)           // shared analyzer
  → [expandFuzzyQuery(reader, analyzed, opts)]   // optional, absent terms only
  → retrieveBoolean / retrieveAnalyzed           // candidates (set algebra)
  → strategy.rank(reader, analyzed, candidates)  // ScoredDoc[] (RANKING.md)
  → sort: score desc, docId asc → slice top-K → map to corpus ids
```

`scripts/lib/retrieval-run.ts::runQuerySet` runs exactly this per query, times it,
and records unparseable queries as failures (they score zeros in evaluation — never
dropped silently).

---

## 8. Tests

| Suite | Covers |
|---|---|
| `tests/query.test.ts` | lexer, both implicit-operator modes, precedence, parens, phrases, every error code + position |
| `tests/boolean.test.ts` | set ops, `analyzeQuery` (incl. empty leaves), retrieval over a built index |
| `tests/phrase.test.ts` | positional matching vs plain-AND counterexamples, stop-word gaps, windows, mode C fixtures |
| `tests/fuzzy.test.ts` | hand-computed edit distances + sentinels, variant generation, typo recovery (`seach` → `search`), exact-match/phrase/NOT exclusions, every strict cap, determinism, identity pass-through, scoring integration |
