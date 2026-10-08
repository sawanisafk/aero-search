/**
 * SettingsWindow — runtime configuration and endpoint reference.
 *
 * WHAT: defaults served by GET /api/config (corpora, strategies, caps,
 *   fuzzy defaults), the REST endpoint list, and an about box. Read-only:
 *   configuration lives on the server; this window explains it.
 * CONNECTS: api.config().
 */

import { useEffect, useState } from 'react';
import { ApiError, api } from '../api/client';
import type { ConfigResponse } from '../api/types';

const ENDPOINTS: readonly { readonly method: string; readonly path: string; readonly what: string }[] =
  [
    { method: 'GET', path: '/health', what: 'liveness + loaded corpora' },
    { method: 'GET', path: '/api/config', what: 'defaults, corpora, strategies' },
    { method: 'GET', path: '/api/search?q=…', what: 'the search pipeline' },
    { method: 'GET', path: '/api/documents/:corpus/:id', what: 'document detail' },
    { method: 'GET', path: '/api/stats?corpus=…', what: 'index + service status' },
    { method: 'GET', path: '/api/benchmarks', what: 'committed experiment artifacts' },
  ];

export function SettingsWindow(): React.JSX.Element {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .config()
      .then((c) => {
        if (alive) setConfig(c);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', String(e)));
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error !== null) {
    return (
      <div className="error-box" role="alert">
        <span className="code">{error.code}</span>
        {error.message}
      </div>
    );
  }
  if (config === null) {
    return (
      <div className="loading-row">
        <span className="spinner" /> loading configuration…
      </div>
    );
  }

  return (
    <div>
      <div className="section-title">search defaults</div>
      <table className="kv-table">
        <tbody>
          <tr>
            <th>service version</th>
            <td className="num">{config.version}</td>
          </tr>
          <tr>
            <th>default corpus</th>
            <td className="num">{config.defaultCorpus}</td>
          </tr>
          <tr>
            <th>default strategy</th>
            <td className="num">{config.defaultStrategy}</td>
          </tr>
          <tr>
            <th>default k / max k</th>
            <td className="num">
              {config.defaultK} / {config.maxK}
            </td>
          </tr>
          <tr>
            <th>max page</th>
            <td className="num">{config.maxPage}</td>
          </tr>
          <tr>
            <th>implicit operator</th>
            <td className="num">{config.implicitOperator}</td>
          </tr>
        </tbody>
      </table>

      <div className="section-title">corpora</div>
      <span className="chip-row">
        {config.corpora.map((c) => (
          <span className="chip" key={c}>
            {c}
          </span>
        ))}
      </span>

      <div className="section-title">strategies</div>
      <table className="kv-table">
        <tbody>
          {config.strategies.map((s) => (
            <tr key={s.id}>
              <th>{s.label}</th>
              <td className="num">
                <span className={`dot ${s.available ? 'on' : 'off'}`} />
                {s.id}
                {s.available ? '' : ` · ${s.reason ?? 'unavailable'}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="section-title">fuzzy defaults</div>
      <table className="kv-table">
        <tbody>
          {Object.entries(config.fuzzyDefaults).map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td className="num">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="section-title">REST endpoints</div>
      <table className="kv-table">
        <tbody>
          {ENDPOINTS.map((e) => (
            <tr key={e.path}>
              <th className="mono">{e.method}</th>
              <td className="num">
                {e.path} <span className="muted">— {e.what}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="section-title">about</div>
      <div className="note-box">
        <strong>Aero Search</strong> — a search engine written from first principles for a
        final-year project: custom inverted index, Porter stemming, Boolean / TF-IDF / BM25 /
        phrase + proximity ranking, PageRank fusion, bounded fuzzy recovery, crawling and
        PostgreSQL analytics — no search engine libraries, no AI. Source:{' '}
        <a href="https://github.com/sawanisafk/aero-search" target="_blank" rel="noreferrer">
          github.com/sawanisafk/aero-search
        </a>
        .
      </div>
    </div>
  );
}
