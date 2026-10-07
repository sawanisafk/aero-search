import { Pool } from 'pg';

/** Compose-compatible default from .env.example / docker-compose.yml. */
export function defaultDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://aero:aero@localhost:5432/aero_search';
}

export function createPool(connectionString: string, max = 5): Pool {
  return new Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}
