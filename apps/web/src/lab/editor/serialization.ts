import { parseLabContract } from '@matterlab/contracts/lab';
import type { ExperimentScene, Transform } from '@matterlab/contracts/lab';
import type { EditorGroup, EditorSerializedState } from './types';

const MODES = ['select', 'translate', 'rotate', 'connect', 'operate'] as const;
const KEYS = ['schemaVersion', 'sceneId', 'activeStationId', 'selectedIds', 'lockedIds', 'groups', 'mode', 'snapM', 'angleStepDeg', 'initialTransforms'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid editor metadata object.');
  return value as Record<string, unknown>;
}
function identifiers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 512 || !value.every((id) => typeof id === 'string' && UUID_PATTERN.test(id))) {
    throw new Error('Editor selections must contain bounded UUID arrays.');
  }
  if (new Set(value).size !== value.length) throw new Error('Duplicate editor selection identifiers.');
  return value as string[];
}
export function parseEditorState(input: unknown, scene: ExperimentScene): EditorSerializedState {
  const data = object(input);
  if (Object.keys(data).some((key) => !KEYS.includes(key)) || data.schemaVersion !== 1 || data.sceneId !== scene.id) {
    throw new Error('Editor metadata has an unsupported version, domain fields, or a different scene ID.');
  }
  if (typeof data.snapM !== 'number' || !Number.isFinite(data.snapM) || data.snapM < 0 || data.snapM > 0.25 ||
      typeof data.angleStepDeg !== 'number' || !Number.isFinite(data.angleStepDeg) || data.angleStepDeg < 1 || data.angleStepDeg > 90 ||
      typeof data.mode !== 'string' || !MODES.includes(data.mode as typeof MODES[number])) {
    throw new Error('Editor precision settings are invalid.');
  }
  const apparatus = new Map(scene.apparatus.map((instance) => [instance.id, instance]));
  const stationIds = new Set(scene.stations.map((station) => station.id));
  if (typeof data.activeStationId !== 'string' || !stationIds.has(data.activeStationId)) throw new Error('The editor workstation no longer exists.');
  const selectedIds = identifiers(data.selectedIds).filter((id) => apparatus.has(id));
  const lockedIds = identifiers(data.lockedIds).filter((id) => apparatus.has(id));
  if (!Array.isArray(data.groups) || data.groups.length > 512) throw new Error('Editor group limit exceeded.');
  const groupIds = new Set<string>();
  const memberIds = new Set<string>();
  const groups: EditorGroup[] = [];
  for (const raw of data.groups) {
    const group = object(raw);
    if (Object.keys(group).some((key) => !['id', 'name', 'stationId', 'instanceIds'].includes(key)) ||
        typeof group.id !== 'string' || !UUID_PATTERN.test(group.id) || groupIds.has(group.id) ||
        typeof group.name !== 'string' || group.name.length === 0 || group.name.length > 80 ||
        typeof group.stationId !== 'string' || !stationIds.has(group.stationId)) throw new Error('Invalid editor group.');
    groupIds.add(group.id);
    const ids = identifiers(group.instanceIds).filter((id) => apparatus.has(id));
    if (ids.some((id) => memberIds.has(id) || apparatus.get(id)!.stationId !== group.stationId)) {
      throw new Error('Groups cannot overlap or cross workstations.');
    }
    ids.forEach((id) => memberIds.add(id));
    if (ids.length > 0) groups.push({ id: group.id, name: group.name, stationId: group.stationId, instanceIds: ids });
  }
  const originals = object(data.initialTransforms);
  if (Object.keys(originals).length > 512) throw new Error('Editor transform limit exceeded.');
  const initialTransforms: Record<string, Transform> = {};
  for (const [id, transform] of Object.entries(originals)) {
    if (!UUID_PATTERN.test(id)) throw new Error('Invalid original-transform identifier.');
    const instance = apparatus.get(id);
    if (instance) initialTransforms[id] = parseLabContract('ApparatusInstance', { ...instance, transform }).transform;
  }
  return Object.freeze({
    schemaVersion: 1, sceneId: scene.id, activeStationId: data.activeStationId,
    selectedIds: Object.freeze(selectedIds), lockedIds: Object.freeze(lockedIds),
    groups: Object.freeze(groups), mode: data.mode as EditorSerializedState['mode'],
    snapM: data.snapM, angleStepDeg: data.angleStepDeg, initialTransforms: Object.freeze(initialTransforms),
  });
}
export function serializeEditorState(state: EditorSerializedState, scene: ExperimentScene): string {
  return JSON.stringify(parseEditorState(state, scene));
}
export function deserializeEditorState(json: string, scene: ExperimentScene): EditorSerializedState {
  if (typeof json !== 'string' || json.length > 262_144) throw new Error('Editor metadata exceeds its size limit.');
  return parseEditorState(JSON.parse(json) as unknown, scene);
}
