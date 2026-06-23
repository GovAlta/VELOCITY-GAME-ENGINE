import pg, { PoolClient } from 'pg';
import { env } from './environment';
import logger from '../utils/logger';

const { Pool } = pg;

const isRemoteDb = env.DATABASE_URL.includes('render.com') || env.DATABASE_URL.includes('sslmode=require');

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  min: 0, // Don't hold idle connections — let the pool create on demand
  idleTimeoutMillis: isRemoteDb ? 30_000 : env.DB_IDLE_TIMEOUT_MS, // 30s for remote (Render kills at ~5min)
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  ssl: isRemoteDb ? { rejectUnauthorized: false } : undefined,
});

// Log pool errors at warn level (these are expected for remote DBs — pool auto-recovers)
pool.on('error', (err: Error) => {
  if (err.message.includes('Connection terminated unexpectedly') ||
      err.message.includes('terminating connection due to idle')) {
    logger.debug('Pool: idle connection dropped by remote DB (auto-recovers)', { error: err.message });
  } else {
    logger.error('Unexpected pool error', { error: err.message });
  }
});

export async function testConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch (error) {
    logger.error('Database connection test failed', { error: (error as Error).message });
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
