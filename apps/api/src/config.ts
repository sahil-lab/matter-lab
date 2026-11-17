/**
 * Runtime configuration, read from environment variables with local-development defaults.
 *
 * Deliberately mirrors the naming and defaults of `services/science/matterlab_science/config.py`:
 * both services point at the same PostgreSQL database by default (see docker-compose.yml), so a
 * developer can run either or both without separate configuration.
 */

export interface Config {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly corsOrigins: readonly string[];
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly dbPoolMaxSize: number;
  readonly dbPoolIdleTimeoutMs: number;
  readonly dbConnectTimeoutMs: number;
  /**
   * API keys accepted by the auth middleware, each with its granted scopes. Placeholder for a real
   * auth integration (OAuth/Entra): see README "Authentication and authorization (placeholder)".
   */
  readonly apiKeys: ReadonlyMap<string, readonly string[]>;
  readonly maxJsonBodyBytes: number;
  readonly maxExportRows: number;
  /** Delay before a run starts computing, giving POST .../cancel a real window to take effect before results exist. */
  readonly runStartDelayMs: number;
}

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  return parsed;
}

function databaseUrl(): string {
  const explicit = process.env.MATTERLAB_DATABASE_URL;
  if (explicit && explicit.trim() !== '') return explicit.trim();
  const host = env('MATTERLAB_DB_HOST', '127.0.0.1');
  const port = env('MATTERLAB_DB_PORT', '55432');
  const user = env('MATTERLAB_DB_USER', 'matterlab');
  const password = env('MATTERLAB_DB_PASSWORD', 'matterlab_local_dev');
  const name = env('MATTERLAB_DB_NAME', 'matterlab');
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}`;
}

function parseApiKeys(): ReadonlyMap<string, readonly string[]> {
  // "key1:scope_a,scope_b;key2:scope_a". Falls back to one permissive development key so the
  // stack works out of the box, exactly like the science service's development database password.
  const raw = env('MATTERLAB_API_KEYS', 'matterlab-dev-key:lab:read,lab:write');
  const keys = new Map<string, readonly string[]>();
  for (const entry of raw.split(';')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    // Split only at the first colon: scope names themselves contain colons (e.g. "lab:read"), and
    // String.prototype.split(sep, limit) truncates the result array rather than limiting the
    // number of splits (unlike Python's str.split(sep, maxsplit)), so a plain split(':', 2) would
    // silently drop everything after the second colon.
    const colonIndex = trimmed.indexOf(':');
    const key = colonIndex === -1 ? trimmed : trimmed.slice(0, colonIndex);
    const scopeList = colonIndex === -1 ? '' : trimmed.slice(colonIndex + 1);
    if (!key) continue;
    const scopes = scopeList
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    keys.set(key.trim(), scopes);
  }
  return keys;
}

export function loadConfig(): Config {
  return {
    databaseUrl: databaseUrl(),
    host: env('MATTERLAB_API_HOST', '0.0.0.0'),
    port: envInt('MATTERLAB_API_PORT', 8788),
    corsOrigins: env('MATTERLAB_CORS_ORIGINS', 'http://127.0.0.1:5273,http://localhost:5273,http://127.0.0.1:4273,http://localhost:4273')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
    logLevel: env('MATTERLAB_API_LOG_LEVEL', 'info') as Config['logLevel'],
    dbPoolMaxSize: envInt('MATTERLAB_DB_POOL_MAX_SIZE', 10),
    dbPoolIdleTimeoutMs: envInt('MATTERLAB_DB_POOL_IDLE_TIMEOUT_MS', 30_000),
    dbConnectTimeoutMs: envInt('MATTERLAB_DB_CONNECT_TIMEOUT_MS', 10_000),
    apiKeys: parseApiKeys(),
    maxJsonBodyBytes: envInt('MATTERLAB_API_MAX_JSON_BODY_BYTES', 2_000_000),
    maxExportRows: envInt('MATTERLAB_API_MAX_EXPORT_ROWS', 50_000),
    runStartDelayMs: envInt('MATTERLAB_API_RUN_START_DELAY_MS', 20),
  };
}
