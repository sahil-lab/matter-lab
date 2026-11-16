/**
 * Shared numeric tolerances and schema version numbers. Centralised so "the conservation
 * tolerance" is one number every agent can cite, not one guess per package.
 */

/** Section 6 / Agent 07 acceptance tests: "within declared tolerance". Liters. */
export const VOLUME_CONSERVATION_TOLERANCE_L = 1e-9;

/** Moles. Matched to `VOLUME_CONSERVATION_TOLERANCE_L` at ~1 mol/L working concentrations. */
export const MOLES_CONSERVATION_TOLERANCE_MOL = 1e-9;

/** `ApparatusInstance.config.valveOpening` and similar normalised controls are always 0..1. */
export const VALVE_OPENING_MIN = 0;
export const VALVE_OPENING_MAX = 1;

export const EXPERIMENT_SCENE_SCHEMA_VERSION = 1 as const;

/**
 * Default `SimulationConfig.timeStepS` (Section 3) for newly created stations: a tenth of a
 * second. Small enough that a metered titration (Section 6: "run precisely metered transfers at
 * variable flow") looks continuous, large enough that a multi-minute run does not require tens of
 * thousands of logged `TRANSFER` events.
 */
export const DEFAULT_SIMULATION_TIME_STEP_S = 0.1;

/** `StationClockState.speed` multiplier applied to real elapsed time when a clock is `RUNNING`. */
export const DEFAULT_SIMULATION_SPEED = 1;
