/**
 * EvaluationWindow — read-only view of the committed experiment artifacts.
 *
 * WHAT: quality runs (MAP / nDCG@10 / R@100), fuzzy-recovery benches
 *   (clean vs typo vs fuzzy arms), per-stage query latency benches, and the
 *   PageRank convergence record. Every number is served from committed
 *   JSON by GET /api/benchmarks — nothing is recomputed in the browser.
 * CONNECTS: api.benchmarks().
 */

import { useEffect, useState } from 'react';
import { ApiError, api } from '../api/client';
import type { BenchmarksResponse, FuzzyBench, QualityRun } from '../api/types';

function metric(v: number | null, digits = 4): string {
  return v === null ? '—' : v.toFixed(digits);
}

function sha(v: string | null): string {
  return v === null ? '—' : v.slice(0, 7);
}

function shortTime(v: string | null): string {
  return v === null ? '—' : v.replace('T', ' ').slice(0, 19);
}

function RunsTable({ runs }: { runs: readonly QualityRun[] }): React.JSX.Element {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>strategy</th>
            <th>mode</th>
            <th>corpus</th>
            <th>fuzzy</th>
            <th>MAP</th>
            <th>nDCG@10</th>
            <th>R@100</th>
            <th>avg ms</th>
            <th>queries</th>
            <th>sha</th>
            <th>timestamp</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.file}>
              <td className="num">{r.strategy ?? '—'}</td>
              <td>{r.mode ?? '—'}</td>
              <td>{r.corpus ?? '—'}</td>
              <td>{r.fuzzy ? 'yes' : 'no'}</td>
              <td className="metric">{metric(r.map)}</td>
              <td className="metric">{metric(r.ndcg10)}</td>
              <td className="num">{metric(r.recall100)}</td>
              <td className="num">{metric(r.latencyAvgMs, 2)}</td>
              <td className="num">{r.evaluatedQueries ?? '—'}</td>
              <td className="num">{sha(r.gitSha)}</td>
              <td className="num">{shortTime(r.timestamp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ARM_LABELS: Readonly<Record<string, string>> = {
  clean: 'clean queries',
  typo_exact: 'typos → exact',
  typo_fuzzy: 'typos → fuzzy recovery',
};

function FuzzyBenchCard({ bench }: { bench: FuzzyBench }): React.JSX.Element {
  return (
    <div className="card">
      <h3>
        fuzzy recovery · edits ≤ {bench.maxEdits ?? '?'} · {bench.judgedQueries ?? '?'} judged
        queries
      </h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>arm</th>
            <th>MAP</th>
            <th>nDCG@10</th>
            <th>R@100</th>
            <th>avg ms</th>
            <th>p95 ms</th>
            <th>parse failures</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(bench.arms).map(([arm, m]) => (
            <tr key={arm}>
              <td>{ARM_LABELS[arm] ?? arm}</td>
              <td className="metric">{metric(m.map)}</td>
              <td className="metric">{metric(m.ndcg10)}</td>
              <td className="num">{metric(m.recall100)}</td>
              <td className="num">{metric(m.avgMs, 2)}</td>
              <td className="num">{metric(m.p95Ms, 2)}</td>
              <td className="num">{m.parseFailures ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {bench.correctionsSample.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <span className="chip-row">
            {bench.correctionsSample.map((c) => (
              <span className="chip fuzzy" key={`${c.token}-${c.corrupted}`}>
                {c.corrupted} → {c.token}
              </span>
            ))}
          </span>
        </div>
      )}
    </div>
  );
}

export function EvaluationWindow(): React.JSX.Element {
  const [data, setData] = useState<BenchmarksResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .benchmarks()
      .then((b) => {
        if (alive) setData(b);
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
  if (data === null) {
    return (
      <div className="loading-row">
        <span className="spinner" /> loading recorded experiments…
      </div>
    );
  }

  const empty =
    data.runs.length === 0 &&
    data.fuzzyBenches.length === 0 &&
    data.queryBenches.length === 0 &&
    data.pagerankRuns.length === 0;

  return (
    <div>
      <div className="note-box good">
        <strong>Read-only view.</strong> {data.note} Generated at{' '}
        <span className="mono">{data.generatedAt}</span>.
      </div>

      {empty && (
        <div className="empty-state">
          no experiment artifacts found — commit results under runs/ and
          benchmarks/results/
        </div>
      )}

      {data.runs.length > 0 && (
        <>
          <div className="section-title">quality runs ({data.runs.length})</div>
          <RunsTable runs={data.runs} />
        </>
      )}

      {data.fuzzyBenches.length > 0 && (
        <>
          <div className="section-title">fuzzy recovery benches ({data.fuzzyBenches.length})</div>
          <div className="cards">
            {data.fuzzyBenches.map((b) => (
              <FuzzyBenchCard bench={b} key={b.file} />
            ))}
          </div>
        </>
      )}

      {data.queryBenches.length > 0 && (
        <>
          <div className="section-title">query latency benches ({data.queryBenches.length})</div>
          <div className="cards">
            {data.queryBenches.map((qb) => (
              <div className="card" key={qb.file}>
                <h3>
                  {qb.kind} · {qb.corpus ?? '?'} · {qb.queries ?? '?'} queries
                </h3>
                <div className="row">
                  <span className="k">parse failures</span>
                  <span className="v">{qb.parseFailures ?? '—'}</span>
                </div>
                <div className="row">
                  <span className="k">timestamp</span>
                  <span className="v">{shortTime(qb.timestamp)}</span>
                </div>
                <table className="data-table" style={{ marginTop: 8 }}>
                  <thead>
                    <tr>
                      <th>stage</th>
                      <th>count</th>
                      <th>avg ms</th>
                      <th>median</th>
                      <th>p95</th>
                    </tr>
                  </thead>
                  <tbody>
                    {qb.stages.map((s) => (
                      <tr key={s.stage}>
                        <td>{s.stage}</td>
                        <td className="num">{s.count ?? '—'}</td>
                        <td className="num">{metric(s.avg ?? null, 3)}</td>
                        <td className="num">{metric(s.median ?? null, 3)}</td>
                        <td className="num">{metric(s.p95 ?? null, 3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </>
      )}

      {data.pagerankRuns.length > 0 && (
        <>
          <div className="section-title">PageRank runs ({data.pagerankRuns.length})</div>
          <div className="cards">
            {data.pagerankRuns.map((pr) => {
              const g = pr.graph;
              const conv = pr.convergence;
              const nodes = typeof g.nodes === 'number' ? g.nodes : null;
              const edges = typeof g.edges === 'number' ? g.edges : null;
              const iterations =
                typeof conv.iterations === 'number' ? conv.iterations : null;
              const residual = typeof conv.residual === 'number' ? conv.residual : null;
              const converged = conv.converged === true;
              return (
                <div className="card" key={pr.file}>
                  <h3>
                    PageRank {pr.runId === null ? '' : `run ${pr.runId}`} ·{' '}
                    {shortTime(pr.timestamp)}
                  </h3>
                  <div className="row">
                    <span className="k">iterations</span>
                    <span className="v">{iterations ?? '—'}</span>
                  </div>
                  <div className="row">
                    <span className="k">residual</span>
                    <span className="v">
                      {residual === null ? '—' : residual.toExponential(2)}
                    </span>
                  </div>
                  <div className="row">
                    <span className="k">converged</span>
                    <span className="v">
                      <span className={`dot ${converged ? 'on' : 'off'}`} />
                      {converged ? 'yes' : 'no'}
                    </span>
                  </div>
                  <div className="row">
                    <span className="k">nodes / edges</span>
                    <span className="v">
                      {nodes ?? '—'} / {edges ?? '—'}
                    </span>
                  </div>
                  <div className="row">
                    <span className="k">score sum</span>
                    <span className="v">{pr.sum === null ? '—' : pr.sum.toFixed(6)}</span>
                  </div>
                  <div className="row">
                    <span className="k">git sha</span>
                    <span className="v">{sha(pr.gitSha)}</span>
                  </div>
                  {pr.top !== null && pr.top.length > 0 && (
                    <table className="data-table" style={{ marginTop: 8 }}>
                      <thead>
                        <tr>
                          <th>top url</th>
                          <th>value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pr.top.map((t) => (
                          <tr key={t.url}>
                            <td>{t.url}</td>
                            <td className="num">{t.value.toFixed(6)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
