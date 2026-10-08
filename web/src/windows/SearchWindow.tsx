/**
 * SearchWindow — the primary Aero window.
 *
 * WHAT: query box + option strip (corpus/strategy/k/fuzzy/implicit),
 *   ranked results with highlighted snippets and per-signal bars, fuzzy
 *   recovery feedback, pagination, and a diagnostics drawer (parsed AST,
 *   analyzed terms, timing table, strategy params).
 * CONNECTS: all data via web/src/api/client.ts — no engine logic here.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, api } from '../api/client';
import type { ConfigResponse, SearchResponse, Snippet } from '../api/types';
import { SignalBars } from '../components/SignalBars';
import { SearchIcon } from '../components/Icons';

interface Opts {
  corpus: string;
  strategy: string;
  k: number;
  fuzzy: boolean;
  fuzzyEdits: 1 | 2;
  implicit: 'and' | 'or';
}

const DEFAULT_OPTS: Opts = {
  corpus: 'scifact',
  strategy: 'bm25',
  k: 10,
  fuzzy: false,
  fuzzyEdits: 1,
  implicit: 'or',
};

function SnippetText({ snippet }: { snippet: Snippet }): React.JSX.Element {
  const parts: ReactNode[] = [];
  let cursor = 0;
  snippet.highlights.forEach((h, i) => {
    const start = Math.max(cursor, h.start);
    if (start > cursor) parts.push(snippet.text.slice(cursor, start));
    parts.push(
      <mark className="hl" key={`${h.start}-${i}`}>
        {snippet.text.slice(start, h.end)}
      </mark>,
    );
    cursor = Math.max(cursor, h.end);
  });
  parts.push(snippet.text.slice(cursor));
  return <>{parts}</>;
}

function fmt(n: number, digits = 4): string {
  return n.toFixed(digits);
}

export function SearchWindow({
  onOpenDoc,
}: {
  onOpenDoc: (corpus: string, id: string, q: string) => void;
}): React.JSX.Element {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [input, setInput] = useState('');
  const [opts, setOpts] = useState<Opts>(DEFAULT_OPTS);
  const [submittedQ, setSubmittedQ] = useState<string | null>(null);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const defaultsApplied = useRef(false);

  const run = useCallback(
    async (q: string, o: Opts, page: number): Promise<void> => {
      if (q.trim().length === 0) return;
      setLoading(true);
      setError(null);
      try {
        const res = await api.search({
          q,
          page,
          k: o.k,
          strategy: o.strategy,
          corpus: o.corpus,
          fuzzy: o.fuzzy,
          fuzzyEdits: o.fuzzyEdits,
          implicit: o.implicit,
        });
        setData(res);
        setSubmittedQ(q);
      } catch (e) {
        setData(null);
        setError(
          e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', String(e)),
        );
        setSubmittedQ(q);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Load runtime configuration (strategies, corpora, caps).
  useEffect(() => {
    let alive = true;
    void api
      .config()
      .then((c) => {
        if (!alive) return;
        setConfig(c);
        if (!defaultsApplied.current) {
          defaultsApplied.current = true;
          setOpts((o) => ({ ...o, corpus: c.defaultCorpus, strategy: c.defaultStrategy, k: c.defaultK }));
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', String(e)));
      });
    return () => {
      alive = false;
    };
  }, []);

  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Demo default: show a populated window immediately.
  useEffect(() => {
    void run('stem cells', optsRef.current, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-run when options change (query stays the same) or when defaults arrive.
  const firstRunRef = useRef(true);
  useEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false;
      return;
    }
    if (submittedQ !== null) void run(submittedQ, opts, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts, config]);

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    void run(input, opts, 1);
  };

  const goto = (page: number): void => {
    if (submittedQ !== null) void run(submittedQ, opts, page);
  };

  const strategies = config?.strategies ?? [];
  const corpora = config?.corpora ?? [];
  const meta = data?.meta;

  return (
    <div>
      <form className="search-bar" onSubmit={submit}>
        <input
          className="aero-input search-input"
          type="search"
          placeholder="Search the index — e.g. stem cells, p value, coffee"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="search query"
        />
        <button className="aero-button primary" type="submit" disabled={loading}>
          {loading ? <span className="spinner" aria-hidden="true" /> : <SearchIcon size={16} />}
          {' Search'}
        </button>
      </form>

      <div className="search-options">
        <label className="field">
          corpus
          <select
            className="aero-select"
            value={opts.corpus}
            onChange={(e) => setOpts({ ...opts, corpus: e.target.value })}
            disabled={config === null}
          >
            {(corpora.length > 0 ? corpora : [opts.corpus]).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          strategy
          <select
            className="aero-select"
            value={opts.strategy}
            onChange={(e) => setOpts({ ...opts, strategy: e.target.value })}
            disabled={config === null}
          >
            {strategies.map((s) => (
              <option key={s.id} value={s.id} disabled={!s.available} title={s.reason}>
                {s.label}
                {s.available ? '' : ' (unavailable)'}
              </option>
            ))}
            {strategies.length === 0 && <option value={opts.strategy}>{opts.strategy}</option>}
          </select>
        </label>
        <label className="field">
          k
          <select
            className="aero-select"
            value={opts.k}
            onChange={(e) => setOpts({ ...opts, k: Number(e.target.value) })}
          >
            {[5, 10, 20, 50].map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          implicit
          <select
            className="aero-select"
            value={opts.implicit}
            onChange={(e) => setOpts({ ...opts, implicit: e.target.value as 'and' | 'or' })}
          >
            <option value="or">OR (default)</option>
            <option value="and">AND</option>
          </select>
        </label>
        <label className="aero-check">
          <input
            type="checkbox"
            checked={opts.fuzzy}
            onChange={(e) => setOpts({ ...opts, fuzzy: e.target.checked })}
          />
          fuzzy recovery
        </label>
        <label className="field">
          edits
          <select
            className="aero-select"
            value={opts.fuzzyEdits}
            disabled={!opts.fuzzy}
            onChange={(e) => setOpts({ ...opts, fuzzyEdits: Number(e.target.value) as 1 | 2 })}
          >
            <option value={1}>≤ 1</option>
            <option value={2}>≤ 2</option>
          </select>
        </label>
      </div>

      {error !== null && (
        <div className="error-box" role="alert">
          <span className="code">{error.code}</span>
          {error.message}
        </div>
      )}

      {meta !== undefined && meta.fuzzy.expansions.length > 0 && (
        <div className="note-box">
          <strong>Fuzzy recovery:</strong> {meta.fuzzy.expansions.length} absent term
          {meta.fuzzy.expansions.length === 1 ? '' : 's'} expanded at edit distance ≤{' '}
          {meta.fuzzy.edits} —{' '}
          <span className="chip-row">
            {meta.fuzzy.expansions.map((x) => (
              <span className="chip fuzzy" key={x.term}>
                {x.term} → {x.variants.join(', ')}
              </span>
            ))}
          </span>
        </div>
      )}

      {meta !== undefined && data !== null && (
        <div className="statusline">
          <span>
            <strong>{data.results.length}</strong> shown / {meta.totalCandidates} candidates
          </span>
          <span>
            <strong>{fmt(meta.latencyMs, 2)} ms</strong> total
          </span>
          <span className="pill">{meta.strategyDetail.id}</span>
          <span className="pill gray" title="engine-internal strategy id + params">
            {meta.strategyDetail.engineId}
          </span>
          <span className="pill gray">{meta.strategyDetail.mode}-mode</span>
          <span className="pill gray">{meta.corpus}</span>
          {meta.fuzzyApplied && <span className="pill gold">fuzzy</span>}
        </div>
      )}

      {loading && data === null && (
        <div className="loading-row">
          <span className="spinner" /> querying the index…
        </div>
      )}

      {data !== null && data.results.length === 0 && !loading && (
        <div className="empty-state">
          <p>
            No documents matched <strong>“{data.query}”</strong> on corpus{' '}
            <strong>{meta?.corpus}</strong>.
          </p>
          {!opts.fuzzy && (
            <p className="small">
              Tip: enable <em>fuzzy recovery</em> — absent terms are expanded with bounded edit
              distance before retrieval.
            </p>
          )}
        </div>
      )}

      <ol className="results">
        {(data?.results ?? []).map((hit) => (
          <li className="result-card" key={hit.docId}>
            <div className="result-head">
              <span className="result-rank">#{hit.rank}</span>
              <div className="result-title">
                <a onClick={() => onOpenDoc(meta!.corpus, hit.docId, data!.query)} role="link" tabIndex={0}
                   onKeyDown={(e) => { if (e.key === 'Enter') onOpenDoc(meta!.corpus, hit.docId, data!.query); }}>
                  {hit.title}
                </a>
                <div className="result-url">
                  <span className="id">{hit.docId}</span>
                  <span>· {hit.source}</span>
                  {hit.url !== null && (
                    <a href={hit.url} target="_blank" rel="noreferrer">
                      source ↗
                    </a>
                  )}
                </div>
              </div>
            </div>
            {hit.snippet !== null && (
              <p className="result-snippet">
                <SnippetText snippet={hit.snippet} />
              </p>
            )}
            <div className="result-foot">
              <span className="score-badge" title="strategy score">
                {hit.score.toFixed(4)}
              </span>
              <SignalBars signals={hit.signals} />
              <button
                className="aero-button small"
                onClick={() => onOpenDoc(meta!.corpus, hit.docId, data!.query)}
              >
                details
              </button>
            </div>
          </li>
        ))}
      </ol>

      {meta !== undefined && meta.totalPages > 1 && (
        <div className="pager">
          <button className="aero-button small" disabled={meta.page <= 1} onClick={() => goto(meta.page - 1)}>
            ◀ prev
          </button>
          <span className="info">
            page {meta.page} / {meta.totalPages}
          </span>
          <button
            className="aero-button small"
            disabled={meta.page >= meta.totalPages}
            onClick={() => goto(meta.page + 1)}
          >
            next ▶
          </button>
        </div>
      )}

      {meta !== undefined && data !== null && (
        <details className="diagnostics">
          <summary>diagnostics — parsed query, terms, timing, signals</summary>
          <div className="diag-body">
            <div className="section-title">query analysis</div>
            <table className="kv-table">
              <tbody>
                <tr>
                  <th>implicit operator</th>
                  <td className="num">{meta.diagnostics.implicitOperator}</td>
                </tr>
                <tr>
                  <th>analyzed terms</th>
                  <td>
                    <span className="chip-row">
                      {meta.diagnostics.analyzedTerms.map((t) => (
                        <span className="chip" key={t}>
                          {t}
                        </span>
                      ))}
                    </span>
                  </td>
                </tr>
                <tr>
                  <th>scoring terms</th>
                  <td>
                    <span className="chip-row">
                      {meta.diagnostics.positiveTerms.map((t) => (
                        <span className={`chip${meta.expandedTerms.includes(t) ? ' fuzzy' : ''}`} key={t}>
                          {t}
                        </span>
                      ))}
                    </span>
                  </td>
                </tr>
                <tr>
                  <th>parsed AST</th>
                  <td>
                    <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                      {JSON.stringify(meta.diagnostics.parsed, null, 1)}
                    </pre>
                  </td>
                </tr>
              </tbody>
            </table>

            <div className="section-title">pipeline timing (ms)</div>
            <table className="kv-table">
              <tbody>
                {Object.entries(meta.timing).map(([stage, ms]) => (
                  <tr key={stage}>
                    <th>{stage.replace(/Ms$/, '')}</th>
                    <td className="num">{ms.toFixed(3)}</td>
                  </tr>
                ))}
                <tr>
                  <th>total</th>
                  <td className="num">{meta.latencyMs.toFixed(3)}</td>
                </tr>
              </tbody>
            </table>

            <div className="section-title">strategy</div>
            <table className="kv-table">
              <tbody>
                <tr>
                  <th>requested id</th>
                  <td className="num">{meta.strategyDetail.id}</td>
                </tr>
                <tr>
                  <th>engine id</th>
                  <td className="num">{meta.strategyDetail.engineId}</td>
                </tr>
                <tr>
                  <th>mode</th>
                  <td className="num">{meta.strategyDetail.mode}</td>
                </tr>
                <tr>
                  <th>params</th>
                  <td className="num">{JSON.stringify(meta.strategyDetail.params)}</td>
                </tr>
              </tbody>
            </table>

            {meta.fuzzy.stats !== null && (
              <>
                <div className="section-title">fuzzy expansion</div>
                <table className="kv-table">
                  <tbody>
                    <tr>
                      <th>terms attempted</th>
                      <td className="num">{meta.fuzzy.stats.termsAttempted}</td>
                    </tr>
                    <tr>
                      <th>terms expanded</th>
                      <td className="num">{meta.fuzzy.stats.termsExpanded}</td>
                    </tr>
                    <tr>
                      <th>variants added</th>
                      <td className="num">{meta.fuzzy.stats.variantsAdded}</td>
                    </tr>
                    <tr>
                      <th>caps hit</th>
                      <td className="num">{JSON.stringify(meta.fuzzy.stats.caps)}</td>
                    </tr>
                  </tbody>
                </table>
              </>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
