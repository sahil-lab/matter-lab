import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  DEFAULT_SCIENCE_URL, MAX_WORKBOOK_BYTES, ScienceClient, ServiceError, saveDownload,
} from '../../services/science-client';
import type {
  CompoundRecord, ElementRecord, ScientificEngine, ServiceHealth, SourcedPage, WorkbookFormat, WorkbookImportReport,
} from '../../services/science-client';
import { Button, Note } from '../kit';
import './backend.css';

export interface BackendPanelProps {
  readonly initialBaseUrl?: string;
  readonly onClientChange?: (client: ScienceClient | null) => void;
  readonly onChooseCompound?: (compound: CompoundRecord) => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed. No remote write is confirmed.';
}

function importReport(error: unknown): WorkbookImportReport | null {
  if (!(error instanceof ServiceError) || !error.details || typeof error.details !== 'object') return null;
  const report = error.details as Partial<WorkbookImportReport>;
  return report.outcome === 'rejected' && Array.isArray(report.errors) ? report as WorkbookImportReport : null;
}

export function BackendPanel({ initialBaseUrl = DEFAULT_SCIENCE_URL, onClientChange, onChooseCompound }: BackendPanelProps) {
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [token, setToken] = useState('');
  const [client, setClient] = useState<ScienceClient | null>(null);
  const [tab, setTab] = useState<'connection' | 'catalogue' | 'excel'>('connection');
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [engines, setEngines] = useState<readonly ScientificEngine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [kind, setKind] = useState<'compounds' | 'elements'>('compounds');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [compounds, setCompounds] = useState<SourcedPage<CompoundRecord> | null>(null);
  const [elements, setElements] = useState<SourcedPage<ElementRecord> | null>(null);
  const [format, setFormat] = useState<WorkbookFormat | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<WorkbookImportReport | null>(null);
  const [preview, setPreview] = useState<{ readonly file: File; readonly sha256: string; readonly client: ScienceClient } | null>(null);
  const request = useRef<AbortController | null>(null);
  const callback = useRef(onClientChange);
  callback.current = onClientChange;
  useEffect(() => () => { request.current?.abort(); }, []);

  function invalidate() {
    request.current?.abort();
    setClient(null);
    callback.current?.(null);
    setHealth(null);
    setEngines([]);
    setCompounds(null);
    setElements(null);
    setFormat(null);
    setPreview(null);
    setReport(null);
    setNotice(null);
    setError(null);
    setBusy(false);
  }

  async function perform(action: (signal: AbortSignal) => Promise<void>) {
    request.current?.abort();
    const current = new AbortController();
    request.current = current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action(current.signal);
    } catch (cause) {
      if (!current.signal.aborted) {
        setError(message(cause));
        const rejected = importReport(cause);
        if (rejected) setReport(rejected);
      }
    } finally {
      if (request.current === current) setBusy(false);
    }
  }

  function connect(event: FormEvent) {
    event.preventDefault();
    void perform(async (signal) => {
      const next = new ScienceClient({ baseUrl, token: () => token });
      const [status, inventory] = await Promise.all([next.health(signal), next.engines(signal)]);
      if (signal.aborted) return;
      setHealth(status);
      setEngines(inventory.engines);
      setClient(next);
      callback.current?.(next);
      setNotice('PostgreSQL connection verified. Scientific engines are listed below; unavailable methods are not simulated.');
    });
  }

  function search(nextOffset = 0) {
    if (!client) return;
    void perform(async (signal) => {
      if (kind === 'compounds') {
        if (query.trim().length === 1) throw new Error('Use at least two characters for a compound name search.');
        const page = await client.compounds({ q: query.trim(), offset: nextOffset, limit: 25 }, signal);
        if (!signal.aborted) { setCompounds(page); setOffset(nextOffset); }
      } else {
        const page = await client.elements(signal);
        if (!signal.aborted) setElements(page);
      }
    });
  }

  function readFormat() {
    if (!client) return;
    void perform(async (signal) => {
      const result = await client.workbookFormat(signal);
      if (!signal.aborted) setFormat(result);
    });
  }

  function previewImport() {
    if (!client || !file) return;
    setPreview(null);
    setReport(null);
    void perform(async (signal) => {
      if (file.size > MAX_WORKBOOK_BYTES) throw new Error('Workbook limit: 10 MiB.');
      const result = await client.importWorkbook(file, true, signal);
      if (signal.aborted) return;
      setReport(result);
      if (!result.written && result.dry_run && result.outcome === 'dry-run' && result.error_count === 0) {
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), (byte) => byte.toString(16).padStart(2, '0')).join('');
        if (digest !== result.sha256) throw new Error('Preview file hash did not match. No commit is allowed.');
        if (!signal.aborted) setPreview({ file, sha256: digest, client });
      }
      setNotice('Preview only. PostgreSQL has not been changed.');
    });
  }

  function commitImport() {
    if (!client || !file || !preview || preview.file !== file || preview.client !== client) return;
    void perform(async (signal) => {
      const result = await client.importWorkbook(preview.file, false, signal);
      if (signal.aborted) return;
      setReport(result);
      setPreview(null);
      if (!result.written || result.outcome !== 'applied' || result.sha256 !== preview.sha256) {
        throw new Error('The service did not confirm an applied import of the previewed file. Recheck the catalogue before retrying.');
      }
      setNotice(`PostgreSQL import confirmed: ${result.totals.inserted} inserted, ${result.totals.updated} updated, ${result.totals.unchanged} unchanged.`);
    });
  }

  const filteredElements = elements?.items.filter((item) => `${item.atomic_number} ${item.symbol} ${item.name} ${item.category}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  return (
    <section className="ml-backend-panel" aria-label="Backend, catalogue and Excel">
      <header><h2>Connected science</h2><p>PostgreSQL is the remote source of truth. Browser drafts are not remote saves.</p></header>
      <nav aria-label="Backend sections" className="ml-backend-tabs">
        {(['connection', 'catalogue', 'excel'] as const).map((value) => (
          <Button key={value} active={tab === value} onClick={() => setTab(value)}>{value === 'excel' ? 'Excel' : value[0].toUpperCase() + value.slice(1)}</Button>
        ))}
      </nav>
      {error && <div role="alert"><Note severity="error">{error}</Note></div>}
      {notice && <div role="status"><Note severity="info">{notice}</Note></div>}
      {!client && tab !== 'connection' && <Note severity="warning">Not connected. Verify the backend in Connection before reading or writing remote data.</Note>}

      {tab === 'connection' && <>
        <form onSubmit={connect} className="ml-backend-form">
          <label>Science service URL<input className="ml-input" type="url" value={baseUrl} onChange={(event) => { invalidate(); setBaseUrl(event.target.value); }} required autoComplete="off" /></label>
          <label>Laboratory bearer token <span className="ml-backend-muted">(memory only; optional for legacy v1)</span>
            <input className="ml-input" type="password" value={token} onChange={(event) => { invalidate(); setToken(event.target.value); }} autoComplete="off" spellCheck={false} />
          </label>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Checking…' : 'Verify connection'}</Button>
        </form>
        <p className="ml-backend-muted">No credentials are written to localStorage, browser drafts or exported notebooks. Production endpoints require HTTPS and an explicitly configured CORS origin. Legacy v1 is a local-development API.</p>
        {health && <dl className="ml-backend-metrics">
          <dt>Database</dt><dd>Connected · schema {health.database.schema_version ?? 'unknown'} · {health.database.latency_ms.toFixed(1)} ms</dd>
          <dt>Jobs</dt><dd>{health.jobs.running} running · {health.jobs.queued} queued</dd>
          <dt>Checked at</dt><dd>{health.time}</dd>
        </dl>}
        {engines.length > 0 && <ul className="ml-backend-engines">{engines.map((engine) => <li key={engine.id}>
          <strong>{engine.name}</strong><span>{engine.available ? `Available · ${engine.version ?? 'version unreported'}` : `Unavailable · ${engine.unavailable_reason ?? 'not installed'}`}</span>
        </li>)}</ul>}
      </>}

      {tab === 'catalogue' && <>
        <form className="ml-backend-search" onSubmit={(event) => { event.preventDefault(); search(); }}>
          <label>Catalogue<select className="ml-input" value={kind} onChange={(event) => { setKind(event.target.value as 'compounds' | 'elements'); setOffset(0); }}>{['compounds', 'elements'].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Search<input className="ml-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={kind === 'compounds' ? 'Name fragment (2+ characters)' : 'Symbol, name or atomic number'} /></label>
          <Button type="submit" variant="outline" disabled={!client || busy}>Search PostgreSQL</Button>
        </form>
        <p className="ml-backend-muted">A curated catalogue, not a complete list of compounds. Structure identity is not proof of stability, safety or novelty.</p>
        {kind === 'compounds' && compounds && <>
          <p role="status">{compounds.total} matches · showing {compounds.items.length === 0 ? 0 : offset + 1}–{offset + compounds.items.length}</p>
          <div className="ml-backend-table"><table><caption>Stored compound records and provenance</caption><thead><tr><th>Name / formula</th><th>Identity</th><th>Evidence / source</th>{onChooseCompound && <th>Open</th>}</tr></thead>
            <tbody>{compounds.items.map((item) => <tr key={item.id}>
              <td>{item.name}<small>{item.molecular_formula} · charge {item.formal_charge}</small></td>
              <td><code>{item.inchikey}</code><small>{item.canonical_smiles}</small></td><td>{item.evidence}<small>{item.source}</small></td>
              {onChooseCompound && <td><Button onClick={() => onChooseCompound(item)}>Use structure</Button></td>}
            </tr>)}</tbody></table></div>
          <div className="ml-backend-tabs"><Button disabled={busy || offset === 0} onClick={() => search(Math.max(0, offset - 25))}>Previous</Button><Button disabled={busy || offset + compounds.items.length >= compounds.total} onClick={() => search(offset + 25)}>Next</Button></div>
          <details><summary>Page source records</summary><pre>{JSON.stringify(compounds.sources, null, 2)}</pre></details>
        </>}
        {kind === 'elements' && elements && <>
          <p role="status">{filteredElements.length} of {elements.total} stored elements</p>
          <div className="ml-backend-table"><table><caption>Reference element catalogue</caption><thead><tr><th>Z</th><th>Element</th><th>Atomic weight (u)</th><th>Evidence / source</th></tr></thead><tbody>{filteredElements.map((item) => <tr key={item.atomic_number}><td>{item.atomic_number}</td><td>{item.symbol} · {item.name}</td><td>{item.standard_atomic_weight_u}</td><td>{item.evidence}<small>{item.source}</small></td></tr>)}</tbody></table></div>
          <details><summary>Page source records</summary><pre>{JSON.stringify(elements.sources, null, 2)}</pre></details>
        </>}
      </>}

      {tab === 'excel' && <>
        <Note severity="info">Excel is interchange, not the authoritative database. Preview validates on the actual server without writes; committing is a separate explicit action and is atomic.</Note>
        <div className="ml-backend-tabs">
          <Button disabled={!client || busy} onClick={readFormat}>Read workbook schema</Button>
          <Button disabled={!client || busy} onClick={() => { if (client) void perform(async (signal) => { const download = await client.exportWorkbook(signal); if (!signal.aborted) saveDownload(download); }); }}>Export legacy v1 workbook</Button>
        </div>
        <p className="ml-backend-muted">The legacy export contains the shared local v1 catalogue/notebook, not private Laboratory runs. Use the Laboratory scene export for owner-scoped eight-sheet notebooks.</p>
        {format && <details open><summary>{format.format} · {format.sheets.length} sheets</summary><ul>{format.sheets.map((sheet) => <li key={sheet.name}><strong>{sheet.name}</strong> · {sheet.columns.length} typed columns</li>)}</ul>{format.notes.map((note) => <p key={note}>{note}</p>)}</details>}
        <label className="ml-backend-file">Proposed workbook (.xlsx, up to 10 MiB)
          <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setReport(null); setNotice(null); }} />
        </label>
        <div className="ml-backend-tabs">
          <Button disabled={!client || !file || busy} onClick={previewImport}>1. Preview only</Button>
          <Button variant="primary" disabled={!preview || !client || preview.client !== client || preview.file !== file || busy} onClick={commitImport}>2. Commit previewed file</Button>
        </div>
        {report && <section aria-label="Import validation report"><h3>{report.written ? 'Remote import applied' : 'Preview — no writes'}</h3>
          <p>{report.summary}</p><p>{report.totals.rows} rows · {report.error_count} errors · SHA-256 <code>{report.sha256}</code></p>
          {report.errors.length > 0 && <div className="ml-backend-table"><table><caption>Workbook validation failures</caption><thead><tr><th>Sheet / row</th><th>Column</th><th>Problem</th></tr></thead><tbody>{report.errors.map((problem, index) => <tr key={index}><td>{problem.sheet ?? 'Workbook'} / {problem.row ?? '—'}</td><td>{problem.column ?? '—'}</td><td>{problem.code}: {problem.message}</td></tr>)}</tbody></table></div>}
          {report.errors_truncated && <p>Additional errors were truncated by the server. Correct these rows and preview again.</p>}
        </section>}
      </>}
    </section>
  );
}
