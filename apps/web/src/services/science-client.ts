/** The existing FastAPI service. Credentials stay in memory and are never placed in URLs. */
export type JsonObject = Readonly<Record<string, unknown>>;

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface Provenance {
  readonly source: JsonObject;
  readonly [key: string]: unknown;
}

export interface SourcedPage<T> extends Page<T> {
  readonly sources: Readonly<Record<string, Provenance>>;
}

export interface ServiceHealth {
  readonly status: 'ok';
  readonly service: string;
  readonly version: string;
  readonly time: string;
  readonly database: {
    readonly connected: boolean;
    readonly schema_version: string | null;
    readonly migrations_applied: number;
    readonly latency_ms: number;
  };
  readonly jobs: { readonly supervisor_running: boolean; readonly running: number; readonly queued: number; readonly max_worker_processes: number };
  readonly engines: Readonly<Record<string, string | null>>;
}

export interface ScientificEngine {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly version: string | null;
  readonly unavailable_reason: string | null;
  readonly capabilities: readonly string[];
  readonly available_job_kinds: readonly string[];
  readonly license: string | null;
  readonly url: string | null;
}

export interface ElementRecord {
  readonly atomic_number: number;
  readonly symbol: string;
  readonly name: string;
  readonly category: string;
  readonly standard_atomic_weight_u: number;
  readonly evidence: string;
  readonly source: string;
}

export interface CompoundRecord {
  readonly id: string;
  readonly name: string;
  readonly iupac_name: string | null;
  readonly canonical_smiles: string;
  readonly inchikey: string;
  readonly molecular_formula: string;
  readonly molecular_weight_g_per_mol: number;
  readonly monoisotopic_mass_u: number;
  readonly formal_charge: number;
  readonly external_ids: JsonObject;
  readonly evidence: string;
  readonly source: string;
}

export interface WorkbookFormat {
  readonly format: string;
  readonly max_cell_characters: number;
  readonly notes: readonly string[];
  readonly sheets: readonly {
    readonly name: string;
    readonly key: readonly string[];
    readonly columns: readonly {
      readonly header: string;
      readonly type: string;
      readonly unit: string | null;
      readonly required: boolean;
      readonly read_only: boolean;
      readonly allowed_values: readonly string[] | null;
    }[];
  }[];
}

export interface ImportCounts {
  readonly rows: number;
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly rejected: number;
}

export interface WorkbookImportReport {
  readonly import_id: string | null;
  readonly outcome: 'applied' | 'dry-run' | 'rejected';
  readonly written: boolean;
  readonly dry_run: boolean;
  readonly atomic: boolean;
  readonly filename: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly imported_at: string;
  readonly summary: string;
  readonly totals: ImportCounts;
  readonly sheets: Readonly<Record<string, ImportCounts & { readonly present: boolean }>>;
  readonly error_count: number;
  readonly errors_truncated: boolean;
  readonly errors: readonly { readonly sheet: string | null; readonly row: number | null; readonly column: string | null; readonly code: string; readonly message: string }[];
}

export interface Download {
  readonly blob: Blob;
  readonly filename: string;
}

export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly traceId: string | undefined;

  constructor(status: number, code: string, message: string, details?: unknown, traceId?: string) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.traceId = traceId;
  }
}

export const DEFAULT_SCIENCE_URL = 'http://127.0.0.1:8787';
export const MAX_WORKBOOK_BYTES = 10 * 1024 * 1024;

export function normalizeServiceUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ServiceError(0, 'INVALID_SERVICE_URL', 'Enter an absolute HTTP(S) service URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new ServiceError(0, 'UNSAFE_SERVICE_URL', 'Use HTTPS outside localhost. Credentials, query strings and fragments cannot be part of the service URL.');
  }
  return url.toString().replace(/\/+$/, '');
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function responseError(response: Response): Promise<ServiceError> {
  let payload: unknown;
  try { payload = await response.json(); } catch { payload = undefined; }
  if (object(payload)) {
    if (typeof payload.code === 'string' && typeof payload.detail === 'string') {
      return new ServiceError(response.status, payload.code, payload.detail, payload.details, typeof payload.traceId === 'string' ? payload.traceId : undefined);
    }
    if (object(payload.error) && typeof payload.error.code === 'string' && typeof payload.error.message === 'string') {
      return new ServiceError(response.status, payload.error.code, payload.error.message, payload.error.details);
    }
  }
  return new ServiceError(response.status, 'HTTP_ERROR', `The science service returned HTTP ${response.status}.`);
}

