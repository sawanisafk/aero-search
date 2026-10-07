/**
 * Deterministic synthetic corpus generator — realistic-ish unigram stream
 * for index benchmarks.
 *
 * Design:
 *   - seeded mulberry32 PRNG (identical output on every platform)
 *   - vocabulary of pseudo-English words (C/V syllable patterns + inflectional
 *     suffixes), so the Porter stemmer actually collapses variants
 *   - Zipf-distributed term sampling -> realistic df/skew, tf > 1 naturally
 *   - document lengths ~ Normal(mean, sd) clamped to a sane range
 *
 * Limitation (documented in docs/INDEXING.md): no topical structure — this
 * generator measures indexing throughput and index shape, not ranking
 * quality. Ranking evaluation uses static-v1 and later crawled corpora.
 */

import crypto from 'node:crypto';
import type { AddDocumentInput } from '../../src/core/index/types.js';

export interface SyntheticCorpusConfig {
  numDocs: number;
  vocabSize: number;
  meanWordsPerDoc: number;
  sdWordsPerDoc: number;
  seed: number;
}

export const DEFAULT_SYNTHETIC: Omit<SyntheticCorpusConfig, 'numDocs'> = {
  vocabSize: 50_000,
  meanWordsPerDoc: 200,
  sdWordsPerDoc: 50,
  seed: 42,
};

/** mulberry32 — tiny deterministic PRNG, [0, 1) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONSONANTS = 'bcdfghjklmnprstvwz';
const VOWELS = 'aeiou';
const SUFFIXES = ['', '', '', '', 's', 'ing', 'ed', 'ly', 'er', 'ment', 'ness', 'tion'];

function makeVocabulary(size: number, rnd: () => number): string[] {
  const words = new Set<string>();
  while (words.size < size) {
    const syllables = 1 + Math.floor(rnd() * 3);
    let w = '';
    for (let s = 0; s < syllables; s++) {
      w += CONSONANTS[Math.floor(rnd() * CONSONANTS.length)];
      w += VOWELS[Math.floor(rnd() * VOWELS.length)];
      if (rnd() < 0.4) w += CONSONANTS[Math.floor(rnd() * CONSONANTS.length)];
    }
    words.add(w + SUFFIXES[Math.floor(rnd() * SUFFIXES.length)]);
  }
  return [...words];
}

/** Precompute Zipf cumulative weights for inverse-transform sampling. */
function zipfCdf(vocabSize: number): Float64Array {
  const cdf = new Float64Array(vocabSize);
  let acc = 0;
  const harmonic: number[] = [];
  for (let i = 1; i <= vocabSize; i++) {
    acc += 1 / i;
    harmonic.push(acc);
  }
  const total = acc;
  for (let i = 0; i < vocabSize; i++) cdf[i] = harmonic[i]! / total;
  return cdf;
}

function sampleZipf(cdf: Float64Array, u: number): number {
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid]! < u) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface SyntheticCorpus {
  docs: AddDocumentInput[];
  corpusHash: string;
  config: SyntheticCorpusConfig;
}

export function generateSyntheticCorpus(config: SyntheticCorpusConfig): SyntheticCorpus {
  const rnd = mulberry32(config.seed);
  const vocab = makeVocabulary(config.vocabSize, rnd);
  const cdf = zipfCdf(vocab.length);

  const docs: AddDocumentInput[] = new Array(config.numDocs);
  const hash = crypto.createHash('sha256');

  for (let i = 0; i < config.numDocs; i++) {
    // approximate Normal(mean, sd) via sum of uniforms (Irwin–Hall), clamped
    const u = (rnd() + rnd() + rnd() + rnd() + rnd() + rnd() - 3) / 1.2;
    const words = Math.max(50, Math.min(600, Math.round(config.meanWordsPerDoc + u * config.sdWordsPerDoc)));
    const parts: string[] = new Array(words);
    for (let w = 0; w < words; w++) parts[w] = vocab[sampleZipf(cdf, rnd())]!;
    const text = parts.join(' ');
    const doc: AddDocumentInput = {
      title: `synthetic document ${i}`,
      url: `synthetic://${config.seed}/${i}`,
      text,
    };
    docs[i] = doc;
    hash.update(`${doc.url}\n${doc.title}\n${text}\n`);
  }

  return { docs, corpusHash: hash.digest('hex'), config };
}
