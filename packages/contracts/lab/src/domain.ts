/**
 * The shared Astra lab domain model, verbatim from `00_SHARED_INTEGRATION_CONTRACT.md` Section 3
 * ("Shared domain model (canonical proposal)"). Agent 07 (experiment graph/simulation runtime) and
 * Agent 09 (persistence) jointly own this file; a change here is a contract change and must stay
 * compatible with both. zod schemas are the source of truth; the TS types are inferred from them so
 * the runtime validation used by the API can never drift from the compile-time contract.
 *
 * Units (fixed, never overridden per-field): scene coordinates in metres, chemical volume in
 * litres, concentration in mol/L, temperature in kelvin, time in seconds. IDs are stable UUID
 * strings unless noted otherwise; timestamps elsewhere in the API are UTC ISO 8601.
 */
import { z } from 'zod';

/** A stable UUID string. */
export type UUID = string;
export const uuidSchema = z.string().uuid();

/**
 * How a number shown to the user was obtained. This is the Astra lab vocabulary, distinct from
 * (and not interchangeable with) `@matterlab/core`'s `EvidenceLevel`, which labels the existing
 * molecular editor's results.
 */
export const EVIDENCE_LEVELS = ['REFERENCE_MEASURED', 'MODEL_CALCULATED', 'ILLUSTRATIVE', 'UNVERIFIED', 'UNSUPPORTED'] as const;
export const evidenceSchema = z.enum(EVIDENCE_LEVELS);
export type Evidence = z.infer<typeof evidenceSchema>;

export const quantitySchema = z.object({
  value: z.number().finite(),
  unit: z.string().min(1),
  uncertainty: z.number().finite().nonnegative().optional(),
});
/** A number with its unit and, when the source states one, one standard uncertainty in the same unit. */
export type Quantity = z.infer<typeof quantitySchema>;

const vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const quaternionSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]);

export const transformSchema = z.object({
  positionM: vec3Schema,
  quaternion: quaternionSchema,
});
/** Pose of an apparatus instance in the 3D scene. Position in metres; orientation as (x, y, z, w). */
export type Transform = z.infer<typeof transformSchema>;

export const APPARATUS_KINDS = [
  'BENCH',
  'STAND',
  'CLAMP',
  'BURETTE',
  'FLASK',
  'BEAKER',
  'PIPETTE',
  'STIRRER',
  'PH_PROBE',
  'BALANCE',
  'OTHER',
] as const;
export const apparatusKindSchema = z.enum(APPARATUS_KINDS);
export type ApparatusKind = z.infer<typeof apparatusKindSchema>;

export const CAPABILITIES = [
  'CONTAINER',
  'FLOW_SOURCE',
  'FLOW_RECEIVER',
  'MOUNT',
  'MOUNTABLE',
  'HEATING',
  'STIRRING',
  'PH_SENSOR',
  'MEASUREMENT',
] as const;
export const capabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof capabilitySchema>;

export const apparatusInstanceSchema = z.object({
  id: uuidSchema,
  kind: apparatusKindSchema,
  /** Stable key of the `EquipmentDefinition` this instance was placed from, e.g. `"burette-50ml"`. */
  definitionId: z.string().min(1),
  transform: transformSchema,
  /** Optimistic-concurrency counter for this instance; bumped whenever the apparatus reducer changes it. */
  revision: z.number().int().nonnegative(),
  /** Free-form per-instance configuration (valve opening, mount angle, label...), defined by Agent 03's definition. */
  config: z.record(z.string(), z.unknown()),
  capabilities: z.array(capabilitySchema),
  stationId: uuidSchema,
});
export type ApparatusInstance = z.infer<typeof apparatusInstanceSchema>;

const socketRefSchema = z.object({
  instanceId: uuidSchema,
  socketId: z.string().min(1),
});

export const CONNECTION_KINDS = ['MECHANICAL', 'FLUID', 'SENSOR', 'CONTROL'] as const;
export const connectionKindSchema = z.enum(CONNECTION_KINDS);

export const connectionSchema = z.object({
  id: uuidSchema,
  from: socketRefSchema,
  to: socketRefSchema,
  kind: connectionKindSchema,
  enabled: z.boolean(),
});
export type Connection = z.infer<typeof connectionSchema>;

