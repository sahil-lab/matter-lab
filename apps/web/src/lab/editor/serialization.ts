import { UUID_PATTERN as CONTRACT_UUID_PATTERN } from '@matterlab/contracts/lab';
import type { ExperimentScene, Transform, ValidationResult } from '@matterlab/contracts/lab';
import type { EditorGroup, EditorSerializedState } from './types.ts';
import { EDITOR_STATE_JSON_SCHEMA } from './schema.ts';

export { EDITOR_STATE_JSON_SCHEMA } from './schema.ts';
export type { EditorSerializedState } from './types.ts';

const MODES = EDITOR_STATE_JSON_SCHEMA.properties.mode.enum;
const KEYS = Object.keys(EDITOR_STATE_JSON_SCHEMA.properties);
const UUID_PATTERN = new RegExp(CONTRACT_UUID_PATTERN);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid editor metadata object.');
  return value as Record<string, unknown>;
}
function identifiers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 512 || !value.every((id) => typeof id === 'string' && UUID_PATTERN.test(id))) {
    throw new Error('Editor selections must contain bounded UUID arrays.');
  }
  if (new Set(value).size !== value.length) throw new Error('Duplicate editor selection identifiers.');
  return [...value] as string[];
}
function transform(value: unknown): Transform {
  const data = object(value);
  if (Object.keys(data).some((key) => key !== 'positionM' && key !== 'quaternion')) throw new Error('Invalid editor transform fields.');
  if (!Array.isArray(data.positionM) || data.positionM.length !== 3 ||
      !data.positionM.every((item) => typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 10_000) ||
      !Array.isArray(data.quaternion) || data.quaternion.length !== 4 ||
      !data.quaternion.every((item) => typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1) ||
      Math.abs(Math.hypot(...data.quaternion) - 1) > 1e-6) {
    throw new Error('Editor transforms require canonical finite meter coordinates and normalized quaternions.');
  }
  return Object.freeze({
    positionM: Object.freeze([...data.positionM]) as unknown as Transform['positionM'],
    quaternion: Object.freeze([...data.quaternion]) as unknown as Transform['quaternion'],
  });
}
/**
 * Node-safe sidecar validation. A scene ID performs structural/identity checks;
 * a full scene additionally verifies stations/groups and prunes removed apparatus.
 */
export function parseEditorState(input: unknown, sceneOrId: ExperimentScene | string): EditorSerializedState {
  const scene = typeof sceneOrId === 'string' ? undefined : sceneOrId;
  const sceneId = typeof sceneOrId === 'string' ? sceneOrId : sceneOrId.id;
  const data = object(input);
  if (!UUID_PATTERN.test(sceneId) || Object.keys(data).some((key) => !KEYS.includes(key)) ||
      data.schemaVersion !== 1 || data.sceneId !== sceneId) {
    throw new Error('Editor metadata has an unsupported version, domain fields, or a different scene ID.');
  }
  if (typeof data.snapM !== 'number' || !Number.isFinite(data.snapM) || data.snapM < 0 || data.snapM > 0.25 ||
      typeof data.angleStepDeg !== 'number' || !Number.isFinite(data.angleStepDeg) || data.angleStepDeg < 1 || data.angleStepDeg > 90 ||
      typeof data.mode !== 'string' || !MODES.includes(data.mode as typeof MODES[number])) {
    throw new Error('Editor precision settings are invalid.');
  }
  const apparatus = scene ? new Map(scene.apparatus.map((instance) => [instance.id, instance])) : undefined;
  const stationIds = scene ? new Set(scene.stations.map((station) => station.id)) : undefined;
  if (typeof data.activeStationId !== 'string' || !UUID_PATTERN.test(data.activeStationId) ||
      stationIds && !stationIds.has(data.activeStationId)) throw new Error('The editor workstation no longer exists.');
  const selectedIds = identifiers(data.selectedIds).filter((id) => !apparatus || apparatus.get(id)?.stationId === data.activeStationId);
  const lockedIds = identifiers(data.lockedIds).filter((id) => !apparatus || apparatus.has(id));
  if (!Array.isArray(data.groups) || data.groups.length > 512) throw new Error('Editor group limit exceeded.');
  const groupIds = new Set<string>();
  const memberIds = new Set<string>();
  const groups: EditorGroup[] = [];
  for (const raw of data.groups) {
    const group = object(raw);
    if (Object.keys(group).some((key) => !['id', 'name', 'stationId', 'instanceIds'].includes(key)) ||
        typeof group.id !== 'string' || !UUID_PATTERN.test(group.id) || groupIds.has(group.id) ||
        typeof group.name !== 'string' || group.name.length === 0 || group.name.length > 80 ||
        typeof group.stationId !== 'string' || !UUID_PATTERN.test(group.stationId) ||
        stationIds && !stationIds.has(group.stationId)) throw new Error('Invalid editor group.');
    groupIds.add(group.id);
    const ids = identifiers(group.instanceIds).filter((id) => !apparatus || apparatus.has(id));
    if (ids.some((id) => memberIds.has(id) || apparatus && apparatus.get(id)!.stationId !== group.stationId)) {
      throw new Error('Groups cannot overlap or cross workstations.');
    }
    ids.forEach((id) => memberIds.add(id));
    if (ids.length > 0) groups.push(Object.freeze({
      id: group.id, name: group.name, stationId: group.stationId, instanceIds: Object.freeze(ids),
    }));
  }
  const originals = object(data.initialTransforms);
  if (Object.keys(originals).length > 512) throw new Error('Editor transform limit exceeded.');
  const initialTransforms: Record<string, Transform> = {};
  for (const [id, value] of Object.entries(originals)) {
    if (!UUID_PATTERN.test(id)) throw new Error('Invalid original-transform identifier.');
    const parsed = transform(value);
    if (!apparatus || apparatus.has(id)) initialTransforms[id] = parsed;
  }
  return Object.freeze({
    schemaVersion: 1, sceneId, activeStationId: data.activeStationId,
    selectedIds: Object.freeze(selectedIds), lockedIds: Object.freeze(lockedIds),
    groups: Object.freeze(groups), mode: data.mode as EditorSerializedState['mode'],
    snapM: data.snapM, angleStepDeg: data.angleStepDeg, initialTransforms: Object.freeze(initialTransforms),
  });
}
export function validateEditorState(input: unknown, sceneOrId: ExperimentScene | string): ValidationResult<EditorSerializedState> {
  try { return { ok: true, value: parseEditorState(input, sceneOrId) }; }
  catch (error) {
    return { ok: false, errors: [{ code: 'INVALID_INPUT', path: '', message: error instanceof Error ? error.message : 'Invalid editor metadata.' }] };
  }
}
export function serializeEditorState(state: EditorSerializedState, sceneOrId: ExperimentScene | string): string {
  return JSON.stringify(parseEditorState(state, sceneOrId));
}
export function deserializeEditorState(json: string, sceneOrId: ExperimentScene | string): EditorSerializedState {
  if (typeof json !== 'string' || json.length > 262_144 || new TextEncoder().encode(json).byteLength > 262_144) {
    throw new Error('Editor metadata exceeds its size limit.');
  }
  return parseEditorState(JSON.parse(json) as unknown, sceneOrId);
}
