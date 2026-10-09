/**
 * Shared helpers for dataset fetch/build scripts: download, hashing,
 * archive extraction, git provenance. I/O lives here (and in sibling
 * scripts) — never in src/ (module rules).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Download a URL to a file (Node's global fetch; datasets here are ≤ 20 MB). */
export async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

export function hashFile(algo: 'sha256' | 'md5', file: string): string {
  return crypto.createHash(algo).update(fs.readFileSync(file)).digest('hex');
}

export function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Extract .zip / .tar / .tar.gz via the system `tar` (bsdtar ships with
 * Windows 10+ and handles zip as well — verified in this environment).
 */
export function extractArchive(archive: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync('tar', ['-xf', archive, '-C', destDir], { stdio: 'pipe' });
}

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

export interface GitInfo {
  readonly sha: string;
  /** no modifications to tracked files (untracked output files are expected
   * while an artifact batch is being written — see has_untracked) */
  readonly clean: boolean;
  /** untracked files exist (e.g. artifacts written earlier in this batch) */
  readonly has_untracked: boolean;
}

/** Current commit + worktree state — recorded in every evidence artifact. */
export function getGitInfo(): GitInfo {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { stdio: 'pipe' })
      .toString()
      .trim();
    const porcelain = execFileSync('git', ['status', '--porcelain'], { stdio: 'pipe' })
      .toString()
      .trim();
    const lines = porcelain === '' ? [] : porcelain.split('\n');
    return {
      sha,
      clean: !lines.some((l) => !l.startsWith('??')),
      has_untracked: lines.some((l) => l.startsWith('??')),
    };
  } catch {
    return { sha: 'unknown', clean: false, has_untracked: false };
  }
}

/** Latency summary in milliseconds (nearest-rank p95/p99). */
export interface LatencyStats {
  readonly count: number;
  readonly avg: number;
  readonly median: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
}

export function latencyStats(samples: number[]): LatencyStats {
  if (samples.length === 0) {
    return { count: 0, avg: 0, median: 0, p95: 0, p99: 0, min: 0, max: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const median =
    n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  const p95 = sorted[Math.min(n - 1, Math.ceil(0.95 * n) - 1)]!;
  const p99 = sorted[Math.min(n - 1, Math.ceil(0.99 * n) - 1)]!;
  return {
    count: n,
    avg: sum / n,
    median,
    p95,
    p99,
    min: sorted[0]!,
    max: sorted[n - 1]!,
  };
}
