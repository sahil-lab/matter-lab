import { parseApparatusDefinition } from '@matterlab/contracts';
import type {
  ApparatusControl,
  ApparatusDefinition,
  ApparatusDefinitionReader,
  ApparatusKind,
  Capability,
  ConnectionKind,
  SocketDefinition,
  Vec3M,
  VesselCalibration,
} from '@matterlab/contracts';
import { createVesselCalibration } from './calibration.ts';

export const APPARATUS_CATALOG_VERSION = '1.0.0';
export const LINEAR_FLOW_METHOD_ID = 'flow:linear-valve-v1';

const identity = [0, 0, 0, 1] as const;
const transforms = { translation: ['X', 'Y', 'Z'], rotation: ['Y'] } as const;
const emptyConfig = { type: 'object', properties: {}, required: [], additionalProperties: false } as const;

function socket(
  id: string,
  kind: ConnectionKind,
  positionM: Vec3M,
  direction: SocketDefinition['direction'],
  key: string,
  accepts: readonly string[],
  requiredCapabilities: readonly Capability[],
  options: Partial<Pick<SocketDefinition, 'maxConnections' | 'gender' | 'alignmentToleranceM'>> = {},
): SocketDefinition {
  return {
    id,
    kind,
    localTransform: { positionM, quaternion: identity },
    direction,
    gender: direction === 'IN' ? 'FEMALE' : 'MALE',
    compatibility: { key, accepts, requiredCapabilities },
    maxConnections: 1,
    highlightAnchorM: positionM,
    alignmentToleranceM: 0.02,
    ...options,
  };
}

const fillControl = (capacityL: number): ApparatusControl => ({
  id: 'prepare',
  label: 'Prepare solution',
  actionType: 'FILL',
  fields: {
    reagentId: { type: 'string', maxLength: 128 },
    volumeL: { type: 'number', unit: 'L', minimum: 0, maximum: capacityL, default: Math.min(capacityL, 0.025) },
    concentrationMolL: { type: 'number', unit: 'mol/L', minimum: 0, default: 0.1 },
  },
});
const transferControl = (capacityL: number): ApparatusControl => ({
  id: 'transfer',
  label: 'Meter a transfer',
  actionType: 'TRANSFER',
  fields: { volumeL: { type: 'number', unit: 'L', minimum: 0, maximum: capacityL, default: Math.min(capacityL, 0.00005) } },
});

function base(
  id: string,
  kind: ApparatusKind,
  label: string,
  category: string,
  dimensionsM: Vec3M,
  capabilities: readonly Capability[],
  extra: Partial<Omit<ApparatusDefinition, 'id' | 'kind' | 'label' | 'category' | 'dimensionsM' | 'capabilities'>> = {},
): ApparatusDefinition {
  const [width, height, depth] = dimensionsM;
  return {
    id,
    version: APPARATUS_CATALOG_VERSION,
    schemaVersion: 1,
    kind,
    label,
    category,
    dimensionsM,
    boundsM: { min: [-width / 2, 0, -depth / 2], max: [width / 2, height, depth / 2] },
    capabilities,
    permittedTransforms: transforms,
    sockets: [],
    controls: [],
    configSchema: emptyConfig,
    defaultConfig: {},
    ...extra,
  };
}

