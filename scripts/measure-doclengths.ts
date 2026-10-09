/**
 * Document-length statistics in ANALYZER TOKENS — the same measure as the
 * index (IndexWriter: analyze(title + ". " + text, DEFAULT_ANALYSIS)).
 * Reports min/p25/median/mean/p75/p95/max per corpus.
 *
 *   npx tsx scripts/measure-doclengths.ts cqadupstack-tierb
 *   npx tsx scripts/measure-doclengths.ts cqadupstack-programmers cqadupstack-unix
 */

import fs from 'node:fs';
import path from 'node:path';
import { analyze, DEFAULT_ANALYSIS } from '../src/core/text/analyze.js';

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function stats(name: string, file: string): void {
  const lengths: number[] = [];
  let totalTokens = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const d = JSON.parse(line) as { title?: string; text?: string };
    const title = d.title ?? '';
    const text = d.text ?? '';
    const docText = title !== '' ? `${title}. ${text}` : text;
    const n = analyze(docText, DEFAULT_ANALYSIS).length;
    lengths.push(n);
    totalTokens += n;
  }
  const sorted = [...lengths].sort((a, b) => a - b);
  const sum = lengths.reduce((a, b) => a + b, 0);
  console.log(
    `${name.padEnd(24)} docs=${String(lengths.length).padStart(6)} ` +
      `tokens=${String(totalTokens).padStart(9)} ` +
      `min=${sorted[0]} p25=${percentile(sorted, 25)} median=${percentile(sorted, 50)} ` +
      `mean=${(sum / lengths.length).toFixed(1)} p75=${percentile(sorted, 75)} ` +
      `p95=${percentile(sorted, 95)} max=${sorted[sorted.length - 1]}`,
  );
}

const corpora = process.argv.slice(2);
if (corpora.length === 0) {
  console.error('usage: measure-doclengths.ts <corpus> [<corpus> ...]  (data/corpora/<corpus>/corpus.jsonl)');
  process.exitCode = 1;
} else {
  for (const corpus of corpora) {
    stats(corpus, path.join(process.cwd(), 'data', 'corpora', corpus, 'corpus.jsonl'));
  }
}
