/**
 * StatusWindow — live system status for the running service.
 *
 * WHAT: service health (version, uptime, search traffic), index stats for
 *   the selected corpus, strategy availability with reasons, PageRank
 *   availability, fuzzy defaults, and the crawl manifest when present.
 * CONNECTS: GET /api/stats?corpus=... via api.stats().
 */

import { useEffect, useState } from 'react';
import { ApiError, api } from '../api/client';
import type { StatsResponse } from '../api/types';

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function StatusWindow(): React.JSX.Element {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [corpus, setCorpus] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .stats(corpus ?? undefined)
      .then((s) => {
        if (alive) setStats(s);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', String(e)));
      });
    return () => {
      alive = false;
    };
  }, [corpus]);

  if (error !== null) {
    return (
      <div className="error-box" role="alert">
        <span className="code">{error.code}</span>
        {error.message}
      </div>
    );
  }
  if (stats === null) {
    return (
      <div className="loading-row">
        <span className="spinner" /> reading status…
      </div>
    );
  }

  const pr = stats.pagerank;
  const crawl = stats.crawl;
  const crawlRows =
    crawl === null ? [] : Object.entries(crawl).filter(([, v]) => typeof v !== 'object');

  return (
    <div>
      <div className="statusline">
        <span>
          <span className="dot on" />
          service <strong>{stats.version}</strong>
        </span>
        <span className="pill gray">{stats.node}</span>
        <span className="pill">{stats.search.total} searches served</span>
        <span className="pill gray">
          recent avg {stats.search.recent.avgMs.toFixed(1)} ms · p95{' '}
          {stats.search.recent.p95Ms.toFixed(1)} ms
        </span>
      </div>

      <div className="section-title">corpus</div>
      <div className="search-options">
        <label className="field">
          inspect corpus
          <select
            className="aero-select"
            value={corpus ?? stats.corpus.name}
            onChange={(e) => setCorpus(e.target.value)}
          >
            {(stats.corpora.length > 0 ? stats.corpora.map((c) => c.name) : [stats.corpus.name]).map(
              (c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ),
            )}
          </select>
        </label>
        <span className="pill gray">uptime {(stats.uptimeMs / 1000).toFixed(0)}s</span>
      </div>

      <div className="cards">
        <div className="card">
          <h3>index · {stats.corpus.name}</h3>
          <div className="big">{stats.corpus.numDocs.toLocaleString('en-US')}</div>
          <div className="row">
            <span className="k">documents</span>
            <span className="v">{stats.corpus.numDocs}</span>
          </div>
          <div className="row">
            <span className="k">vocabulary</span>
            <span className="v">{stats.corpus.vocabSize}</span>
          </div>
          <div className="row">
            <span className="k">postings</span>
            <span className="v">{stats.corpus.numPostings}</span>
          </div>
          <div className="row">
            <span className="k">tokens</span>
            <span className="v">{stats.corpus.totalTokens}</span>
          </div>
          <div className="row">
            <span className="k">avg doc length</span>
            <span className="v">{stats.corpus.avgDocLength.toFixed(1)}</span>
          </div>
          <div className="row">
            <span className="k">index size</span>
            <span className="v">{bytes(stats.corpus.indexBytes)}</span>
          </div>
          <div className="row">
            <span className="k">metadata store</span>
            <span className="v">{stats.corpus.metadataStore}</span>
          </div>
          <div className="row">
            <span className="k">corpus hash</span>
            <span className="v">{stats.corpus.corpusHash.slice(0, 12)}…</span>
          </div>
        </div>

        <div className="card">
          <h3>strategies</h3>
          {stats.strategies.map((s) => (
            <div className="row" key={s.id} title={s.reason}>
              <span className="k">
                <span className={`dot ${s.available ? 'on' : 'off'}`} />
                {s.label}
              </span>
              <span className="v">
                {s.mode}
                {s.available ? '' : ' · n/a'}
              </span>
            </div>
          ))}
        </div>

        <div className="card">
          <h3>PageRank</h3>
          <div className="row">
            <span className="k">available</span>
            <span className="v">
              <span className={`dot ${pr.available ? 'on' : 'off'}`} />
              {pr.available ? 'yes' : 'no'}
            </span>
          </div>
          {pr.source !== undefined && (
            <div className="row">
              <span className="k">source</span>
              <span className="v">{pr.source}</span>
            </div>
          )}
          {pr.nodes !== undefined && (
            <div className="row">
              <span className="k">nodes / edges</span>
              <span className="v">
                {pr.nodes} / {pr.edges ?? '—'}
              </span>
            </div>
          )}
          {pr.iterations !== undefined && (
            <div className="row">
              <span className="k">iterations</span>
              <span className="v">{pr.iterations}</span>
            </div>
          )}
          {pr.residual !== undefined && (
            <div className="row">
              <span className="k">residual</span>
              <span className="v">{pr.residual.toExponential(2)}</span>
            </div>
          )}
          {pr.damping !== undefined && (
            <div className="row">
              <span className="k">damping</span>
              <span className="v">{pr.damping}</span>
            </div>
          )}
          {pr.graphHash !== undefined && (
            <div className="row">
              <span className="k">graph hash</span>
              <span className="v">{pr.graphHash.slice(0, 12)}…</span>
            </div>
          )}
        </div>

        <div className="card">
          <h3>fuzzy recovery</h3>
          <div className="row">
            <span className="k">supported</span>
            <span className="v">
              <span className="dot on" />
              {stats.fuzzy.supported ? 'yes' : 'no'}
            </span>
          </div>
          {Object.entries(stats.fuzzy.defaults).map(([k, v]) => (
            <div className="row" key={k}>
              <span className="k">{k}</span>
              <span className="v">{v}</span>
            </div>
          ))}
        </div>

        <div className="card">
          <h3>loaded corpora</h3>
          {stats.corpora.map((c) => (
            <div className="row" key={c.name}>
              <span className="k">{c.name}</span>
              <span className="v">{bytes(c.indexBytes)}</span>
            </div>
          ))}
          {stats.corpora.length === 0 && <div className="muted small">none</div>}
        </div>

        <div className="card">
          <h3>crawl</h3>
          {crawl === null ? (
            <div className="muted small">
              no crawl manifest on disk (postgres-backed crawls only expose it when present)
            </div>
          ) : (
            <>
              {crawlRows.map(([k, v]) => (
                <div className="row" key={k}>
                  <span className="k">{k}</span>
                  <span className="v">{String(v)}</span>
                </div>
              ))}
              {crawlRows.length === 0 && (
                <div className="muted small">manifest present — nested counts only</div>
              )}
            </>
          )}
        </div>
      </div>

      <p className="muted small" style={{ marginTop: 12 }}>
        service uptime {(stats.uptimeMs / 1000).toFixed(0)}s · {stats.search.total} searches
        recorded in this process.
      </p>
    </div>
  );
}