export interface ScienceClientOptions {
  readonly baseUrl?: string;
  readonly token?: () => string | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export class ScienceClient {
  readonly baseUrl: string;
  private readonly token: () => string | undefined;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: ScienceClientOptions = {}) {
    this.baseUrl = normalizeServiceUrl(options.baseUrl ?? DEFAULT_SCIENCE_URL);
    this.token = options.token ?? (() => undefined);
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async response(path: string, init: RequestInit = {}, timeoutMs = this.timeoutMs): Promise<Response> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new ServiceError(0, 'INVALID_API_PATH', 'API paths must be relative to the configured service.');
    const controller = new AbortController();
    const external = init.signal;
    const abort = () => controller.abort(external?.reason);
    if (external?.aborted) abort();
    else external?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let handedOff = false;
    const cleanup = () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', abort);
    };
    const headers = new Headers(init.headers);
    const token = this.token()?.trim();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    headers.set('Accept', headers.get('Accept') ?? 'application/json');
    try {
      const response = await this.fetcher(this.baseUrl + path, {
        ...init, headers, signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
      });
      if (!response.ok) throw await responseError(response);
      if (!response.body) return response;
      const reader = response.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { cleanup(); reader.releaseLock(); output.close(); }
            else output.enqueue(chunk.value);
          } catch (error) {
            cleanup();
            output.error(error);
          }
        },
        async cancel(reason) {
          controller.abort();
          try { await reader.cancel(reason); } finally { cleanup(); reader.releaseLock(); }
        },
      });
      handedOff = true;
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      if (external?.aborted) throw new ServiceError(0, 'REQUEST_ABORTED', 'The request was cancelled. A remote write may still have completed; reconnect before retrying.');
      throw new ServiceError(0, controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'SERVICE_OFFLINE',
        'The science service could not confirm this request. No remote save is confirmed; check its URL, CORS configuration and PostgreSQL.');
    } finally {
      if (!handedOff) cleanup();
    }
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.response(path, init);
    try { return await response.json() as T; }
    catch { throw new ServiceError(response.status, 'INVALID_RESPONSE', 'The service returned malformed JSON.'); }
  }

  async health(signal?: AbortSignal): Promise<ServiceHealth> {
    const result = await this.json<ServiceHealth>('/health', { signal });
    if (result.status !== 'ok' || !result.database?.connected) throw new ServiceError(503, 'DATABASE_UNAVAILABLE', 'The backend has not verified its PostgreSQL connection.');
    return result;
  }

  engines(signal?: AbortSignal): Promise<{ readonly engines: readonly ScientificEngine[]; readonly detected_at: string }> {
    return this.json('/v1/engines', { signal });
  }

  elements(signal?: AbortSignal): Promise<SourcedPage<ElementRecord>> {
    return this.json('/v1/elements', { signal });
  }

  compounds(query: { readonly q?: string; readonly formula?: string; readonly limit?: number; readonly offset?: number } = {}, signal?: AbortSignal): Promise<SourcedPage<CompoundRecord>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value));
    return this.json(`/v1/compounds?${params}`, { signal });
  }

  workbookFormat(signal?: AbortSignal): Promise<WorkbookFormat> {
    return this.json('/v1/excel/format', { signal });
  }

  async exportWorkbook(signal?: AbortSignal): Promise<Download> {
    return this.download('/v1/excel/export', 'matterlab-catalogue.xlsx', signal);
  }

  async download(path: string, fallback: string, signal?: AbortSignal): Promise<Download> {
    const response = await this.response(path, { signal }, 60_000);
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const candidate = /filename="([^"]+)"/i.exec(disposition)?.[1] ?? fallback;
    const filename = candidate.replace(/[\\/\u0000-\u001f:]/g, '_').slice(0, 180);
    return { blob: await response.blob(), filename };
  }

  async importWorkbook(file: File, dryRun: boolean, signal?: AbortSignal): Promise<WorkbookImportReport> {
    if (!/\.xlsx$/i.test(file.name) || file.size === 0 || file.size > MAX_WORKBOOK_BYTES) {
      throw new ServiceError(0, 'INVALID_WORKBOOK', 'Choose a nonempty .xlsx workbook no larger than 10 MiB.');
    }
    const data = new FormData();
    data.append('file', file);
    const response = await this.response(`/v1/excel/import?dry_run=${dryRun ? 'true' : 'false'}&atomic=true`, { method: 'POST', body: data, signal }, 60_000);
    return await response.json() as WorkbookImportReport;
  }
}

export function saveDownload(download: Download): void {
  const url = URL.createObjectURL(download.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = download.filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
