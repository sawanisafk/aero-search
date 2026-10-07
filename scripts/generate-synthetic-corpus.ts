/**
 * Writes the synthetic corpus to data/corpora/synthetic-v1/ (gitignored —
 * reproducible from the seed recorded in the manifest).
 *
 * Usage:
 *   npx tsx scripts/generate-synthetic-corpus.ts [--docs 10000] [--seed 42]
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SYNTHETIC, generateSyntheticCorpus } from './lib/synthetic.js';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}

function main(): void {
  const numDocs = arg('docs', 10_000);
  const seed = arg('seed', 42);

  const t0 = performance.now();
  const { docs, corpusHash, config } = generateSyntheticCorpus({
    ...DEFAULT_SYNTHETIC,
    numDocs,
    seed,
  });
  const genMs = performance.now() - t0;

  const outDir = path.join(process.cwd(), 'data', 'corpora', 'synthetic-v1');
  fs.mkdirSync(outDir, { recursive: true });

  const jsonl = docs.map((d, i) => JSON.stringify({ id: i, ...d })).join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, 'documents.jsonl'), jsonl, 'utf8');

  const manifest = {
    name: 'synthetic-v1',
    description:
      'Deterministic synthetic unigram corpus (Zipf vocabulary) for index benchmarks. Regenerate with scripts/generate-synthetic-corpus.ts.',
    config,
    corpusHash,
    numDocuments: docs.length,
    bytes: Buffer.byteLength(jsonl),
    generator: 'scripts/generate-synthetic-corpus.ts',
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(
    `synthetic-v1: ${docs.length} docs, ${(Buffer.byteLength(jsonl) / 1e6).toFixed(1)} MB, ` +
      `corpusHash=${corpusHash}, generated in ${genMs.toFixed(0)} ms -> ${outDir}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
