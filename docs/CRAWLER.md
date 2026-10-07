# Crawler — Aero Search

As-built reference for `src/crawler/` (M3). Design rationale: [ARCHITECTURE §7](ARCHITECTURE.md).
Deliberate scope limits: the crawler is a **controlled-corpus instrument**, not a general web crawler.

---

## Pipeline (as implemented)

```
seed list → Frontier (BFS by depth, in-memory, PG-backed rows)
  → normalizeUrl (one canonical string per page)
  → allowlist check (empty allowlist = refuse to start, ADR-006)
  → robots.txt (cached per origin; disallow → skip + log)
  → per-host politeness delay (robots Crawl-delay overrides config)
  → undici fetch (10 s timeout, redirect cap 5, transport retry + backoff,
                  accept-encoding: identity)
  → non-2xx → failure recorded as data
  → MIME gate: text/html + application/xhtml+xml only
  → content hash (sha1 of exact bytes) → byte-exact duplicate detection
  → cheerio extraction: title, meta, body text, outlinks (+<base href>)
  → upsert document → insert link edges → enqueue children (depth < max)
```

Entry points: `Crawler.run({ resume? })` (orchestrator), `scripts/crawl.ts` (CLI over
`configs/crawl.json`).

## URL normalization (`url.ts`)

One canonical string per page so frontier, `urls` table, and document identity agree:
http/https only · relative URLs resolved against the fetching page · fragment and userinfo
dropped · empty query markers dropped · host lowercased · default ports (80/443) removed ·
query parameters sorted lexicographically.

Allowlist patterns: exact host, `*.suffix` (suffix + subdomains), `*`. Empty allowlist
throws at construction time.

## robots.txt (`robots.ts`)

Hand-written RFC 9309 subset — no dependency:

- Group parsing with `User-agent` / `Allow` / `Disallow` / `Crawl-delay`; rules before any
  user-agent line apply to `*`.
- Match: longest-match wins; on equal length, **Allow wins**; `*` and `#` handled.
- `robotsForResponse`: 2xx parses; 404/other → allow-all (RFC 9309 §2.3.1.3).
- Network failure → allow-all (**fail-open**, emitted as a `robots-fetched` event —
  logged as data, never silently swallowed).
- One fetch per origin, cached for the run; `Crawl-delay` overrides `delayMs` for that host.

## Politeness & budgets (`politeness.ts`)

- `HostScheduler`: per-host `delayMs` between page fetches (robots fetch itself waits the
  remaining politeness gap — no burst at crawl start).
- Hard budgets (constructor-validated): `maxPages` page-fetch attempts (robots fetches
  excluded — bounded by distinct hosts), `maxDepth`, non-empty `allowlist`.
- Determinism: `now()`/`sleep()` are injected — fixture tests assert the exact politeness
  schedule (`7 × 30 ms` sleeps, `durationMs = 210`) with a virtual clock.

## Deduplication (three layers)

| Layer | Catches | Mechanism |
|---|---|---|
| URL normalization | same page, different spelling | canonical string is the frontier key |
| Content hash | different URLs, byte-identical body | sha1 over raw bytes; duplicates stored with `duplicate_of` (excluded from index) |
| Intra-batch `accept()` | same URL discovered twice in one batch | frontier `accept()` before enqueue |

Observed live: `http://info.cern.ch/` vs `https://info.cern.ch/` → one content hash, one
duplicate row.

## Persistent state & resume

Every transition is a row update (`pending → fetched | failed | skipped | duplicate`) —
the crawl is restartable at any point:

- `Crawler.run({ resume: true })` reloads **all** rows: processed URLs sealed against
  re-add (`Frontier.markSeen`), pending rows requeued in BFS order.
- A completed crawl resumed performs **zero** network requests — not even a robots
  re-check (frontier empty → the run loop exits before any host contact).
- Failed URLs are recorded, not retried in-run (retry policy is a future knob).

## Failure handling

Failures are data, not exceptions: `markFailed(url, detail, httpStatus)` with detail
(`http 404`, transport message). In the live crawl 22 failures were recorded (2 real 404s
+ 20 historical `:8001` gateway timeouts) and surfaced in the final report.

## Tests

| Suite | Covers |
|---|---|
| `tests/url.test.ts` | normalization rules, allowlist patterns |
| `tests/robots.test.ts` | group semantics, longest-match, allow-tie, crawl-delay, fail-open |
| `tests/extract.test.ts` | title/meta/body/outlinks, `<base href>`, boilerplate |
| `tests/frontier.test.ts` | BFS order, depth, seen-set, markSeen |
| `tests/crawler.test.ts` | full pipeline vs fixture site (virtual clock), all budget counters |
| `tests/crawl-e2e.test.ts` | real embedded PG: partial crawl → resume → idempotent re-run → index build |

Shared fixture: `tests/helpers/fixture-server.ts` (redirects, dupes, blocked robots path,
404, oversize, off-allowlist targets).

## Limitations (accepted, documented)

- No JavaScript rendering (`Fetcher` interface keeps `BrowserFetcher` open — ADR-007).
- No crawl-wide byte budget yet; per-doc body cap enforced at the fetcher.
- Text bodies stay in PostgreSQL; the index stores title+text only.

## M3 controlled crawl (evidence)

Config: `configs/crawl.json` (seed `https://info.cern.ch/`, allowlist `info.cern.ch`,
maxPages 100, maxDepth 3, delayMs 1500, robots respected):

| Metric | Value |
|---|---|
| pagesFetched | 100 (budget hit) |
| documents stored / indexable | 78 / 77 |
| duplicates | 1 (scheme variant) |
| failed (recorded) | 22 (2× 404, 20× gateway timeouts) |
| link graph | 796 edges, 74 sources, 422 targets |
| pending (resumable) | 62 |
| robots.txt | 404 → allow-all (RFC), 0 skips |

Manifest (committed): `data/eval/crawled.manifest.json` — corpus hash `4e5bf3b0…`,
config sha256, git SHA, counts. Index: `data/index/crawled.aidx` (77 docs, 4151 terms,
0.27 MB, built in 372 ms). Latency: `benchmarks/results/2026-10-07T17-12-21-990Z-query-benchmark.json`
(BM25 avg 0.089 ms over 60 derived queries).
