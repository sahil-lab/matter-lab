/**
 * PROVISIONAL STUB — owned by Agent 03 ("Apparatus Modeling Engineer") per
 * `Agent_03_Apparatus_Assets_and_Capability_Definitions.md`. That agent's branch did not exist yet
 * when this one was written, so Agent 04 (interaction/editor) wrote the smallest definition set
 * that satisfies the shared contract's Section 6 vertical slice, to exercise placement, snapping
 * and operational interactions end-to-end. Every field below is a guess at Agent 03's real schema
 * from the shared contract and `Agent_03_*.md`; replace this whole directory with Agent 03's
 * authoritative registry, sockets and glTF assets when that branch is integrated. Dimensions are
 * illustrative (plausible lab scale in meters), not measured from real equipment.
 */
import type { ApparatusKind, Capability, ConnectionKind, LabActionType, Transform } from '../editor/contracts';
import { IDENTITY_TRANSFORM } from '../editor/contracts';
import type { ApparatusFootprint, Vec3 } from '../editor/types';

export interface SocketDefinition {
  readonly id: string;
  readonly kind: ConnectionKind;
  readonly label: string;
  /** Local offset/orientation relative to the instance's own transform, in meters. */
  readonly localTransform: Transform;
  /** Apparatus kinds this socket may connect to; `'ANY'` accepts every kind. */
  readonly accepts: readonly (ApparatusKind | 'ANY')[];
  /** A planar socket (e.g. a bench top) accepts a snap anywhere on its surface rather than at one fixed point. */
  readonly surface: 'point' | 'planar';
  /** Whether more than one connection may use this socket at once (benches, racks). Default false. */
  readonly multiple?: boolean;
}

export interface ControlDefinition {
  readonly id: string;
  readonly label: string;
  readonly kind: 'range' | 'toggle' | 'trigger';
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly default: number | boolean;
  readonly actionType: LabActionType;
}

export interface ApparatusDefinition {
  readonly id: string;
  readonly kind: ApparatusKind;
  readonly label: string;
  readonly category: string;
  readonly capabilities: readonly Capability[];
  /** Bounding-box footprint (width x height x depth) in meters, used for collision and placement previews. */
  readonly dimensionsM: Vec3;
  readonly footprintCenter: Vec3;
  readonly sockets: readonly SocketDefinition[];
  /** Internal volume in liters, for `CONTAINER` apparatus only. */
  readonly capacityL?: number;
  readonly controls: readonly ControlDefinition[];
  /** True when the definition must rest on a `MOUNT`-capable socket; otherwise placement shows a "floating / unsupported" warning. */
  readonly requiresSupport: boolean;
  readonly defaultConfig: Readonly<Record<string, unknown>>;
  /** Marks the render as a procedural stand-in, per Agent 03's brief item 7 ("visibly marked as incomplete"). */
  readonly placeholderGeometry: 'box' | 'cylinder';
}

function socket(
  id: string,
  kind: ConnectionKind,
  label: string,
  localTransform: Transform,
  accepts: readonly (ApparatusKind | 'ANY')[],
  surface: 'point' | 'planar' = 'point',
  multiple = false,
): SocketDefinition {
  return { id, kind, label, localTransform, accepts, surface, multiple };
}

function at(positionM: Vec3): Transform {
  return { positionM, quaternion: IDENTITY_TRANSFORM.quaternion };
}

