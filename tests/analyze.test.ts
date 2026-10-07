import { describe, expect, it } from 'vitest';
import { analyze, extractRuns, DEFAULT_ANALYSIS } from '../src/core/text/analyze.js';

describe('token extraction', () => {
  it('splits on non-alphanumeric characters and lowercases', () => {
    const runs = extractRuns('Hello, World! Search-Engine 2026.');
    expect(runs.map((r) => r.term)).toEqual(['hello', 'world', 'search', 'engine', '2026']);
  });

  it('keeps internal apostrophes as one run, then strips them in normalization', () => {
    const runs = extractRuns("don't stop");
    expect(runs[0]!.term).toBe('dont');
  });

  it('splits hyphenated compounds into separate runs', () => {
    const runs = extractRuns('state-of-the-art');
    expect(runs.map((r) => r.term)).toEqual(['state', 'of', 'the', 'art']);
  });

  it('records original-text offsets for snippet highlighting', () => {
    const text = 'Inverted Index rocks';
    const runs = extractRuns(text);
    expect(runs[0]).toEqual({ term: 'inverted', start: 0, end: 8 });
    expect(text.slice(runs[1]!.start, runs[1]!.end)).toBe('Index');
  });

  it('applies Unicode NFKC normalization (fullwidth letters)', () => {
    const runs = extractRuns('\uFF28\uFF45\uFF4C\uFF4C\uFF4F'); // Ｈｅｌｌｏ
    expect(runs[0]!.term).toBe('hello');
  });

  it('ignores punctuation-only and empty-after-normalization runs', () => {
    expect(extractRuns('... --- !!!')).toEqual([]);
  });
});

describe('full analysis pipeline', () => {
  it('stems terms so variants converge on one stem', () => {
    const terms = analyze('learning learned learns').map((t) => t.term);
    expect(terms).toEqual(['learn', 'learn', 'learn']);
  });

  it('removes English stop-words but keeps dense positions for the rest', () => {
    const tokens = analyze('the quick brown fox');
    expect(tokens.map((t) => t.term)).toEqual(['quick', 'brown', 'fox']);
    expect(tokens.map((t) => t.position)).toEqual([0, 1, 2]);
  });

  it('stop-words contribute no position, so phrase adjacency is consistent', () => {
    // Both texts must produce identical (term, position) streams for phrase search.
    const a = analyze('machine and learning');
    const b = analyze('machine learning');
    expect(a.map((t) => [t.term, t.position])).toEqual(
      b.map((t) => [t.term, t.position]),
    );
  });

  it('respects config: stemming off', () => {
    const cfg = { ...DEFAULT_ANALYSIS, stemming: 'none' as const };
    expect(analyze('running', cfg)[0]!.term).toBe('running');
  });

  it('respects config: stopwords off', () => {
    const cfg = { ...DEFAULT_ANALYSIS, stopwords: 'none' as const };
    const tokens = analyze('the cat', cfg);
    expect(tokens.map((t) => t.term)).toEqual(['the', 'cat']);
    expect(tokens[1]!.position).toBe(1);
  });

  it('produces no duplicate positions', () => {
    const tokens = analyze('repeated repeated repeated words repeated');
    const positions = tokens.map((t) => t.position);
    expect(new Set(positions).size).toBe(positions.length);
  });
});
