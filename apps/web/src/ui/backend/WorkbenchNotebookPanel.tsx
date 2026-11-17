import { useState } from 'react';
import { listWorkbench, restoreWorkbench, saveWorkbench } from '../../services/workbench-storage';
import type { RemoteWorkbenchRecord, WorkbenchSnapshotKind } from '../../services/workbench-storage';
import type { Page, ScienceClient } from '../../services/science-client';
import { Button, Note } from '../kit';

export function WorkbenchNotebookPanel({ client, onOpened }: { client: ScienceClient | null; onOpened?: () => void }) {
  const [kind, setKind] = useState<WorkbenchSnapshotKind>('project');
  const [records, setRecords] = useState<Page<RemoteWorkbenchRecord> | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function run(operation: (service: ScienceClient) => Promise<void>) {
    if (!client || busy) return;
    setBusy(true); setProblem(null); setNotice(null);
    try { await operation(client); }
    catch (error) { setProblem(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <section aria-label="Remote molecular workbench notebooks">
    <h3>PostgreSQL workbench archive</h3>
    <p>Save and reopen complete molecular projects, reaction records and candidate reports. Each save creates a new snapshot; no existing record is silently overwritten.</p>
    <p>These are client-generated records, not independently verified server calculations. The legacy API is shared local-development storage; the instrument laboratory has its own authenticated notebook.</p>
    {problem && <div role="alert"><Note severity="error">{problem}</Note></div>}
    {notice && <p role="status">{notice}</p>}
    <label>Workbench record<select aria-label="Workbench record type" value={kind} onChange={(event) => setKind(event.target.value as WorkbenchSnapshotKind)}>
      <option value="project">Current molecular project</option><option value="reaction">Current reaction experiment</option><option value="candidate">Selected Vault candidate</option>
    </select></label>
    <div className="ml-actions">
      <Button disabled={!client || busy} onClick={() => void run(async (service) => {
        const saved = await saveWorkbench(service, kind);
        setNotice(`PostgreSQL confirmed "${saved.title}", revision ${saved.revision}.`);
        setRecords(await listWorkbench(service));
      })}>Save new workbench snapshot</Button>
      <Button disabled={!client || busy} onClick={() => void run(async (service) => setRecords(await listWorkbench(service)))}>Browse workbench snapshots</Button>
    </div>
    {records && <>
      <p>{records.total} saved snapshots</p>
      <ul className="ml-backend-engines">{records.items.map((record) => <li key={record.id}>
        <strong>{record.title}</strong><span>{record.kind} · revision {record.revision}</span>
        <Button disabled={busy} onClick={() => void run(async (service) => {
          await restoreWorkbench(service, record.id);
          setNotice('The saved record was validated and reopened.');
          onOpened?.();
        })}>Reopen workbench snapshot</Button>
      </li>)}</ul>
      <div className="ml-actions">
        <Button disabled={busy || records.offset === 0} onClick={() => void run(async (service) => setRecords(await listWorkbench(service, Math.max(0, records.offset - records.limit))))}>Previous snapshots</Button>
        <Button disabled={busy || records.offset + records.items.length >= records.total} onClick={() => void run(async (service) => setRecords(await listWorkbench(service, records.offset + records.limit)))}>Next snapshots</Button>
      </div>
    </>}
  </section>;
}