function vessel(
  id: string,
  kind: ApparatusKind,
  label: string,
  dimensionsM: Vec3M,
  calibration: VesselCalibration,
  extra: Partial<ApparatusDefinition> = {},
): ApparatusDefinition {
  const mouth: Vec3M = [0, dimensionsM[1], 0];
  return base(id, kind, label, 'Glassware', dimensionsM, ['CONTAINER', 'FLOW_SOURCE', 'FLOW_RECEIVER', 'MOUNTABLE'], {
    capacityL: calibration.capacityL,
    vesselCalibration: calibration,
    tags: ['upright-vessel', 'original-procedural-geometry'],
    sockets: [
      socket('inlet', 'FLUID', mouth, 'IN', 'liquid', ['liquid'], ['FLOW_SOURCE'], { maxConnections: 8, alignmentToleranceM: 0.06 }),
      socket('outlet', 'FLUID', mouth, 'OUT', 'liquid', ['liquid'], ['FLOW_RECEIVER'], { alignmentToleranceM: 0.06 }),
      socket('base', 'MECHANICAL', [0, 0, 0], 'IN', 'vessel-base', ['vessel-platform'], ['MOUNT']),
      socket('sensor', 'SENSOR', [0, dimensionsM[1] * 0.4, 0], 'IN', 'liquid-sensor', ['ph-sensor', 'temperature-sensor', 'conductivity-sensor'], ['MEASUREMENT'], { maxConnections: 4, alignmentToleranceM: 0.15 }),
      socket('stir-control', 'CONTROL', [0, 0, 0], 'IN', 'vessel-control', ['stirrer-control'], ['STIRRING'], { alignmentToleranceM: 0.05 }),
    ],
    controls: [fillControl(calibration.capacityL), transferControl(calibration.capacityL)],
    ...extra,
  });
}

const cylinder = (capacityL: number, bottom: number, top: number, marks?: { minorStepL: number; majorStepL: number; delivered?: boolean }) =>
  createVesselCalibration(capacityL, [{ yM: bottom, radiusM: 0.01 }, { yM: top, radiusM: 0.01 }], marks);
const conical = createVesselCalibration(0.25, [
  { yM: 0.005, radiusM: 0.036 },
  { yM: 0.1, radiusM: 0.014 },
  { yM: 0.175, radiusM: 0.014 },
], { minorStepL: 0.025, majorStepL: 0.05 });
const burette = cylinder(0.05, 0.1, 0.54, { minorStepL: 0.0001, majorStepL: 0.001, delivered: true });

