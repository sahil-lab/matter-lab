import { hillFormula } from '@matterlab/core';
import { create } from 'zustand';
import { stageContents } from '../render/viewApi';
import { notify } from '../state/actions';
import { lab } from '../state/store';
import { currentRecord, useQuantum } from './quantum';
import type { QuantumRecord } from './quantum';
import { useCompute } from './store';

export interface QuantumSnapshot {
  readonly id: string;
  readonly title: string;
  readonly formula: string;
  readonly record: QuantumRecord;
  readonly fields: ReturnType<typeof stageContents>;
  readonly description: string;
}
export const useQuantumComparison = create<{ readonly snapshots: readonly QuantumSnapshot[] }>(() => ({ snapshots: [] }));

/** A read-only copy of a real calculation and its sampled fields, never another solver or edited scene. */
export function pinQuantumView(): void {
  const record = currentRecord();
  if (!record?.result.converged) {
    notify('warning', 'No converged calculation to compare', 'Run Hartree-Fock for the current geometry first.');
    return;
  }
  const replay = useCompute.getState();
  if (replay.replaying || replay.replayFrame !== null) {
    notify('warning', 'Stop geometry replay first', 'Comparison snapshots must use the geometry belonging to the wavefunction.');
    return;
  }
  const current = useQuantum.getState();
  if (current.fieldBusy || current.sliceBusy || current.molecularBusy) {
    notify('info', 'Wait for the field to finish', 'A partial field is not captured as a finished comparison.');
    return;
  }
  const snapshot: QuantumSnapshot = {
    id: crypto.randomUUID(), title: lab.get().projectName, formula: hillFormula(record.scene),
    record: structuredClone(record), fields: structuredClone(stageContents()),
    description: current.field.kind === 'off' ? 'Geometry; no electronic field displayed'
      : `${current.field.kind}${current.field.kind === 'orbital' ? ` ${current.field.orbital + 1}` : ''} / ${current.field.style}`,
  };
  const before = useQuantumComparison.getState().snapshots;
  useQuantumComparison.setState({ snapshots: [...before.slice(-1), snapshot] });
  notify('success', before.length < 2 ? 'Calculation view pinned' : 'Oldest comparison view replaced', 'The two most recent snapshots stay unchanged when the molecule is edited.');
}

export function clearQuantumComparisons(): void {
  useQuantumComparison.setState({ snapshots: [] });
}

export function comparableQuantumSystems(a: QuantumRecord, b: QuantumRecord): boolean {
  const signature = (record: QuantumRecord) => `${record.input.charge ?? 0}|${record.input.atoms.map((atom) => atom.z).sort((x, y) => x - y).join(',')}`;
  return signature(a) === signature(b) && a.result.nElectrons === b.result.nElectrons;
}
