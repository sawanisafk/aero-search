/**
 * Per-signal contribution bars — the "why did this rank here" panel.
 * Values are the raw breakdown components the strategy produced
 * (unnormalized, exactly as ScoredDoc.breakdown reports them).
 */

const SIGNAL_LABELS: Readonly<Record<string, string>> = {
  bm25: 'bm25',
  tfidf: 'tfidf',
  phrase: 'phrase',
  proximity: 'proximity',
  pagerank: 'pagerank',
  boolean: 'boolean',
};

function signalClass(name: string): string {
  return `fill ${name === 'pagerank' ? 'pagerank' : name}` ;
}

export function SignalBars({ signals }: { signals: Readonly<Record<string, number>> }): React.JSX.Element {
  const entries = Object.entries(signals);
  if (entries.length === 0) return <></>;
  const max = Math.max(...entries.map(([, v]) => Math.abs(v)), Number.EPSILON);
  return (
    <div className="signals" aria-label="score signals">
      {entries.map(([name, value]) => (
        <div className="signal-row" key={name}>
          <span className="name">{SIGNAL_LABELS[name] ?? name}</span>
          <span className="track">
            <span
              className={signalClass(name)}
              style={{ width: `${Math.max(3, (Math.abs(value) / max) * 100)}%` }}
            />
          </span>
          <span className="value">{value >= 100 ? value.toFixed(0) : value.toFixed(3)}</span>
        </div>
      ))}
    </div>
  );
}