const definitions: readonly ApparatusDefinition[] = [
  base('bench-standard', 'BENCH', 'Laboratory workbench', 'Furniture', [2.4, 0.9, 1.05], ['MOUNT'], {
    sockets: [socket('work-surface', 'MECHANICAL', [0, 0.9, 0], 'OUT', 'work-surface', ['equipment-base'], ['MOUNTABLE'], { maxConnections: 64 })],
    tags: ['work-surface', 'floor-mounted'],
  }),
  base('retort-stand', 'STAND', 'Retort stand', 'Supports', [0.36, 0.74, 0.24], ['MOUNT', 'MOUNTABLE'], {
    sockets: [
      socket('clamp-mount', 'MECHANICAL', [0, 0.61, 0], 'OUT', 'retort-pole', ['retort-pole'], ['MOUNTABLE'], { maxConnections: 1 }),
      socket('ring-mount', 'MECHANICAL', [0, 0.36, 0], 'OUT', 'retort-pole', ['retort-pole'], ['MOUNTABLE']),
      socket('base', 'MECHANICAL', [0, 0, 0], 'IN', 'equipment-base', ['work-surface'], ['MOUNT']),
    ],
  }),
  base('burette-clamp', 'CLAMP', 'Burette clamp', 'Supports', [0.38, 0.055, 0.075], ['MOUNT', 'MOUNTABLE'], {
    tags: ['requires-mount'],
    boundsM: { min: [-0.03, -0.0275, -0.0375], max: [0.35, 0.0275, 0.0375] },
    sockets: [
      socket('stand-mount', 'MECHANICAL', [0, 0, 0], 'IN', 'retort-pole', ['retort-pole'], ['MOUNT']),
      socket('barrel-grip', 'MECHANICAL', [0.32, 0, 0], 'OUT', 'burette-barrel', ['burette-barrel'], ['MOUNTABLE']),
    ],
  }),
  vessel('burette-50ml', 'BURETTE', '50 mL burette', [0.06, 0.6, 0.025], burette, {
    tags: ['requires-mount', 'upright-vessel', 'original-procedural-geometry'],
    sockets: [
      socket('barrel-mount', 'MECHANICAL', [0, 0.33, 0], 'IN', 'burette-barrel', ['burette-barrel'], ['MOUNT']),
      socket('inlet', 'FLUID', [0, 0.6, 0], 'IN', 'liquid', ['liquid'], ['FLOW_SOURCE'], { alignmentToleranceM: 0.06 }),
      socket('outlet', 'FLUID', [0, 0, 0], 'OUT', 'liquid', ['liquid'], ['FLOW_RECEIVER'], { alignmentToleranceM: 0.06 }),
    ],
    controls: [
      fillControl(0.05),
      { id: 'stopcock', label: 'Stopcock opening', actionType: 'SET_VALVE', fields: { openingFraction: { type: 'number', unit: '1', minimum: 0, maximum: 1, default: 0 } } },
      transferControl(0.05),
    ],
    flowModel: {
      methodId: LINEAR_FLOW_METHOD_ID,
      maxFlowLPerS: 0.001,
      assumptions: ['Metered flow = opening fraction times nominal maximum flow; not a model of pressure-head hydrodynamics.'],
    },
  }),
  vessel('conical-flask-250ml', 'FLASK', '250 mL conical flask', [0.08, 0.19, 0.08], conical),
  vessel('beaker-250ml', 'BEAKER', '250 mL beaker', [0.075, 0.1, 0.075],
    cylinder(0.25, 0.005, 0.08, { minorStepL: 0.025, majorStepL: 0.05 })),
  vessel('reagent-bottle-250ml', 'OTHER', '250 mL reagent bottle', [0.075, 0.16, 0.075],
    createVesselCalibration(0.25, [{ yM: 0.006, radiusM: 0.032 }, { yM: 0.105, radiusM: 0.032 }, { yM: 0.13, radiusM: 0.012 }, { yM: 0.145, radiusM: 0.012 }])),
  base('magnetic-stirrer', 'STIRRER', 'Magnetic stirrer', 'Instruments', [0.2, 0.06, 0.2], ['MOUNT', 'MOUNTABLE', 'STIRRING'], {
    sockets: [
      socket('platform', 'MECHANICAL', [0, 0.06, 0], 'OUT', 'vessel-platform', ['vessel-base'], ['CONTAINER']),
      socket('stir-control', 'CONTROL', [0, 0.06, 0], 'OUT', 'stirrer-control', ['vessel-control'], ['CONTAINER'], { alignmentToleranceM: 0.05 }),
    ],
    controls: [{
      id: 'stirring', label: 'Magnetic stirring', actionType: 'START_STIRRER',
      fields: { enabled: { type: 'boolean', default: false }, frequencyHz: { type: 'number', unit: 'Hz', minimum: 0, maximum: 25, default: 8 } },
    }],
  }),
  base('ph-probe', 'PH_PROBE', 'pH probe', 'Sensors', [0.022, 0.2, 0.022], ['PH_SENSOR', 'MEASUREMENT', 'MOUNTABLE'], {
    sockets: [socket('probe-tip', 'SENSOR', [0, 0.008, 0], 'OUT', 'ph-sensor', ['liquid-sensor'], ['CONTAINER'], { alignmentToleranceM: 0.15 })],
    controls: [{ id: 'probe', label: 'Connect pH probe', actionType: 'SET_PROBE', fields: { containerInstanceId: { type: 'string', maxLength: 36 } } }],
  }),
  vessel('test-tube-20ml', 'OTHER', '20 mL test tube', [0.02, 0.15, 0.02], cylinder(0.02, 0.008, 0.14)),
  vessel('volumetric-flask-100ml', 'FLASK', '100 mL volumetric flask', [0.07, 0.19, 0.07],
    createVesselCalibration(0.1, [{ yM: 0.006, radiusM: 0.01 }, { yM: 0.03, radiusM: 0.03 }, { yM: 0.075, radiusM: 0.028 }, { yM: 0.1, radiusM: 0.006 }, { yM: 0.17, radiusM: 0.006 }])),
  vessel('pipette-25ml', 'PIPETTE', '25 mL pipette', [0.025, 0.34, 0.025],
    createVesselCalibration(0.025, [{ yM: 0.05, radiusM: 0.002 }, { yM: 0.12, radiusM: 0.003 }, { yM: 0.15, radiusM: 0.01 }, { yM: 0.21, radiusM: 0.01 }, { yM: 0.24, radiusM: 0.003 }, { yM: 0.32, radiusM: 0.002 }])),
  vessel('dropper-3ml', 'PIPETTE', '3 mL dropper', [0.018, 0.14, 0.018], cylinder(0.003, 0.025, 0.115)),
  vessel('graduated-cylinder-100ml', 'OTHER', '100 mL graduated cylinder', [0.07, 0.25, 0.07],
    cylinder(0.1, 0.02, 0.23, { minorStepL: 0.001, majorStepL: 0.01 })),
  base('funnel', 'OTHER', 'Glass funnel', 'Glassware', [0.08, 0.12, 0.08], ['MOUNTABLE'], {
    tags: ['unsupported-flow-model', 'original-procedural-geometry'],
  }),
  base('support-ring', 'OTHER', 'Support ring', 'Supports', [0.24, 0.018, 0.11], ['MOUNT', 'MOUNTABLE'], {
    boundsM: { min: [-0.025, -0.009, -0.055], max: [0.215, 0.009, 0.055] },
    sockets: [
      socket('stand-mount', 'MECHANICAL', [0, 0, 0], 'IN', 'retort-pole', ['retort-pole'], ['MOUNT']),
      socket('ring', 'MECHANICAL', [0.16, 0, 0], 'OUT', 'vessel-platform', ['vessel-base'], ['MOUNTABLE']),
    ],
  }),
  base('lab-jack', 'OTHER', 'Laboratory jack', 'Supports', [0.18, 0.12, 0.18], ['MOUNT', 'MOUNTABLE'], {
    sockets: [socket('platform', 'MECHANICAL', [0, 0.12, 0], 'OUT', 'vessel-platform', ['vessel-base'], ['MOUNTABLE'])],
  }),
  ...(['thermometer', 'temperature-sensor', 'conductivity-probe'] as const).map((id) =>
    base(id, 'OTHER', id === 'thermometer' ? 'Thermometer' : id === 'temperature-sensor' ? 'Temperature sensor' : 'Conductivity probe',
      'Sensors', [0.02, 0.2, 0.02], ['MEASUREMENT', 'MOUNTABLE'], {
        tags: [id === 'conductivity-probe' ? 'unsupported-conductivity-model' : 'temperature-readout-requires-observation'],
        sockets: [socket('probe-tip', 'SENSOR', [0, 0.008, 0], 'OUT', id === 'conductivity-probe' ? 'conductivity-sensor' : 'temperature-sensor', ['liquid-sensor'], ['CONTAINER'], { alignmentToleranceM: 0.15 })],
      })),
  base('balance', 'BALANCE', 'Laboratory balance', 'Instruments', [0.24, 0.07, 0.24], ['MOUNT', 'MEASUREMENT'], {
    tags: ['mass-readout-requires-observation'],
    sockets: [socket('pan', 'MECHANICAL', [0, 0.07, 0], 'OUT', 'vessel-platform', ['vessel-base'], ['MOUNTABLE'])],
  }),
];

export class ApparatusRegistry implements ApparatusDefinitionReader {
  private readonly definitions = new Map<string, ApparatusDefinition>();
  private snapshot: readonly ApparatusDefinition[] = Object.freeze([]);

  constructor(initial: readonly ApparatusDefinition[] = []) {
    for (const definition of initial) this.register(definition);
  }

  register(definition: ApparatusDefinition): void {
    const parsed = parseApparatusDefinition(definition);
    if (this.definitions.has(parsed.id)) throw new Error(`Apparatus definition ${parsed.id} is already registered; existing runs must keep their definition.`);
    this.definitions.set(parsed.id, parsed);
    this.snapshot = Object.freeze([...this.definitions.values()]);
  }

  getDefinition(id: string): ApparatusDefinition | undefined {
    return this.definitions.get(id);
  }

  listDefinitions(): readonly ApparatusDefinition[] {
    return this.snapshot;
  }
}

export const apparatusRegistry = new ApparatusRegistry(definitions);
export const APPARATUS_DEFINITIONS = apparatusRegistry.listDefinitions();
