import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stem } from '../src/core/text/porter.js';

interface Pair {
  input: string;
  expected: string;
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function loadGolden(): Pair[] {
  const path = join(TEST_DIR, 'fixtures', 'porter-golden.tsv');
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const pairs: Pair[] = [];
  for (const line of lines) {
    if (line.length === 0 || line.startsWith('#')) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    pairs.push({ input: line.slice(0, tab), expected: line.slice(tab + 1) });
  }
  return pairs;
}

describe('porter stemmer', () => {
  const golden = loadGolden();

  it('loads the full official test set', () => {
    expect(golden.length).toBe(23531);
  });

  it('matches every official vector (23,531 pairs)', () => {
    const mismatches: string[] = [];
    for (const { input, expected } of golden) {
      const got = stem(input);
      if (got !== expected) mismatches.push(`${input}: expected ${expected}, got ${got}`);
    }
    expect(
      mismatches,
      `${mismatches.length} mismatches:\n${mismatches.slice(0, 20).join('\n')}`,
    ).toEqual([]);
  });

  it('leaves words of length <= 2 unchanged (canonical departure)', () => {
    expect(stem('as')).toBe('as');
    expect(stem('is')).toBe('is');
    expect(stem('a')).toBe('a');
  });

  it('converges inflected variants onto a common stem', () => {
    expect(new Set(['learning', 'learned', 'learnings', 'learns'].map(stem))).toEqual(
      new Set(['learn']),
    );
  });
});
