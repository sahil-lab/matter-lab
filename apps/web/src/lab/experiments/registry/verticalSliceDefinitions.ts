/**
 * Apparatus definitions for the first shared vertical slice (00_SHARED_INTEGRATION_CONTRACT.md
 * Section 6: bench, stand, clamp, burette, flask, optionally stirrer and pH probe).
 *
 * STUB STATUS: Agent 03 owns the real instrument library (`apps/web/src/lab/apparatus/**`) with
 * physically scaled meshes, materials and the final socket/compatibility matrix. Agent 03's branch
 * was not available while this reducer was written, so every definition below is marked
 * `isPlaceholder: true` and uses procedural-grade dimensions only — no asset references. This lets
 * the reducer, the capability registry and the acid-base titration plugin be exercised end to end
 * and unit-tested. **Reconcile field-for-field with Agent 03's shipped definitions before this
 * leaves development** (same `id`s should be kept where the shape matches, so saved scenes do not
 * need a migration).
 */
import type { ApparatusDefinition } from '@matterlab/contracts';

const ORIGIN_TRANSFORM = { positionM: [0, 0, 0] as const, quaternion: [0, 0, 0, 1] as const };

export const BENCH_DEFINITION: ApparatusDefinition = {
  id: 'bench.standard',
  kind: 'BENCH',
  label: 'Laboratory bench',
  category: 'furniture',
  capabilities: ['MOUNT'],
  dimensionsM: { width: 1.2, height: 0.9, depth: 0.6 },
  massKg: 40,
  sockets: [
    { id: 'surface', kind: 'MECHANICAL', localTransform: ORIGIN_TRANSFORM, gender: 'SOCKET', maxConnections: 8 },
  ],
  collisionRadiusM: 0.7,
  permittedTransforms: { translate: true, rotateAxes: ['y'] },
  controls: [],
  defaultConfig: {},
  isPlaceholder: true,
};

export const STAND_DEFINITION: ApparatusDefinition = {
  id: 'stand.retort.standard',
  kind: 'STAND',
  label: 'Retort stand',
  category: 'support',
  capabilities: ['MOUNT'],
  dimensionsM: { width: 0.2, height: 0.75, depth: 0.2 },
  massKg: 2.2,
  sockets: [
    { id: 'foot', kind: 'MECHANICAL', localTransform: ORIGIN_TRANSFORM, gender: 'PLUG', maxConnections: 1 },
    {
      id: 'pole',
      kind: 'MECHANICAL',
      localTransform: ORIGIN_TRANSFORM,
      gender: 'SOCKET',
      acceptsKinds: ['CLAMP', 'PH_PROBE'],
      requiresCapability: 'MOUNTABLE',
      maxConnections: 4,
    },
  ],
  collisionRadiusM: 0.15,
  permittedTransforms: { translate: true, rotateAxes: ['y'] },
  controls: [],
  defaultConfig: {},
  isPlaceholder: true,
};

export const CLAMP_DEFINITION: ApparatusDefinition = {
  id: 'clamp.burette.standard',
  kind: 'CLAMP',
  label: 'Burette clamp',
  category: 'support',
  capabilities: ['MOUNT', 'MOUNTABLE'],
  dimensionsM: { width: 0.15, height: 0.05, depth: 0.08 },
  massKg: 0.4,
  sockets: [
    {
      id: 'grip',
      kind: 'MECHANICAL',
      localTransform: ORIGIN_TRANSFORM,
      gender: 'PLUG',
      acceptsKinds: ['STAND'],
      maxConnections: 1,
    },
    {
      id: 'bore',
      kind: 'MECHANICAL',
      localTransform: ORIGIN_TRANSFORM,
      gender: 'SOCKET',
      acceptsKinds: ['BURETTE'],
      requiresCapability: 'MOUNTABLE',
      maxConnections: 1,
    },
  ],
  collisionRadiusM: 0.1,
  permittedTransforms: { translate: true, rotateAxes: ['y'] },
  controls: [],
  defaultConfig: {},
  isPlaceholder: true,
};

/**
 * Flow rate and capacity are chosen so this fixture is convenient to drive in whole-second,
 * whole-tick test scenarios (e.g. `capacityL` delivered over a handful of ticks at full valve
 * opening) — **illustrative test tuning, not a measured instrument**. Agent 03's real Class-A 50 mL
 * burette must replace these numbers; `isPlaceholder` flags that this has not happened yet.
 *
 * AGENT 08 RECONCILIATION NOTE: `maxFlowRateLPerS` below has been updated from the original 0.005
 * to 0.002 to match Agent 03's actual shipped `BURETTE_50ML_CLASS_A` definition
 * (`apps/web/src/lab/apparatus/definitions/burette.ts`, `flowPorts[0].maxFlowRateLPerS`), which was
 * available by the time this integration pass ran. Everything else here is still Agent 07's
 * placeholder pending full field-for-field reconciliation with Agent 03's richer definition shape
 * (roles, geometry checks, 3D assets) — that remains flagged for the human orchestrator / Agent 10.
 */
