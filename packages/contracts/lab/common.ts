export const LAB_SCHEMA_VERSION = 1 as const;
export const LAB_CONTRACT_VERSION = '1.0.0' as const;

/** Entity IDs are canonical lowercase RFC 9562 UUIDs; catalog keys are separate strings. */
export type UUID = string;
export type UtcTimestamp = string;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type Vec3M = readonly [number, number, number];
export type Quaternion = readonly [number, number, number, number];
export interface Transform {
  readonly positionM: Vec3M;
  readonly quaternion: Quaternion;
}
export interface BoundsM {
  readonly min: Vec3M;
  readonly max: Vec3M;
}
export interface Quantity<Unit extends string = string> {
  readonly value: number;
  readonly unit: Unit;
  readonly uncertainty?: number;
}

export const EVIDENCE_VALUES = [
  'REFERENCE_MEASURED', 'MODEL_CALCULATED', 'ILLUSTRATIVE', 'UNVERIFIED', 'UNSUPPORTED',
] as const;
export type Evidence = (typeof EVIDENCE_VALUES)[number];
export const RUN_STATUSES = [
  'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNSUPPORTED',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const LAB_UNITS = Object.freeze({
  length: 'm',
  volume: 'L',
  amount: 'mol',
  concentration: 'mol/L',
  temperature: 'K',
  time: 's',
  mass: 'kg',
  flow: 'L/s',
  frequency: 'Hz',
  fraction: '1',
  pH: 'pH',
} as const);

export const LAB_LIMITS = Object.freeze({
  maxJsonBytes: 8 * 1024 * 1024,
  maxJsonDepth: 32,
  maxJsonNodes: 200_000,
  maxStringLength: 4096,
  maxObjectProperties: 2048,
  maxStations: 32,
  maxApparatus: 512,
  maxConnections: 2048,
  maxSpeciesPerContainer: 128,
  maxSocketsPerDefinition: 64,
  maxCalibrationPoints: 256,
  maxReplaySteps: 50_000,
  maxEvents: 100_000,
  maxObservations: 100_000,
  maxSimulationTimeS: 86_400,
  maxTicksPerAdvance: 100_000,
  maxValidationIssues: 64,
} as const);

export const LAB_ERROR_CODES = [
  'INVALID_INPUT', 'INVALID_UUID', 'NON_FINITE_NUMBER', 'INVALID_UNIT',
  'UNSUPPORTED_SCHEMA_VERSION', 'LIMIT_EXCEEDED', 'DUPLICATE_ID', 'MISSING_REFERENCE',
  'CROSS_STATION_CONNECTION', 'INCOMPATIBLE_SOCKET', 'INVALID_CALIBRATION',
  'INVALID_ACTION', 'REVISION_CONFLICT', 'ACTION_ID_CONFLICT', 'STALE_ACTION',
  'INVALID_PHASE', 'INSUFFICIENT_VOLUME', 'CAPACITY_EXCEEDED',
  'UNSUPPORTED_MODEL', 'UNSUPPORTED_SPECIES', 'UNSUPPORTED_CONDITIONS',
  'SOLVER_FAILED', 'CANCELLED', 'RUNTIME_ERROR', 'SERIALIZATION_FAILED',
  'METHOD_VERSION_MISMATCH', 'INPUT_HASH_MISMATCH',
] as const;
export type LabErrorCode = (typeof LAB_ERROR_CODES)[number];
export interface ValidationIssue {
  readonly code: LabErrorCode;
  /** RFC 6901 JSON Pointer; the root is the empty string. */
  readonly path: string;
  readonly message: string;
}
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: LabErrorCode;
  readonly instance?: string;
  readonly traceId?: UUID;
  readonly errors?: readonly ValidationIssue[];
}
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] };

export class ContractValidationError extends Error {
  readonly problem: ProblemDetails;

  constructor(errors: readonly ValidationIssue[]) {
    super(errors[0]?.message ?? 'Invalid laboratory contract input.');
    this.name = 'ContractValidationError';
    this.problem = Object.freeze({
      type: 'urn:matterlab:problem:invalid-input',
      title: 'Invalid laboratory input',
      status: 422,
      detail: this.message,
      code: errors[0]?.code ?? 'INVALID_INPUT',
      errors: Object.freeze(errors.map((error) => Object.freeze({ ...error }))),
    });
  }
}
