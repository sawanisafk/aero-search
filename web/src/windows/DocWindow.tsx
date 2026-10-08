/**
 * DocWindow — full document view for one search hit.
 *
 * WHAT: title, metadata grid (source, URL, live PageRank, matched terms,
 *   phrase matches) and the document text (server-truncated at 20 000 chars).
 * CONNECTS: GET /api/documents/:corpus/:id?q=... via api.document().
 */

import { useEffect, useState } from 'react';
import { ApiError, api } from '../api/client';
import type { DocDetail } from '../api/types';

export function DocWindow({
  corpus,
  docId,
  q,
}: {
  corpus: string;
  docId: string;
  q: string;
}): React.JSX.Element {
  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .document(corpus, docId, q.length > 0 ? { q } : {})
      .then((d) => {
        if (!alive) return;
        setDoc(d);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', String(e)));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [corpus, docId, q]);

  if (loading) {
    return (
      <div className="loading-row">
        <span className="spinner" /> loading document…
      </div>
    );
  }
  if (error !== null) {
    return (
      <div className="error-box" role="alert">
        <span className="code">{error.code}</span>
        {error.message}
      </div>
    );
  }
  if (doc === null) {
    return <div className="empty-state">no document</div>;
  }

  return (
    <div>
      <h2 style={{ margin: '0 0 10px' }}>{doc.title}</h2>

      <dl className="doc-meta-grid">
        <dt>corpus</dt>
        <dd>
          {doc.corpus} · id {doc.id}
        </dd>
        <dt>source</dt>
        <dd>
          {doc.source}
          {doc.url !== null && (
            <>
              {' · '}
              <a href={doc.url} target="_blank" rel="noreferrer">
                {doc.url}
              </a>
            </>
          )}
        </dd>
        <dt>PageRank</dt>
        <dd className="mono">{doc.pagerank === null ? '—' : doc.pagerank.toFixed(6)}</dd>
        <dt>text</dt>
        <dd>{doc.textTruncated ? 'server-truncated at 20 000 characters' : 'full text'}</dd>
      </dl>

      <div className="section-title">matched terms (this query)</div>
      {doc.matchedTerms === null || doc.matchedTerms.length === 0 ? (
        <p className="muted small">
          {q.length === 0 ? 'no query supplied' : 'no query term matched this document'}
        </p>
      ) : (
        <table className="term-table">
          <thead>
            <tr>
              <th>term</th>
              <th>tf in doc</th>
              <th>df in corpus</th>
            </tr>
          </thead>
          <tbody>
            {doc.matchedTerms.map((t) => (
              <tr key={t.term}>
                <td className="num">{t.term}</td>
                <td className="num">{t.tf}</td>
                <td className="num">{t.df}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="section-title">phrase matches</div>
      {doc.phrases === null || doc.phrases.length === 0 ? (
        <p className="muted small">no phrases parsed from this query</p>
      ) : (
        <span className="chip-row">
          {doc.phrases.map((p) => (
            <span className={`chip${p.matched ? '' : ' muted'}`} key={p.terms.join(' ')}>
              "{p.terms.join(' ')}" {p.matched ? '✓' : '✗'}
            </span>
          ))}
        </span>
      )}

      <div className="section-title">document text</div>
      {doc.text === null ? (
        <p className="muted small">raw text is not stored for this corpus</p>
      ) : (
        <div className="doc-text">{doc.text}</div>
      )}
    </div>
  );
}
