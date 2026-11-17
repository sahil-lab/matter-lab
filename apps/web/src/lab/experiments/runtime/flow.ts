/**
 * Maps a `SET_VALVE` control (0..1) to a flow rate under one explicit, declared model (brief item
 * 5: "Flow rate may be a validated simple model with declared assumptions; map valve opening to
 * flow under an explicit supported model. Avoid claiming detailed fluid hydrodynamics."). This is a
 * linear model only — proportional to valve opening, no viscosity, head pressure or meniscus
 * dynamics — which is exactly why it is named and versioned (`linear-valve-v1`) instead of left
 * implicit.
 */
import type { ApparatusDefinition } from '@matterlab/contracts';
import { VALVE_OPENING_MAX, VALVE_OPENING_MIN } from '@matterlab/contracts';

export function clampValveOpening(valveOpening: number): number {
  if (!Number.isFinite(valveOpening)) return VALVE_OPENING_MIN;
  return Math.min(VALVE_OPENING_MAX, Math.max(VALVE_OPENING_MIN, valveOpening));
}

/**
 * Liters per second a `FLOW_SOURCE` delivers at the given valve opening, under its declared
 * `flowModel`. Returns 0 (not an error) for a definition with no flow model: a capability check
 * elsewhere is responsible for rejecting an attempt to open a valve that does not exist.
 */
export function flowRateLPerS(definition: ApparatusDefinition, valveOpening: number): number {
  const model = definition.flowModel;
  if (!model) return 0;
  return model.maxFlowRateLPerS * clampValveOpening(valveOpening);
}

export function volumeOverTick(definition: ApparatusDefinition, valveOpening: number, timeStepS: number): number {
  if (!Number.isFinite(timeStepS) || timeStepS <= 0) return 0;
  return flowRateLPerS(definition, valveOpening) * timeStepS;
}
