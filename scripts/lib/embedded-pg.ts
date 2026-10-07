import fs from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';

export interface ManagedDatabase {
  url: string;
  /** True when we booted an embedded cluster (false = an external server answered). */
  embedded: boolean;
  stop(): Promise<void>;
}

export interface StartDatabaseOptions {
  /** Cluster data directory. Default: <cwd>/data/pg (gitignored). */
  databaseDir?: string;
  /** Port for the embedded cluster. Default: 5432 (compose-compatible). */
  port?: number;
  /** Database name to create/use. Default: aero_search. */
  database?: string;
  /** Wipe the data directory first — tests use this for deterministic state. */
  fresh?: boolean;
}

async function probe(url: string, timeoutMs = 1_500): Promise<boolean> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: timeoutMs });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function waitFor(url: string, attempts = 40, delayMs = 250): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await probe(url, 1_000)) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`database did not become ready: ${url}`);
}

/**
 * Provides a usable PostgreSQL connection without requiring Docker or admin
 * rights (ADR-011):
 *
 *  1. If DATABASE_URL is set and that server answers, it is used as-is
 *     (docker-compose / system install take precedence when running).
 *  2. Otherwise an embedded PostgreSQL 16 cluster is started on this machine
 *     with the same credentials as docker-compose.yml, so both are drop-in
 *     interchangeable.
 */
export async function startDatabase(opts: StartDatabaseOptions = {}): Promise<ManagedDatabase> {
  const database = opts.database ?? 'aero_search';

  const configured = process.env.DATABASE_URL;
  if (configured !== undefined && configured !== '' && (await probe(configured))) {
    return { url: configured, embedded: false, stop: async () => undefined };
  }

  const dir = opts.databaseDir ?? path.join(process.cwd(), 'data', 'pg');
  const port = opts.port ?? 5432;
  if (opts.fresh === true) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const ep = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: 'aero',
    password: 'aero',
    persistent: true,
    // Windows defaults to WIN1252, which rejects UTF-8 in SQL/comments; C
    // locale keeps ORDER BY byte-deterministic across machines.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => undefined,
    onError: (m) => process.stderr.write(`[postgres] ${String(m)}\n`),
  });

  const initialized = fs.existsSync(path.join(dir, 'PG_VERSION'));
  if (!initialized) await ep.initialise();
  await ep.start();

  const admin = ep.getPgClient('postgres');
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already exists')) {
      await ep.stop().catch(() => undefined);
      throw err;
    }
  } finally {
    await admin.end().catch(() => undefined);
  }

  const url = `postgres://aero:aero@localhost:${port}/${database}`;
  await waitFor(url);
  return { url, embedded: true, stop: () => ep.stop() };
}
