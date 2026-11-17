/**
 * PostgreSQL access: one connection pool per process, errors normalised to `DatabaseUnavailable`
 * so the HTTP layer can answer 503 instead of a generic 500 (mirrors
 * `services/science/matterlab_science/db.py`).
 */
import pg from 'pg';

const { Pool } = pg;
export type PoolClient = pg.PoolClient;

/** Anything that can run a read query: a pooled `Database` or a single transaction client. */
export interface Queryable {
  query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<Row[]>;
  queryOne<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<Row | null>;
}

/** Adapts a raw transaction client to `Queryable`, for code that reads inside a transaction right after writing. */
export function queryableFromClient(client: PoolClient): Queryable {
  return {
    async query<Row = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<Row[]> {
      const result = await client.query(text, params as unknown[]);
      return result.rows as Row[];
    },
    async queryOne<Row = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<Row | null> {
      const result = await client.query(text, params as unknown[]);
      return (result.rows[0] as Row | undefined) ?? null;
    },
  };
}

export class DatabaseUnavailable extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'DatabaseUnavailable';
    this.cause = cause;
  }
}

// PostgreSQL connection-class SQLSTATEs (08 = connection exception, 57P = operator/admin
// shutdown, 3D000 = unknown database): the request should be retried, not reported as a bug.
const UNAVAILABLE_SQLSTATE_PREFIXES = ['08', '57P'];
const UNAVAILABLE_SQLSTATES = new Set(['3D000']);

export function isConnectionUnavailable(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  if (!code) return false;
  return UNAVAILABLE_SQLSTATE_PREFIXES.some((prefix) => code.startsWith(prefix)) || UNAVAILABLE_SQLSTATES.has(code);
}

export interface DatabaseOptions {
  readonly connectionString: string;
  readonly maxSize?: number;
  readonly idleTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}

export class Database {
  private readonly pool: pg.Pool;

  constructor(options: DatabaseOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxSize ?? 10,
      idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
      connectionTimeoutMillis: options.connectTimeoutMs ?? 10_000,
    });
    // A pool-level error (e.g. the server closed an idle connection) must not crash the process.
    this.pool.on('error', () => {});
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<void> {
    try {
      await this.pool.query('SELECT 1');
    } catch (error) {
      throw new DatabaseUnavailable(error);
    }
  }

  /** Runs `fn` inside one transaction: committed on success, rolled back if `fn` throws. */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw new DatabaseUnavailable(error);
    }
    try {
      await client.query('BEGIN');
      try {
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (isConnectionUnavailable(error)) throw new DatabaseUnavailable(error);
        throw error;
      }
    } finally {
      client.release();
    }
  }

  async query<Row = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<Row[]> {
    try {
      const result = await this.pool.query(text, params as unknown[]);
      return result.rows as Row[];
    } catch (error) {
      if (isConnectionUnavailable(error)) throw new DatabaseUnavailable(error);
      throw error;
    }
  }

  async queryOne<Row = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<Row | null> {
    const rows = await this.query<Row>(text, params);
    return rows[0] ?? null;
  }
}
