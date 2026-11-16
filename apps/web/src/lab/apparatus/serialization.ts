/**
 * Creating, validating and round-tripping `ApparatusInstance`s against their definitions. An
 * instance only stores placement, config and a capability snapshot; this module is how a plain
 * JSON blob (loaded from Agent 09's persistence) becomes something safe to hand to Agent 07, and
 * how an in-memory instance becomes something safe to persist.
 */
import { apparatusRegistry, type ApparatusRegistry } from './registry';
import type { ApparatusDefinition, ApparatusInstance, ConfigFieldSchema, Transform, UUID } from './types';
import { IDENTITY_TRANSFORM } from './types';

function randomId(): UUID {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `instance-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface ConfigValidationResult {
  readonly ok: boolean;
  readonly config: Readonly<Record<string, unknown>>;
  readonly errors: readonly string[];
}

function validateField(field: ConfigFieldSchema, value: unknown): string | null {
  switch (field.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `"${field.key}" must be a finite number.`;
      if (field.min !== undefined && value < field.min) return `"${field.key}" must be >= ${field.min}${field.unit ? ` ${field.unit}` : ''}.`;
      if (field.max !== undefined && value > field.max) return `"${field.key}" must be <= ${field.max}${field.unit ? ` ${field.unit}` : ''}.`;
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `"${field.key}" must be a boolean.`;
    case 'string':
    case 'color':
      return typeof value === 'string' ? null : `"${field.key}" must be a string.`;
    case 'enum': {
      const allowed = field.options?.map((o) => o.value) ?? [];
      return typeof value === 'string' && allowed.includes(value) ? null : `"${field.key}" must be one of: ${allowed.join(', ')}.`;
    }
    default:
      return null;
  }
}

/** Validates (and fills in defaults for) a config object against a definition's `configSchema`.
 * Unknown keys not present in the schema are dropped — config is not a free-form bag. */
export function validateConfig(definition: ApparatusDefinition, config: Readonly<Record<string, unknown>> = {}): ConfigValidationResult {
  const errors: string[] = [];
  const result: Record<string, unknown> = {};
  for (const field of definition.configSchema) {
    const value = field.key in config ? config[field.key] : definition.defaultConfig[field.key];
    const error = validateField(field, value);
    if (error) errors.push(error);
    result[field.key] = value;
  }
  return { ok: errors.length === 0, config: result, errors };
}

export interface CreateInstanceParams {
  readonly id?: UUID;
  readonly transform?: Transform;
  readonly stationId: UUID;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly revision?: number;
}

/** Builds a fresh, valid instance of `definition`. Throws if the supplied config does not satisfy
 * the definition's schema (callers that want field-level errors should call `validateConfig` first). */
export function createApparatusInstance(definition: ApparatusDefinition, params: CreateInstanceParams): ApparatusInstance {
  const validated = validateConfig(definition, { ...definition.defaultConfig, ...params.config });
  if (!validated.ok) throw new Error(`Cannot create "${definition.label}" instance: ${validated.errors.join(' ')}`);
  return {
    id: params.id ?? randomId(),
    kind: definition.kind,
    definitionId: definition.id,
    transform: params.transform ?? IDENTITY_TRANSFORM,
    revision: params.revision ?? 0,
    config: validated.config,
    capabilities: definition.capabilities,
    stationId: params.stationId,
  };
}

function isFiniteTriple(v: unknown): v is readonly [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}
function isFiniteQuad(v: unknown): v is readonly [number, number, number, number] {
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

export type ParseInstanceResult = { readonly ok: true; readonly instance: ApparatusInstance } | { readonly ok: false; readonly error: string };

/**
 * Parses and validates an arbitrary JSON value (e.g. freshly `JSON.parse`d from storage or an API
 * response) into an `ApparatusInstance`, looking up its definition in `registry` (defaults to the
 * process-wide registry). Never throws; reports a problem instead, per the shared contract's
 * "unsupported calculations are explicit, not HTTP 200 with fake values" spirit applied to data.
 */
export function parseApparatusInstance(json: unknown, registry: ApparatusRegistry = apparatusRegistry): ParseInstanceResult {
  if (typeof json !== 'object' || json === null) return { ok: false, error: 'Instance payload must be an object.' };
  const raw = json as Record<string, unknown>;

  if (typeof raw.id !== 'string' || raw.id.length === 0) return { ok: false, error: 'Instance "id" must be a non-empty string.' };
  if (typeof raw.definitionId !== 'string') return { ok: false, error: 'Instance "definitionId" must be a string.' };
  if (typeof raw.stationId !== 'string') return { ok: false, error: 'Instance "stationId" must be a string.' };
  if (typeof raw.revision !== 'number' || !Number.isInteger(raw.revision)) return { ok: false, error: 'Instance "revision" must be an integer.' };

  const definition = registry.get(raw.definitionId);
  if (!definition) return { ok: false, error: `Unknown apparatus definition id "${raw.definitionId}".` };

  const transform = raw.transform as { positionM?: unknown; quaternion?: unknown } | undefined;
  if (!transform || !isFiniteTriple(transform.positionM) || !isFiniteQuad(transform.quaternion)) {
    return { ok: false, error: 'Instance "transform" must have a 3-number positionM and a 4-number quaternion.' };
  }

  const config = (raw.config && typeof raw.config === 'object' ? (raw.config as Record<string, unknown>) : {}) ?? {};
  const validated = validateConfig(definition, config);
  if (!validated.ok) return { ok: false, error: `Invalid config for "${definition.label}": ${validated.errors.join(' ')}` };

  return {
    ok: true,
    instance: {
      id: raw.id,
      kind: definition.kind,
      definitionId: definition.id,
      transform: { positionM: transform.positionM, quaternion: transform.quaternion },
      revision: raw.revision,
      config: validated.config,
      capabilities: definition.capabilities,
      stationId: raw.stationId,
    },
  };
}

/** A plain-JSON copy of an instance, suitable for `JSON.stringify`. Throws if `instance` somehow
 * contains a value `JSON` cannot round-trip (e.g. a function slipped into `config`). */
export function serializeApparatusInstance(instance: ApparatusInstance): ApparatusInstance {
  const text = JSON.stringify(instance);
  return JSON.parse(text) as ApparatusInstance;
}
