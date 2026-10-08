/**
 * API runtime configuration — environment-driven with safe defaults.
 *
 * WHAT: values the HTTP layer needs before any engine code runs (bind
 * address, default corpus/strategy, request caps).
 * WHY: caps live in one place so validation is consistent between the JSON
 *   schemas in app.ts and the service layer (defence in depth).
 * CONNECTS TO M0-M4: nothing here touches the engine; it only decides which
 *   built index (data/index/<corpus>.aidx) the service opens first.
 */

export const MAX_K = 50;
export const MAX_PAGE = 1000;
export const MAX_QUERY_LENGTH = 512;
export const DEFAULT_K = 10;

export interface ApiConfig {
  /** repository root — all relative data paths resolve against it */
  readonly root: string;
  readonly host: string;
  readonly port: number;
  readonly defaultCorpus: string;
  readonly defaultStrategy: string;
  readonly defaultK: number;
  readonly maxK: number;
  readonly maxPage: number;
  readonly maxQueryLength: number;
  /** default parse mode for bare terms (benchmarks use 'or' — M2 convention) */
  readonly implicitOperator: 'and' | 'or';
  /** allowed CORS origins ([] = same-origin only) */
  readonly corsOrigins: readonly string[];
}

function intFromEnv(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name}: expected a positive integer, got "${value}"`);
  }
  return n;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  root = process.cwd(),
): ApiConfig {
  const corsOrigins = (env.AERO_CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    root,
    host: env.HOST ?? '127.0.0.1',
    port: intFromEnv(env.PORT, 3000, 'PORT'),
    defaultCorpus: env.AERO_CORPUS ?? 'scifact',
    defaultStrategy: env.AERO_STRATEGY ?? 'bm25',
    defaultK: DEFAULT_K,
    maxK: MAX_K,
    maxPage: MAX_PAGE,
    maxQueryLength: MAX_QUERY_LENGTH,
    implicitOperator: env.AERO_IMPLICIT === 'and' ? 'and' : 'or',
    corsOrigins,
  };
}