export const BURETTE_DEFINITION: ApparatusDefinition = {
  id: 'burette.class-a.50ml',
  kind: 'BURETTE',
  label: '50 mL burette',
  category: 'glassware',
  capabilities: ['MOUNTABLE', 'FLOW_SOURCE', 'CONTAINER', 'MEASUREMENT'],
  dimensionsM: { width: 0.03, height: 0.6, depth: 0.03 },
  massKg: 0.3,
  capacityL: 0.05,
  flowModel: { id: 'linear-valve-v1', maxFlowRateLPerS: 0.002 },
  sockets: [
    { id: 'barrel', kind: 'MECHANICAL', localTransform: ORIGIN_TRANSFORM, gender: 'PLUG', maxConnections: 1 },
    {
      id: 'tip',
      kind: 'FLUID',
      localTransform: ORIGIN_TRANSFORM,
      gender: 'PLUG',
      acceptsKinds: ['FLASK', 'BEAKER'],
      maxConnections: 1,
    },
  ],
  collisionRadiusM: 0.05,
  permittedTransforms: { translate: true, rotateAxes: ['y'] },
  controls: [
    { id: 'valveOpening', label: 'Stopcock', kind: 'range', min: 0, max: 1, step: 0.01, appliesVia: 'SET_VALVE' },
  ],
  defaultConfig: { valveOpening: 0 },
  isPlaceholder: true,
};

export const FLASK_DEFINITION: ApparatusDefinition = {
  id: 'flask.conical.250ml',
  kind: 'FLASK',
  label: '250 mL conical flask',
  category: 'glassware',
  capabilities: ['CONTAINER', 'FLOW_RECEIVER'],
  dimensionsM: { width: 0.1, height: 0.15, depth: 0.1 },
  massKg: 0.15,
  capacityL: 0.25,
  sockets: [
    {
      id: 'base',
      kind: 'MECHANICAL',
      localTransform: ORIGIN_TRANSFORM,
      gender: 'PLUG',
      maxConnections: 1,
    },
    {
      id: 'mouth',
      kind: 'FLUID',
      localTransform: ORIGIN_TRANSFORM,
      gender: 'SOCKET',
      acceptsKinds: ['BURETTE', 'PIPETTE'],
      maxConnections: 1,
    },
    {
      id: 'probePort',
      kind: 'SENSOR',
      localTransform: ORIGIN_TRANSFORM,
      gender: 'SOCKET',
      acceptsKinds: ['PH_PROBE'],
      maxConnections: 1,
    },
  ],
  collisionRadiusM: 0.07,
  permittedTransforms: { translate: true, rotateAxes: ['y'] },
  controls: [],
  defaultConfig: {},
  isPlaceholder: true,
};

export const STIRRER_DEFINITION: ApparatusDefinition = {
  id: 'stirrer.magnetic.standard',
  kind: 'STIRRER',
  label: 'Magnetic stirrer',
  category: 'instrument',
  capabilities: ['STIRRING', 'MOUNT'],
  dimensionsM: { width: 0.15, height: 0.05, depth: 0.15 },
  massKg: 1.1,
  sockets: [
    {
      id: 'platform',
      kind: 'MECHANICAL',
      localTransform: ORIGIN_TRANSFORM,
      gender: 'SOCKET',
      acceptsKinds: ['FLASK', 'BEAKER'],
      maxConnections: 1,
    },
  ],
  collisionRadiusM: 0.1,
  permittedTransforms: { translate: true, rotateAxes: ['y'] },
  controls: [
    { id: 'stirrerRpm', label: 'Stirring speed', kind: 'range', min: 0, max: 1000, step: 10, unit: 'rpm', appliesVia: 'START_STIRRER' },
  ],
  defaultConfig: { stirrerRpm: 0, running: false },
  isPlaceholder: true,
};

export const PH_PROBE_DEFINITION: ApparatusDefinition = {
  id: 'probe.ph.standard',
  kind: 'PH_PROBE',
  label: 'pH probe',
  category: 'instrument',
  capabilities: ['PH_SENSOR', 'MOUNTABLE'],
  dimensionsM: { width: 0.02, height: 0.2, depth: 0.02 },
  massKg: 0.1,
  sockets: [
    {
      id: 'grip',
      kind: 'MECHANICAL',
      localTransform: ORIGIN_TRANSFORM,
      gender: 'PLUG',
      acceptsKinds: ['CLAMP', 'STAND'],
      maxConnections: 1,
    },
    {
      id: 'tip',
      kind: 'SENSOR',
      localTransform: ORIGIN_TRANSFORM,
      gender: 'PLUG',
      acceptsKinds: ['FLASK', 'BEAKER'],
      maxConnections: 1,
    },
  ],
  collisionRadiusM: 0.03,
  permittedTransforms: { translate: true, rotateAxes: ['y'] },
  controls: [
    { id: 'depthM', label: 'Immersion depth', kind: 'range', min: 0, max: 0.1, step: 0.005, unit: 'm', appliesVia: 'SET_PROBE' },
  ],
  defaultConfig: { depthM: 0.03 },
  isPlaceholder: true,
};

/** Every P0 vertical-slice definition, ready to feed `createDefinitionRegistry`. */
export const VERTICAL_SLICE_DEFINITIONS: readonly ApparatusDefinition[] = [
  BENCH_DEFINITION,
  STAND_DEFINITION,
  CLAMP_DEFINITION,
  BURETTE_DEFINITION,
  FLASK_DEFINITION,
  STIRRER_DEFINITION,
  PH_PROBE_DEFINITION,
];
