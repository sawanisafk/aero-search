/**
 * Deterministic result snippets — the M5 presentation layer for matched text.
 *
 * WHAT: given a document's full text and the query's analyzed (positive)
 *   terms, cut a short window around the densest cluster of matches and
 *   report highlight ranges for the frontend.
 * WHY: the demo must show "why this document matched" without an LLM or any
 *   nondeterminism — same query + same doc always yields the same snippet.
 * ALGORITHM: analyze the text with the index's frozen pipeline (ADR-009 —
 *   snippet terms must equal indexed terms, so "Darcy" highlights where the
 *   dictionary holds "darci"), find every matching token, score each match's
 *   fixed-size character window by how many matches it contains, keep the
 *   best window (ties broken by earliest occurrence), then slice the raw
 *   text and re-base the highlight offsets onto the slice.
 * DATA IN: raw text, Token[] (start/end offsets from analyze()), positive
 *   analyzed query terms (fuzzy variants included — a recovered typo
 *   highlights the corrected word in the result).
 * DATA OUT: { text, highlights[{start,end,term}], matched, sourceStart }.
 * CONNECTS TO M0-M4: src/core/text/analyze.ts (same tokens as the index).
 */

import type { AnalysisConfig, Token } from '../core/text/analyze.js';

export interface SnippetHighlight {
  /** [start, end) inside snippet.text */
  readonly start: number;
  readonly end: number;
  /** analyzed term that matched (dictionary form) */
  readonly term: string;
}

export interface Snippet {
  readonly text: string;
  readonly highlights: readonly SnippetHighlight[];
  readonly matched: boolean;
  /** character offset of snippet.text inside the original document text */
  readonly sourceStart: number;
}

const DEFAULT_BEFORE = 90;
const DEFAULT_WINDOW = 240;

export interface SnippetOptions {
  readonly before?: number;
  readonly window?: number;
}

/** First `max` characters as a fallback snippet (no matches, or tiny text). */
function headSnippet(text: string, max: number): Snippet {
  const end = Math.min(text.length, max);
  return { text: text.slice(0, end), highlights: [], matched: false, sourceStart: 0 };
}

/**
 * Build a snippet. `tokens` must be analyze(text, config) for the SAME text
 * — callers cache them per document (the service does).
 */
export function makeSnippet(
  text: string,
  tokens: readonly Token[],
  positiveTerms: ReadonlySet<string>,
  options: SnippetOptions = {},
): Snippet {
  const before = options.before ?? DEFAULT_BEFORE;
  const windowSize = options.window ?? DEFAULT_WINDOW;
  if (text.length === 0) return headSnippet(text, windowSize);

  const matches: Token[] = tokens.filter((t) => positiveTerms.has(t.term));
  if (matches.length === 0) return headSnippet(text, windowSize);

  // Score each candidate window (centered at a match) by matches contained.
  let best: { start: number; count: number; firstMatch: number } | null = null;
  for (const m of matches) {
    const start = Math.max(0, m.start - before);
    const end = Math.min(text.length, start + windowSize);
    let count = 0;
    for (const t of matches) {
      if (t.start >= start && t.end <= end) count++;
    }
    if (best === null || count > best.count) {
      best = { start, count, firstMatch: m.start };
    }
  }
  const win = best!;
  const slice = text.slice(win.start, win.start + windowSize);
  const highlights: SnippetHighlight[] = [];
  const seen = new Set<string>();
  for (const t of matches) {
    if (t.start >= win.start && t.end <= win.start + windowSize) {
      const key = `${t.start}:${t.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      highlights.push({ start: t.start - win.start, end: t.end - win.start, term: t.term });
    }
  }
  highlights.sort((a, b) => a.start - b.start);
  return { text: slice, highlights, matched: true, sourceStart: win.start };
}

/** Convenience: analyze the text with the index config, then snippet it. */
export function snippetFromText(
  text: string,
  positiveTerms: ReadonlySet<string>,
  config: AnalysisConfig,
  analyzeFn: (text: string, config: AnalysisConfig) => readonly Token[],
  options: SnippetOptions = {},
): Snippet {
  return makeSnippet(text, analyzeFn(text, config), positiveTerms, options);
}
