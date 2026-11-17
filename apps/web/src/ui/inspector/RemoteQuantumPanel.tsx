import { useState } from 'react';
import { applyRemoteGeometry, cancelRemoteCalculation, runRemoteCalculation, useRemoteCalculation } from '../../compute/remote';
import type { RemoteMethod } from '../../compute/remote';
import { useScienceConnection } from '../../services/connection';
import { downloadText } from '../../state/commands';
import { useLab } from '../../state/store';
import { Button, EvidenceBadge, Note, Section } from '../kit';

export function RemoteQuantumPanel() {
  const client = useScienceConnection((state) => state.client);
  const { busy, record, problem } = useRemoteCalculation();
  const scene = useLab((state) => state.scene);
  const [method, setMethod] = useState<RemoteMethod>('xtb-optimize');
  const [spin, setSpin] = useState('auto');
  const job = record?.job;
  const result = job?.status === 'succeeded' ? job.result : null;
  const energy = result?.energy_final_hartree ?? result?.energy_hartree;
  const force = result?.max_force_final_ev_per_angstrom;
  const forces = result?.forces_ev_per_angstrom;
  return <Section title="Connected quantum engines" right={<EvidenceBadge level="computed" />}>
    <p className="ml-empty">Uses the connected Python service, not the local UFF optimizer. The exact input, method, software version and result are retained as a server job.</p>
    {!client && <Note severity="info">Open Display settings → Scientific backend &amp; catalogs to connect. Missing engines return unsupported, never substituted energies.</Note>}
    <label className="ml-label">Method<select className="ml-select" aria-label="Remote quantum method" value={method} disabled={busy} onChange={(event) => setMethod(event.target.value as RemoteMethod)}>
      <option value="xtb-optimize">GFN2-xTB geometry optimization</option>
      <option value="xtb-single">GFN2-xTB single point</option>
      <option value="pyscf-hf">PySCF HF / STO-3G single point</option>
      <option value="pyscf-dft">PySCF B3LYP / def2-SVP single point</option>
    </select></label>
    <label className="ml-label">Spin multiplicity<select className="ml-select" aria-label="Remote spin multiplicity" value={spin} disabled={busy} onChange={(event) => setSpin(event.target.value)}>
      <option value="auto">Parity default (singlet / doublet)</option>
      {Array.from({ length: 7 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
    </select></label>
    <p className="ml-empty">The parity default is not a ground-state spin search. xTB is semiempirical; HF/DFT and their basis choices have different approximations. No nuclear rearrangement is modeled.</p>
    <div className="ml-actions">
      <Button variant="primary" disabled={!client || busy || scene.atoms.size === 0} data-testid="remote-quantum-run" onClick={() => void runRemoteCalculation(method, spin === 'auto' ? null : Number(spin))}>
        {busy ? 'Computing remotely...' : 'Run connected calculation'}
      </Button>
      {job && !['succeeded', 'failed', 'cancelled', 'unsupported'].includes(job.status) &&
        <Button variant="outline" onClick={() => void cancelRemoteCalculation()}>Request cancellation</Button>}
    </div>
    {problem && <Note severity="warning"><span data-testid="remote-quantum-error">{problem}</span></Note>}
    {job && <>
      <p data-testid="remote-quantum-status">{job.status} · {job.method ?? method} · {job.engine.id} {job.engine.version ?? '(version unreported)'}</p>
      {busy && <progress max={1} value={job.progress ?? undefined} aria-label="Remote calculation progress" />}
      {result && <>
        {job.converged === false && <Note severity="warning">The engine did not converge. These are recorded intermediate results, not a stationary-point claim.</Note>}
        <dl className="ml-kv">
          {typeof energy === 'number' && Number.isFinite(energy) && <><dt>Electronic energy</dt><dd>{energy.toFixed(8)} Eh</dd></>}
          {typeof force === 'number' && Number.isFinite(force) && <><dt>Largest final force</dt><dd>{force.toPrecision(4)} eV/Å</dd></>}
          <dt>Converged</dt><dd>{job.converged === null ? 'Not reported' : job.converged ? 'Yes' : 'No'}</dd>
        </dl>
        {Array.isArray(result.warnings) && result.warnings.filter((value): value is string => typeof value === 'string').map((warning) => <p className="ml-empty" key={warning}>{warning}</p>)}
        {Array.isArray(forces) && forces.every((vector: unknown) => Array.isArray(vector) && vector.length === 3 && vector.every((value: unknown) => typeof value === 'number' && Number.isFinite(value))) && (
          <details className="ml-details"><summary>Atomic forces at the returned geometry</summary>
            <div style={{ overflowX: 'auto' }}><table><caption>Cartesian force components / eV Å⁻¹, in input atom order</caption>
              <thead><tr><th>Atom</th><th>X</th><th>Y</th><th>Z</th></tr></thead>
              <tbody>{forces.map((vector: number[], index) => <tr key={index}><th>{index + 1}</th>{vector.map((value, axis) => <td key={axis}>{value.toExponential(3)}</td>)}</tr>)}</tbody>
            </table></div>
          </details>
        )}
        {record?.method === 'xtb-optimize' && <Button variant="outline" disabled={!job.converged || scene !== record.source} onClick={applyRemoteGeometry} data-testid="apply-remote-geometry">Apply optimized geometry</Button>}
      </>}
      {record && scene !== record.source && <Note severity="info">This record belongs to an earlier geometry; it cannot overwrite the current structure.</Note>}
      <Button size="sm" onClick={() => downloadText(`calculation-${job.id}.json`, `${JSON.stringify(job, null, 2)}\n`, 'application/json')}>Export complete server record</Button>
      <p className="ml-empty">Input SHA-256: <span className="ml-mono">{job.input_hash}</span></p>
    </>}
  </Section>;
}
