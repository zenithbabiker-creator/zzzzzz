import pg from 'pg';
import type { PoolClient, PoolConfig } from 'pg';

const { Pool } = pg;

export function buildPoolConfig(): PoolConfig {
  const connectionString = process.env.DATABASE_URL?.trim();
  const sslEnabled = process.env.PGSSLMODE === 'require';

  if (connectionString) {
    return {
      connectionString,
      max: Number(process.env.PGPOOL_MAX || 20),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
    };
  }

  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'agritrack',
    password: process.env.PGPASSWORD ?? '',
    database: process.env.PGDATABASE || 'agritrack_field',
    max: Number(process.env.PGPOOL_MAX || 20),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
  };
}

let sharedPool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!sharedPool) {
    sharedPool = new Pool(buildPoolConfig());
  }
  return sharedPool;
}

export async function closePool(): Promise<void> {
  if (sharedPool) {
    const p = sharedPool;
    sharedPool = null;
    await p.end();
  }
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore secondary rollback error if connection dropped
    }
    throw err;
  } finally {
    client.release();
  }
}
