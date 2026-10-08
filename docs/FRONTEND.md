# Frontend — the Aero desktop

`web/` is an npm workspace: React 19 + Vite 8 + TypeScript (strict, same
flags as the root). It is a **pure client of the REST API** — no ranking
logic, no engine imports; every number on screen comes from a response body.

```bash
npm run web:dev     # Vite dev server → http://localhost:5173 (proxies /api + /health → :3000)
npm run api         # API must run alongside in dev
npm run web:test    # Vitest + Testing Library (jsdom)
npm run web:build   # tsc --noEmit && vite build → web/dist
npm run build && npm start   # production: Fastify serves web/dist itself
```

## Layout

```
web/src
├── main.tsx              StrictMode entry, imports aero.css
├── App.tsx               window manager + desktop shell (taskbar, start menu,
│                         icons, clock) — owns geometry/z-order, never fetches
├── App.test.tsx          desktop behavior tests (fetch stubbed)
├── api/
│   ├── types.ts          typed mirror of the API contract (SearchResponse, …)
│   └── client.ts         one function per endpoint + single error path
│   └── client.test.ts    URL building + error mapping
├── components/
│   ├── Icons.tsx         inline SVG icons (no icon library, no emoji)
│   └── SignalBars.tsx    per-signal contribution bars ("why did this rank here")
├── windows/
│   ├── AeroWindow.tsx    frosted-glass chrome: drag, focus, min/max/close
│   ├── SearchWindow.tsx  query bar, options, results, diagnostics drawer
│   ├── DocWindow.tsx     document detail: metadata, matched terms, text
│   ├── EvaluationWindow.tsx  committed experiments (read-only)
│   ├── StatusWindow.tsx  live index/strategy/PageRank/crawl status
│   └── SettingsWindow.tsx    /api/config + endpoint reference + about
├── styles/aero.css       the whole design system (tokens → desktop → windows →
│                         results → cards → taskbar → responsive)
└── test/setup.ts         jest-dom matchers + explicit RTL cleanup
```

## The Aero shell

- **Desktop** (`.desktop`) — CSS wallpaper (layered gradients), desktop icons
  (Search / Evaluation / System Status / Settings), brand block.
- **Taskbar** — Start orb (toggles the menu), one button per open window
  (click active → minimize, click other → focus/restore; minimized buttons
  get `.minimized`), live clock.
- **Start menu** — same four views + footer; `Escape` or clicking the
  desktop closes it.
- **Windows** (`.aero-window`) — draggable title bar (pointer capture,
  clamped to the viewport), double-click toggles maximize, focused window
  gets the glass highlight, z-order managed by `App`.

`App` keeps `WinState[] = { key, kind, title, x, y, w, h, z, minimized,
maximized, payload }`. Opening a view twice focuses the existing window;
document windows are keyed `doc:<corpus>:<id>` so re-clicking a result
re-focuses and refreshes its query context. Minimized windows unmount
(state is rebuilt on restore — the demo query re-runs).

## Search window

- Query bar + option strip: corpus, strategy (unavailable ones disabled with
  their reason), k, implicit AND/OR, fuzzy toggle + edit radius.
- Auto-demo query `stem cells` on first mount so the window is never empty.
- Results: rank, title (click → document window), id/source line, snippet
  with `<mark>` highlights from the server's character offsets, score badge,
  **SignalBars** per breakdown component, details button.
- Status line: shown/candidates, total ms, strategy id + engine id + mode +
  corpus pills, gold `fuzzy` pill when expansion fired.
- Fuzzy note box: `wonderlan → [wonderland]` chips straight from `meta.fuzzy`.
- Diagnostics drawer (`<details>`): parsed AST, analyzed/scoring terms
  (fuzzy-expanded chips highlighted), per-stage timing table, strategy
  params, fuzzy caps.
- States: spinner while loading, error box with the server's `error.code`,
  empty state that suggests fuzzy recovery.

## The other windows

| Window | Source | Highlights |
|---|---|---|
| Document | `GET /api/documents/...` | metadata grid incl. live PageRank, matched-term table (tf/df), phrase chips, serif text pane |
| Evaluation | `GET /api/benchmarks` | read-only: quality-run table (MAP/nDCG/R@100 with locked values e.g. **0.6436**), fuzzy arms, per-stage latency, PageRank convergence cards |
| Status | `GET /api/stats?corpus=` | live cards: index sizes, strategy dots, PageRank block, fuzzy defaults, crawl manifest, corpus switcher |
| Settings | `GET /api/config` | defaults, corpora, strategies, fuzzy caps, REST endpoint table, about |

## Error path

`client.ts` funnels every failure into `ApiError { status, code, message }`:

- non-2xx → the server's `{ error: { code, message } }` envelope;
- fetch rejection → `NETWORK` ("is npm run api running?");
- non-JSON / empty body → `BAD_RESPONSE`.

Windows render it as `<div class="error-box" role="alert">CODE message</div>` —
the UI never crashes on a shape it does not understand.

## Responsive & accessibility

- ≤ 760 px: windows go full-viewport, icons row-wrap, brand/clock hidden.
- Every window control is a real `<button>` with an `aria-label`
  (`Minimize Aero Search`…); results are a semantic `<ol>`; errors use
  `role="alert"`; the document-title link is keyboard-operable (Enter).

## Tests

15 web tests (`npm run web:test`, vitest 5 + jsdom + Testing Library):

- `api/client.test.ts` (10) — URL construction/encoding, envelope →
  `ApiError`, network → `NETWORK`, bad/empty body → `BAD_RESPONSE`.
- `App.test.tsx` (5) — boot with results, Evaluation shows the locked
  0.6436, document open with matched terms, Status cards, minimize/restore
  via the taskbar. `fetch` is stubbed with contract-shaped fixtures;
  `src/test/setup.ts` registers explicit RTL cleanup (auto-cleanup needs
  vitest globals, which we do not enable).

The server-side contract stays authoritative: `tests/api.test.ts` (26)
validates the real payloads these fixtures mirror.
