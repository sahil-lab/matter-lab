import { LAB_JSON_SCHEMA, UUID_PATTERN } from '@matterlab/contracts/lab';

const identifier = { type: 'string', pattern: UUID_PATTERN } as const;
const identifiers = { type: 'array', items: identifier, uniqueItems: true, maxItems: 512 } as const;

/** Editor-only sidecar schema; references the canonical transform definitions verbatim. */
export const EDITOR_STATE_JSON_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:matterlab:editor-state:1',
  title: 'Matter Lab editor-only state',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'sceneId', 'activeStationId', 'selectedIds', 'lockedIds', 'groups', 'mode', 'snapM', 'angleStepDeg', 'initialTransforms'],
  properties: {
    schemaVersion: { const: 1 },
    sceneId: identifier,
    activeStationId: identifier,
    selectedIds: identifiers,
    lockedIds: identifiers,
    groups: {
      type: 'array', maxItems: 512,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'name', 'stationId', 'instanceIds'],
        properties: {
          id: identifier, name: { type: 'string', minLength: 1, maxLength: 80 },
          stationId: identifier, instanceIds: identifiers,
        },
      },
    },
    mode: { enum: ['select', 'translate', 'rotate', 'connect', 'operate'] },
    snapM: { type: 'number', minimum: 0, maximum: 0.25 },
    angleStepDeg: { type: 'number', minimum: 1, maximum: 90 },
    initialTransforms: {
      type: 'object', maxProperties: 512, propertyNames: identifier,
      additionalProperties: { $ref: '#/$defs/Transform' },
    },
  },
  $defs: {
    Transform: LAB_JSON_SCHEMA.$defs.Transform,
    Vec3M: LAB_JSON_SCHEMA.$defs.Vec3M,
    Quaternion: LAB_JSON_SCHEMA.$defs.Quaternion,
  },
} as const);
