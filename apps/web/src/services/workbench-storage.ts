import { fromMolfile } from '@matterlab/core';
import { parseExperimentResult } from '@matterlab/reactions';
import { analyseScene } from '../science/chem';
import { useReaction, importExperimentFile } from '../reaction/store';
import { enterWorkspace, notify } from '../state/actions';
import { placeStructure } from '../state/commands';
import { buildProjectFile, openProjectFile } from '../state/persistence';
import { lab } from '../state/store';
import { selectedCandidate, candidateReport, importCandidate } from '../vault/store';
import type { CompoundRecord, Page, ScienceClient } from './science-client';

export type WorkbenchSnapshotKind = 'project' | 'reaction' | 'candidate';
export interface WorkbenchSnapshot {
  readonly format: 'matterlab.workbench-snapshot';
  readonly version: 1;
  readonly kind: WorkbenchSnapshotKind;
  readonly payload: unknown;
}
export interface RemoteWorkbenchRecord {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly revision: number;
  readonly inputs: { readonly snapshot: unknown };
}

export function captureWorkbench(kind: WorkbenchSnapshotKind): { title: string; snapshot: WorkbenchSnapshot } {
  let payload: unknown;
  let title: string;
  if (kind === 'project') {
    if (lab.get().workspace !== 'architect') throw new Error('Switch to the Architect before archiving the molecular project.');
    const project = buildProjectFile();
    payload = project;
    title = project.name;
  } else if (kind === 'reaction') {
    const state = useReaction.getState();
    if (!state.resultJson || !state.result) throw new Error('Run or open a reaction experiment before archiving it.');
    payload = JSON.parse(state.resultJson);
    title = state.result.input.title ?? 'Reaction experiment';
  } else {
    const candidate = selectedCandidate();
    if (!candidate) throw new Error('Select a Discovery Vault candidate before archiving it.');
    payload = candidateReport(candidate);
    title = candidate.title;
  }
  return { title, snapshot: { format: 'matterlab.workbench-snapshot', version: 1, kind, payload } };
}

export function saveWorkbench(client: ScienceClient, kind: WorkbenchSnapshotKind): Promise<RemoteWorkbenchRecord> {
  const captured = captureWorkbench(kind);
  return client.json('/v1/experiments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: captured.title, kind: `matterlab-${kind}`, inputs: { snapshot: captured.snapshot },
      notes: 'Client-generated workbench snapshot. PostgreSQL stores it verbatim; this does not certify its calculations, observations or candidate status.',
      tags: ['matterlab-workbench'],
    }),
  });
}
export function listWorkbench(client: ScienceClient, offset = 0): Promise<Page<RemoteWorkbenchRecord>> {
  return client.json(`/v1/experiments?tag=matterlab-workbench&limit=20&offset=${offset}`);
}

export async function restoreWorkbench(client: ScienceClient, id: string): Promise<WorkbenchSnapshotKind> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid saved notebook identifier.');
  const record = await client.json<RemoteWorkbenchRecord>(`/v1/experiments/${id}`);
  const value = record.inputs.snapshot;
  if (!value || typeof value !== 'object' || !('format' in value) || value.format !== 'matterlab.workbench-snapshot' ||
      !('version' in value) || value.version !== 1 || !('kind' in value) || !('payload' in value)) throw new Error('This is not a supported MATTER LAB workbench snapshot.');
  if (value.kind === 'project') {
    openProjectFile(value.payload);
    enterWorkspace('architect');
  } else if (value.kind === 'reaction') {
    const text = JSON.stringify(value.payload);
    parseExperimentResult(text);
    await importExperimentFile(new File([text], 'remote.experiment.json', { type: 'application/json' }));
    enterWorkspace('reactions');
  } else if (value.kind === 'candidate') {
    const problem = await importCandidate(JSON.stringify(value.payload));
    if (problem) throw new Error(problem);
    enterWorkspace('vault');
  } else {
    throw new Error('Unknown workbench snapshot type.');
  }
  return value.kind;
}

export async function openCatalogueCompound(client: ScienceClient, compound: CompoundRecord): Promise<void> {
  const response = await client.json<{
    succeeded: boolean; molblock: string | null; coordinate_unit: string; inchikey: string | null;
    warnings: string[]; force_field: { used: string | null; converged: boolean | null };
  }>('/v1/chem/3d', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ structure: { format: 'smiles', data: compound.canonical_smiles }, force_field: 'auto' }),
  });
  if (!response.succeeded || !response.molblock || response.coordinate_unit !== 'angstrom') {
    throw new Error(response.warnings?.join(' ') || 'The service did not return a supported 3D structure.');
  }
  const model = fromMolfile(response.molblock).scene;
  const identity = await analyseScene(model);
  if (!identity.ok || identity.inchiKey !== compound.inchikey || response.inchikey !== compound.inchikey) {
    throw new Error('The generated model does not reproduce the catalogue identity, so it was not opened.');
  }
  placeStructure(model, compound.name, 'replace');
  notify('info', 'Opened computed catalogue model', `RDKit ETKDG with ${response.force_field.used ?? 'no force-field cleanup'}; not a measured structure.${response.force_field.converged === false ? ' Cleanup did not converge.' : ''} ${response.warnings.join(' ')}`);
}