export const speciesAmountSchema = z.object({
  /** Resolved chemical species identifier (not a visual reagent name), e.g. `"HCl(aq)"`. */
  speciesId: z.string().min(1),
  moles: z.number().finite().nonnegative(),
  /** Optional lineage reference: the action, transfer or apparatus that introduced this amount. */
  sourceId: z.string().min(1).optional(),
});
export type SpeciesAmount = z.infer<typeof speciesAmountSchema>;

export const MIXING_MODES = ['WELL_MIXED', 'UNMIXED'] as const;
export const mixingModeSchema = z.enum(MIXING_MODES);

export const containerContentsSchema = z.object({
  volumeL: z.number().finite().nonnegative(),
  species: z.array(speciesAmountSchema),
  temperatureK: z.number().finite().positive(),
  mixing: mixingModeSchema,
  /** Identifier of the mixing/transport model applied to this container (e.g. `"ideal-well-mixed-v1"`). */
  modelId: z.string().min(1),
});
export type ContainerContents = z.infer<typeof containerContentsSchema>;

const stationSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(200),
});

export const simulationConfigSchema = z.object({
  methodId: z.string().min(1),
  timeStepS: z.number().finite().positive(),
});

export const experimentSceneSchema = z.object({
  id: uuidSchema,
  revision: z.number().int().nonnegative(),
  schemaVersion: z.literal(1),
  stations: z.array(stationSchema),
  apparatus: z.array(apparatusInstanceSchema),
  connections: z.array(connectionSchema),
  /** Keyed by container-capable apparatus instance id. */
  containerStates: z.record(uuidSchema, containerContentsSchema),
  simulationConfig: simulationConfigSchema,
  viewport: z.record(z.string(), z.unknown()).optional(),
});
/**
 * The authoritative in-memory shape of one multi-station lab scene, exactly as Agent 07's reducer
 * operates on it. Agent 09 persists this shape (plus envelope metadata - see `SceneRecord` in
 * `api.ts`) and never changes its fields.
 */
export type ExperimentScene = z.infer<typeof experimentSceneSchema>;

export const LAB_ACTION_TYPES = [
  'PLACE',
  'MOVE',
  'ATTACH',
  'DETACH',
  'FILL',
  'SET_VALVE',
  'TRANSFER',
  'START_STIRRER',
  'SET_PROBE',
  'RESET',
  'CUSTOM',
] as const;
export const labActionTypeSchema = z.enum(LAB_ACTION_TYPES);

export const labActionSchema = z.object({
  actionId: uuidSchema,
  atSimulationS: z.number().finite().nonnegative(),
  targetInstanceId: uuidSchema,
  type: labActionTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  actorId: uuidSchema.optional(),
});
/** One entry of the append-only lab action/event log that Agent 07 produces and Agent 09 persists. */
export type LabAction = z.infer<typeof labActionSchema>;

export const OBSERVATION_TYPES = ['PH', 'TEMPERATURE', 'VOLUME', 'CONCENTRATION', 'INDICATOR', 'MASS'] as const;
export const observationTypeSchema = z.enum(OBSERVATION_TYPES);

export const observationSchema = z.object({
  type: observationTypeSchema,
  apparatusId: uuidSchema.optional(),
  timeS: z.number().finite().nonnegative(),
  quantity: quantitySchema,
  evidence: evidenceSchema,
  /** Identifier of the method/model that produced this observation, e.g. `"titration.strong_acid_strong_base.charge_balance.v1"`. */
  methodId: z.string().min(1),
  /** `data_sources`/method references the value can be traced to. */
  sourceIds: z.array(z.string().min(1)),
});
export type Observation = z.infer<typeof observationSchema>;

export const RUN_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNSUPPORTED'] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;
/** Statuses that will never change again once reached. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNSUPPORTED'];

export const runResultSchema = z.object({
  runId: uuidSchema,
  status: runStatusSchema,
  methodId: z.string().min(1),
  methodVersion: z.string().min(1),
  /** SHA-256 of the canonical JSON of the run's inputs (scene snapshot + action log + method/settings). */
  inputHash: z.string().min(1),
  observations: z.array(observationSchema),
  warnings: z.array(z.string()),
  assumptions: z.array(z.string()),
  solverDiagnostics: z.record(z.string(), z.unknown()).optional(),
});
export type RunResult = z.infer<typeof runResultSchema>;
