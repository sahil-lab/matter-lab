import { atomCharge, getElement, sortedAtoms } from '@matterlab/core';
import type { Scene } from '@matterlab/core';
import { create } from 'zustand';
import { useScienceConnection } from '../services/connection';
import type { ScienceClient } from '../services/science-client';
import { notify, runEdit } from '../state/actions';
import { lab } from '../state/store';

export type RemoteMethod = 'xtb-optimize' | 'xtb-single' | 'pyscf-hf' | 'pyscf-dft';
export interface RemoteJob {
  readonly id: string;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unsupported';
  readonly progress: number | null;
  readonly method: string | null;
  readonly engine: { id: string; version: string | null };
  readonly converged: boolean | null;
  readonly input_hash: string;
  readonly error: { message: string; code: string } | null;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly input: unknown;
  readonly settings: unknown;
  readonly provenance: unknown;
}
interface RemoteCalculation {
  readonly source: Scene;
  readonly method: RemoteMethod;
  readonly job: RemoteJob;
}
export const useRemoteCalculation = create<{
  readonly busy: boolean; readonly record: RemoteCalculation | null; readonly problem: string | null;
}>(() => ({ busy: false, record: null, problem: null }));
let jobClient: ScienceClient | null = null;
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'unsupported']);

function validateJob(job: RemoteJob): RemoteJob {
  if (!/^[0-9a-f-]{36}$/i.test(job.id) || !['queued', 'running', ...terminal].includes(job.status)) throw new Error('The service returned an invalid job identifier or status.');
  return job;
}

export async function runRemoteCalculation(method: RemoteMethod, multiplicity: number | null): Promise<void> {
  if (useRemoteCalculation.getState().busy) return;
  const client = useScienceConnection.getState().client;
  const state = lab.get();
  if (!client || state.workspace !== 'architect' || state.scene.atoms.size === 0) {
    notify('warning', 'Connect a science service and open a molecule first');
    return;
  }
  const source = state.scene;
  const atoms = sortedAtoms(source);
  const charge = atoms.reduce((total, atom) => total + atomCharge(atom), 0);
  useRemoteCalculation.setState({ busy: true, problem: null, record: null });
  jobClient = client;
  try {
    const kind = method === 'xtb-optimize' ? 'xtb.geometry_optimization' : method === 'xtb-single' ? 'xtb.single_point' : 'pyscf.single_point';
    const settings = method.startsWith('xtb') ? { method: 'GFN2-xTB', ...(method === 'xtb-optimize' ? { record_trajectory: true } : {}) }
      : method === 'pyscf-hf' ? { method: 'hf', basis: 'sto-3g' } : { method: 'dft', functional: 'b3lyp', basis: 'def2-svp' };
    let job = validateJob(await client.json<RemoteJob>('/v1/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind, settings, timeout_seconds: 120,
        input: {
          structure: { format: 'atoms', atoms: atoms.map((atom) => ({ element: getElement(atom.protons).symbol, x: atom.position[0], y: atom.position[1], z: atom.position[2] })) },
          charge, ...(multiplicity === null ? {} : { multiplicity }),
        },
      }),
    }));
    const deadline = performance.now() + 150_000;
    useRemoteCalculation.setState({ record: { source, method, job } });
    while (!terminal.has(job.status)) {
      if (performance.now() > deadline) throw new Error(`Stopped waiting for job ${job.id}. Its server status is not confirmed; cancel or inspect the backend before submitting another.`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      job = validateJob(await client.json<RemoteJob>(`/v1/jobs/${job.id}`));
      useRemoteCalculation.setState({ record: { source, method, job } });
    }
    if (job.status === 'failed' || job.status === 'unsupported') {
      useRemoteCalculation.setState({ problem: job.error?.message ?? `The remote calculation ended as ${job.status}.` });
    }
  } catch (error) {
    useRemoteCalculation.setState({ problem: error instanceof Error ? error.message : String(error) });
  } finally {
    useRemoteCalculation.setState({ busy: false });
  }
}

export async function cancelRemoteCalculation(): Promise<void> {
  const record = useRemoteCalculation.getState().record;
  if (!record || !jobClient || terminal.has(record.job.status)) return;
  try {
    const job = validateJob(await jobClient.json<RemoteJob>(`/v1/jobs/${record.job.id}`, { method: 'DELETE' }));
    useRemoteCalculation.setState({ record: { ...record, job } });
  } catch (error) {
    useRemoteCalculation.setState({ problem: error instanceof Error ? error.message : String(error) });
  }
}

export function applyRemoteGeometry(): void {
  const record = useRemoteCalculation.getState().record;
  if (!record || record.method !== 'xtb-optimize' || record.job.status !== 'succeeded' || !record.job.converged || !record.job.result?.converged) {
    notify('warning', 'Only a converged quantum optimization can be applied');
    return;
  }
  if (lab.get().scene !== record.source || lab.get().workspace !== 'architect') {
    notify('warning', 'The molecule changed during this calculation', 'The result is retained, but it cannot overwrite a different structure.');
    return;
  }
  const atoms = sortedAtoms(record.source);
  const output = record.job.result.atoms;
  if (!Array.isArray(output) || output.length !== atoms.length) {
    notify('error', 'The remote geometry has a different atom count');
    return;
  }
  const positions: Array<{ id: number; position: readonly [number, number, number] }> = [];
  for (let i = 0; i < atoms.length; i++) {
    const value: unknown = output[i];
    if (!value || typeof value !== 'object' || !('index' in value) || value.index !== i || !('atomic_number' in value) ||
        value.atomic_number !== atoms[i]!.protons || !('x' in value) || !('y' in value) || !('z' in value) ||
        typeof value.x !== 'number' || typeof value.y !== 'number' || typeof value.z !== 'number' || ![value.x, value.y, value.z].every(Number.isFinite)) {
      notify('error', 'The remote geometry does not match the input atoms');
      return;
    }
    positions.push({ id: atoms[i]!.id, position: [value.x, value.y, value.z] });
  }
  runEdit('Apply GFN2-xTB optimized geometry', (editor) => {
    for (const atom of positions) editor.moveAtom(atom.id, atom.position);
  });
  notify('success', 'Applied the computed quantum geometry', 'One undoable edit. A local model minimum is not proof of chemical stability.');
}
