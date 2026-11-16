import { describe, expect, it, vi } from 'vitest';
import { ScienceClient, ServiceError, normalizeServiceUrl } from './science-client';

describe('existing science service client', () => {
  it('keeps bearer credentials out of URLs and browser storage', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ status: 'ok', database: { connected: true } }));
    const client = new ScienceClient({ baseUrl: 'http://127.0.0.1:8787/', token: () => 'memory-only-token', fetch: fetcher });
    await client.health();
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8787/health');
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer memory-only-token');
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
  });

  it('retains both legacy and RFC9457 error codes without claiming success', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: 'database_unavailable', message: 'No remote write', details: null } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ code: 'REVISION_CONFLICT', detail: 'Scene changed', traceId: 'trace', details: { currentRevision: 3 } }, { status: 409 }));
    const client = new ScienceClient({ fetch: fetcher });
    await expect(client.json('/v1/experiments')).rejects.toMatchObject({ status: 503, code: 'database_unavailable' });
    await expect(client.json('/api/v1/lab/scenes/id')).rejects.toMatchObject({ status: 409, code: 'REVISION_CONFLICT', details: { currentRevision: 3 }, traceId: 'trace' });
  });

  it('rejects unsafe remote HTTP, URL credentials and redirect-like API paths', async () => {
    for (const url of ['http://remote.example', 'https://user:password@example.test', 'https://example.test/?token=secret', 'https://example.test/#token']) {
      expect(() => normalizeServiceUrl(url)).toThrow(ServiceError);
    }
    expect(normalizeServiceUrl('https://example.test/science/')).toBe('https://example.test/science');
    await expect(new ScienceClient().json('//evil.test')).rejects.toMatchObject({ code: 'INVALID_API_PATH' });
  });

  it('makes workbook preview explicitly dry-run and commit explicitly atomic', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ outcome: 'dry-run', written: false }));
    const client = new ScienceClient({ fetch: fetcher });
    const file = new File(['bounded workbook fixture'], 'catalogue.xlsx');
    await client.importWorkbook(file, true);
    await client.importWorkbook(file, false);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      'http://127.0.0.1:8787/v1/excel/import?dry_run=true&atomic=true',
      'http://127.0.0.1:8787/v1/excel/import?dry_run=false&atomic=true',
    ]);
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
    expect(new Headers(init.headers).has('Content-Type')).toBe(false);
    await expect(client.importWorkbook(new File([], 'bad.xlsx'), false)).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
    await expect(client.importWorkbook(new File(['x'], 'script.xlsm'), false)).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('surfaces offline and unhealthy states instead of reporting connection success', async () => {
    const client = new ScienceClient({ fetch: vi.fn().mockRejectedValue(new TypeError('network')) });
    await expect(client.health()).rejects.toMatchObject({ status: 0, code: 'SERVICE_OFFLINE' });
    const unhealthy = new ScienceClient({ fetch: vi.fn().mockResolvedValue(Response.json({ status: 'ok', database: { connected: false } })) });
    await expect(unhealthy.health()).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
  });
});
