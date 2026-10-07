/**
 * Text analysis pipeline: raw text -> indexed terms with positions/offsets.
 *
 * Pipeline (single shared code path for INDEX TIME and QUERY TIME — the
 * analyzer is the only place terms are produced, which guarantees that a
 * query term can never miss the index for analysis reasons):
 *
 *   1. extract runs of letters/digits (Unicode-aware; internal apostrophes kept)
 *   2. per-token NFKC normalize + lowercase, strip non letter/digit chars
 *   3. stop-word removal (optional, configurable)
 *   4. Porter stemming (optional, configurable)
 *   5. assign position = ordinal index over the *emitted* term stream
 *
 * Position semantics (important for phrase search, see docs/INDEXING.md):
 * positions are dense over the emitted stream — a stop-word contributes no
 * position, so "machine and learning" and "machine learning" both yield
 * machine@0, learning@1. Because index and query share this exact code and
 * the config is frozen in the segment header, phrase adjacency checks are
 * consistent by construction.
 *
 * Offsets (start/end) index into the ORIGINAL text and are used later for
 * snippet highlighting.
 */

import { stem } from './porter.js';
import { ENGLISH_STOPWORDS } from './stopwords.js';

export interface AnalysisConfig {
  readonly version: 1;
  readonly lowercase: true;
  readonly stopwords: 'english' | 'none';
  readonly stemming: 'porter' | 'none';
}

export const DEFAULT_ANALYSIS: AnalysisConfig = Object.freeze({
  version: 1,
  lowercase: true,
  stopwords: 'english' as const,
  stemming: 'porter' as const,
});

export interface Token {
  /** final indexed term (post stop-words, post stemming) */
  term: string;
  /** dense ordinal position in the emitted stream of this analyzed string */
  position: number;
  /** [start, end) character range of the raw token in the original text */
  start: number;
  end: number;
}

/** Raw token runs before stop-words/stemming: letters/digits with internal apostrophes. */
const RUN_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
/** Everything that is not a letter or digit (used after NFKC normalization). */
const NON_WORD_RE = /[^\p{L}\p{N}]+/gu;

/**
 * Extract raw token runs (normalized, pre stop-words/stemming) with offsets.
 * Used by tests and debugging; `analyze` is the production path.
 */
export function extractRuns(text: string): Array<{ term: string; start: number; end: number }> {
  const out: Array<{ term: string; start: number; end: number }> = [];
  for (const m of text.matchAll(RUN_RE)) {
    const raw = m[0];
    const start = m.index;
    const term = normalizeToken(raw);
    if (term.length > 0) out.push({ term, start, end: start + raw.length });
  }
  return out;
}

/** Normalize a raw run: NFKC + lowercase, then drop anything not letter/digit. */
function normalizeToken(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(NON_WORD_RE, '');
}

/**
 * Analyze text into indexed terms with positions and original-text offsets.
 * This is the single analysis entry point for documents and queries.
 */
export function analyze(text: string, config: AnalysisConfig = DEFAULT_ANALYSIS): Token[] {
  const tokens: Token[] = [];
  let position = 0;
  for (const m of text.matchAll(RUN_RE)) {
    const raw = m[0];
    const start = m.index;
    let term = normalizeToken(raw);
    if (term.length === 0) continue;
    if (config.stopwords === 'english' && ENGLISH_STOPWORDS.has(term)) continue;
    if (config.stemming === 'porter') term = stem(term);
    if (term.length === 0) continue;
    tokens.push({ term, position, start, end: start + raw.length });
    position++;
  }
  return tokens;
}
