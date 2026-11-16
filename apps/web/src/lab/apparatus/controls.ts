/**
 * Turns a control invocation (e.g. "the user dragged the stopcock lever to 40% open") into a
 * typed `LabAction`, validated against the apparatus definition's declared control range. This
 * module never sends the action anywhere or mutates anything — per the shared contract, only
 * Agent 07's reducer may change apparatus/chemical state. Agent 04 is expected to call
 * `buildControlAction` at the end of a pointer gesture and dispatch the result to Agent 07.
 */
import type { ApparatusDefinition, ControlDefinition, LabAction, UUID } from './types';

function randomId(): UUID {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Fallback for non-browser test runners without a WebCrypto global.
  return `action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function findControl(definition: ApparatusDefinition, controlId: string): ControlDefinition | undefined {
  return definition.controls.find((c) => c.id === controlId);
}

/** Clamps a numeric control value into its declared range and snaps it to `step` when present.
 * Intended for live UI feedback while dragging; `buildControlAction` still validates strictly.
 * No-op for non-numeric controls. */
export function clampControlValue(control: ControlDefinition, value: number): number {
  if (control.valueType !== 'number' || !control.range) return value;
  const { min, max, step } = control.range;
  let v = Math.min(max, Math.max(min, value));
  if (step && step > 0) v = min + Math.round((v - min) / step) * step;
  return v;
}

export interface ControlActionOptions {
  readonly atSimulationS?: number;
  readonly actorId?: UUID;
  readonly actionId?: UUID;
  /** Extra payload fields merged in alongside `value` (e.g. FILL's species/concentration). */
  readonly extraPayload?: Readonly<Record<string, unknown>>;
}

export type ControlInvocationResult = { readonly ok: true; readonly action: LabAction } | { readonly ok: false; readonly error: string };

/**
 * Validates `value` against `controlId`'s declared range/options on `definition` and, if valid,
 * returns the `LabAction` Agent 07 should receive. Returns `{ ok: false }` with a clear message
 * instead of silently clamping, so a caller that bypasses `clampControlValue` cannot smuggle an
 * out-of-range value into the experiment log.
 */
export function buildControlAction(
  definition: ApparatusDefinition,
  instanceId: UUID,
  controlId: string,
  value: unknown,
  options: ControlActionOptions = {},
): ControlInvocationResult {
  const control = findControl(definition, controlId);
  if (!control) {
    return { ok: false, error: `"${definition.label}" has no control named "${controlId}". Available: ${definition.controls.map((c) => c.id).join(', ') || '(none)'}.` };
  }

  if (control.requiresCapability && !definition.capabilities.includes(control.requiresCapability)) {
    return { ok: false, error: `"${definition.label}" declares control "${controlId}" but not the ${control.requiresCapability} capability it requires.` };
  }

  const payload: Record<string, unknown> = { controlId, ...options.extraPayload };

  if (control.valueType === 'boolean') {
    if (typeof value !== 'boolean') {
      return { ok: false, error: `"${controlId}" expects true or false. Received: ${JSON.stringify(value)}.` };
    }
    payload.value = value;
  } else if (control.valueType === 'string') {
    const options_ = control.options ?? [];
    if (typeof value !== 'string' || !options_.includes(value)) {
      return { ok: false, error: `"${controlId}" must be one of: ${options_.join(', ') || '(none declared)'}. Received: ${JSON.stringify(value)}.` };
    }
    payload.value = value;
  } else {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, error: `"${controlId}" expects a finite number${control.range ? ` in ${control.range.unit}` : ''}. Received: ${JSON.stringify(value)}.` };
    }
    if (control.range && (value < control.range.min || value > control.range.max)) {
      return {
        ok: false,
        error: `"${controlId}" must be between ${control.range.min} and ${control.range.max} ${control.range.unit}. Received: ${value}.`,
      };
    }
    payload.value = value;
  }

  return {
    ok: true,
    action: {
      actionId: options.actionId ?? randomId(),
      atSimulationS: options.atSimulationS ?? 0,
      targetInstanceId: instanceId,
      type: control.actionType,
      payload,
      actorId: options.actorId,
    },
  };
}
