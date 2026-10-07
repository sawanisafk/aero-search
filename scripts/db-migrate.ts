/**
 * Applies schema migrations and reports the resulting tables.
 *
 *   npx tsx scripts/db-migrate.ts
 *
 * Uses DATABASE_URL when that server is reachable (docker-compose / system
 * PostgreSQL); otherwise boots the embedded PostgreSQL 16 cluster under
 * data/pg/ with the compose credentials (ADR-011).
 */

import { startDatabase } from './lib/embedded-pg.js';
import { createPool } from '../src/storage/postgres/pool.js';
import { runMigrations, listTables } from '../src/storage/postgres/migrate.js';

function mask(url: string): string {
  return url.replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@');
}

async function main(): Promise<void> {
  const managed = await startDatabase();
  const pool = createPool(managed.url);
  try {
    const applied = await runMigrations(pool);
    const tables = await listTables(pool);
    console.log(`[db] ${mask(managed.url)} ${managed.embedded ? '(embedded)' : '(external)'}`);
    console.log(
      applied.length > 0 ? `[db] applied: ${applied.join(', ')}` : '[db] schema up to date',
    );
    console.log(`[db] tables: ${tables.join(', ')}`);
  } finally {
    await pool.end();
    await managed.stop();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