export const APPARATUS_CATALOG: readonly ApparatusDefinition[] = [
  {
    id: 'bench.standard',
    kind: 'BENCH',
    label: 'Lab bench',
    category: 'Furniture',
    capabilities: ['MOUNT'],
    dimensionsM: [1.2, 0.05, 0.6],
    footprintCenter: [0, -0.025, 0],
    // The instance origin (y=0) sits at the top of the bench box (footprintCenter.y + half-height
    // = -0.025 + 0.025 = 0), so the socket that represents the physical benchtop belongs at y=0,
    // not above it — otherwise nothing placed exactly on the surface (e.g. by a ground-plane click)
    // can ever be within snapping range of it.
    sockets: [socket('surface', 'MECHANICAL', 'Benchtop', at([0, 0, 0]), ['STAND', 'BEAKER', 'FLASK', 'STIRRER', 'OTHER'], 'planar', true)],
    controls: [],
    requiresSupport: false,
    defaultConfig: {},
    placeholderGeometry: 'box',
  },
  {
    id: 'stand.retort',
    kind: 'STAND',
    label: 'Retort stand',
    category: 'Support',
    capabilities: ['MOUNT', 'MOUNTABLE'],
    dimensionsM: [0.2, 0.6, 0.2],
    footprintCenter: [0, 0.3, 0],
    sockets: [
      socket('base', 'MECHANICAL', 'Base plate', at([0, 0, 0]), ['BENCH', 'OTHER']),
      socket('rail-low', 'MECHANICAL', 'Rail (low)', at([0, 0.2, 0]), ['CLAMP']),
      socket('rail-mid', 'MECHANICAL', 'Rail (mid)', at([0, 0.38, 0]), ['CLAMP']),
      socket('rail-high', 'MECHANICAL', 'Rail (high)', at([0, 0.52, 0]), ['CLAMP']),
    ],
    controls: [],
    requiresSupport: true,
    defaultConfig: {},
    placeholderGeometry: 'cylinder',
  },
  {
    id: 'clamp.burette',
    kind: 'CLAMP',
    label: 'Burette clamp',
    category: 'Support',
    capabilities: ['MOUNT', 'MOUNTABLE'],
    dimensionsM: [0.16, 0.05, 0.09],
    footprintCenter: [0, 0, 0],
    sockets: [
      socket('mount', 'MECHANICAL', 'Stand rail grip', at([-0.06, 0, 0]), ['STAND']),
      socket('jaw', 'MECHANICAL', 'Burette jaw', at([0.07, 0, 0]), ['BURETTE']),
    ],
    controls: [],
    requiresSupport: true,
    defaultConfig: {},
    placeholderGeometry: 'box',
  },
  {
    id: 'burette.50ml',
    kind: 'BURETTE',
    label: 'Burette, 50 mL',
    category: 'Glassware',
    capabilities: ['CONTAINER', 'FLOW_SOURCE'],
    dimensionsM: [0.03, 0.55, 0.03],
    footprintCenter: [0, 0.275, 0],
    capacityL: 0.05,
    sockets: [
      socket('clamp-grip', 'MECHANICAL', 'Clamp grip', at([0, 0.4, 0]), ['CLAMP']),
      socket('tip', 'FLUID', 'Stopcock tip', at([0, 0, 0]), ['FLASK', 'BEAKER']),
    ],
    controls: [
      { id: 'valve', label: 'Stopcock', kind: 'range', min: 0, max: 1, step: 0.01, default: 0, actionType: 'SET_VALVE' },
      { id: 'fill', label: 'Fill titrant', kind: 'trigger', default: false, actionType: 'FILL' },
    ],
    requiresSupport: true,
    defaultConfig: { valveOpenFraction: 0 },
    placeholderGeometry: 'cylinder',
  },
  {
    id: 'flask.conical250',
    kind: 'FLASK',
    label: 'Conical flask, 250 mL',
    category: 'Glassware',
    capabilities: ['CONTAINER', 'FLOW_RECEIVER'],
    dimensionsM: [0.11, 0.13, 0.11],
    footprintCenter: [0, 0.065, 0],
    capacityL: 0.25,
    sockets: [
      socket('base', 'MECHANICAL', 'Base', at([0, 0, 0]), ['BENCH', 'STIRRER', 'OTHER']),
      socket('mouth', 'FLUID', 'Mouth', at([0, 0.13, 0]), ['BURETTE', 'PIPETTE']),
      socket('probe-port', 'SENSOR', 'Probe port', at([0.03, 0.12, 0]), ['PH_PROBE']),
    ],
    controls: [{ id: 'fill', label: 'Fill aliquot', kind: 'trigger', default: false, actionType: 'FILL' }],
    requiresSupport: true,
    defaultConfig: {},
    placeholderGeometry: 'cylinder',
  },
  {
    id: 'beaker.400ml',
    kind: 'BEAKER',
    label: 'Beaker, 400 mL',
    category: 'Glassware',
    capabilities: ['CONTAINER', 'FLOW_RECEIVER'],
    dimensionsM: [0.09, 0.11, 0.09],
    footprintCenter: [0, 0.055, 0],
    capacityL: 0.4,
    sockets: [
      socket('base', 'MECHANICAL', 'Base', at([0, 0, 0]), ['BENCH', 'STIRRER', 'OTHER']),
      socket('mouth', 'FLUID', 'Mouth', at([0, 0.11, 0]), ['BURETTE', 'PIPETTE']),
      socket('probe-port', 'SENSOR', 'Probe port', at([0.025, 0.1, 0]), ['PH_PROBE']),
    ],
    controls: [{ id: 'fill', label: 'Fill', kind: 'trigger', default: false, actionType: 'FILL' }],
    requiresSupport: true,
    defaultConfig: {},
    placeholderGeometry: 'cylinder',
  },
  {
    id: 'stirrer.magnetic',
    kind: 'STIRRER',
    label: 'Magnetic stirrer',
    category: 'Instrument',
    capabilities: ['MOUNT', 'STIRRING'],
    dimensionsM: [0.14, 0.04, 0.14],
    footprintCenter: [0, 0.02, 0],
    sockets: [
      socket('base', 'MECHANICAL', 'Base', at([0, 0, 0]), ['BENCH', 'OTHER']),
      socket('plate', 'MECHANICAL', 'Stir plate', at([0, 0.04, 0]), ['FLASK', 'BEAKER'], 'planar'),
    ],
    controls: [{ id: 'speed', label: 'Stir speed', kind: 'range', min: 0, max: 1, step: 0.05, default: 0, actionType: 'START_STIRRER' }],
    requiresSupport: true,
    defaultConfig: { speed: 0 },
    placeholderGeometry: 'box',
  },
  {
    id: 'probe.ph',
    kind: 'PH_PROBE',
    label: 'pH probe',
    category: 'Instrument',
    capabilities: ['MOUNTABLE', 'PH_SENSOR'],
    dimensionsM: [0.012, 0.16, 0.012],
    footprintCenter: [0, 0.08, 0],
    sockets: [
      socket('mount', 'MECHANICAL', 'Stand rail grip', at([0, 0.08, 0]), ['STAND', 'CLAMP']),
      socket('tip', 'SENSOR', 'Sensing tip', at([0, 0, 0]), ['FLASK', 'BEAKER']),
    ],
    controls: [{ id: 'probe-depth', label: 'Immersion depth', kind: 'range', min: 0, max: 0.1, step: 0.005, default: 0.05, actionType: 'SET_PROBE' }],
    requiresSupport: false,
    defaultConfig: { immersionDepthM: 0.05 },
    placeholderGeometry: 'cylinder',
  },
  {
    id: 'pipette.10ml',
    kind: 'PIPETTE',
    label: 'Pipette, 10 mL',
    category: 'Glassware',
    capabilities: ['CONTAINER', 'FLOW_SOURCE'],
    dimensionsM: [0.012, 0.22, 0.012],
    footprintCenter: [0, 0.11, 0],
    capacityL: 0.01,
    sockets: [socket('tip', 'FLUID', 'Tip', at([0, 0, 0]), ['FLASK', 'BEAKER'])],
    controls: [{ id: 'dispense', label: 'Dispense', kind: 'trigger', default: false, actionType: 'TRANSFER' }],
    requiresSupport: false,
    defaultConfig: {},
    placeholderGeometry: 'cylinder',
  },
];

const BY_ID: ReadonlyMap<string, ApparatusDefinition> = new Map(APPARATUS_CATALOG.map((d) => [d.id, d]));

export function getApparatusDefinition(definitionId: string): ApparatusDefinition | undefined {
  return BY_ID.get(definitionId);
}

export function requireApparatusDefinition(definitionId: string): ApparatusDefinition {
  const def = BY_ID.get(definitionId);
  if (!def) throw new Error(`Unknown apparatus definition: ${definitionId}`);
  return def;
}

export function footprintFor(definition: ApparatusDefinition): ApparatusFootprint {
  const [w, h, d] = definition.dimensionsM;
  return { halfExtents: [w / 2, h / 2, d / 2], center: definition.footprintCenter };
}

export function socketsOf(definitionId: string): readonly SocketDefinition[] {
  return BY_ID.get(definitionId)?.sockets ?? [];
}
