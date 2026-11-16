/**
 * Registers every P0/P1 apparatus definition into the process-wide `apparatusRegistry` (brief
 * point 6: "asset loading registry ... without modifying editor core" — importing this module is
 * the only integration step any other agent needs). `ALL_DEFINITIONS` is exported separately for
 * tooling (tests, the socket compatibility matrix, the demo scene) that wants the list directly
 * without going through the registry singleton.
 */
import { registerApparatus } from '../registry';
import type { ApparatusDefinition } from '../types';
import { BEAKER_250ML_LOW_FORM } from './beaker';
import { BURETTE_50ML_CLASS_A } from './burette';
import { BURETTE_CLAMP_BOSS_HEAD } from './buretteClamp';
import { CONICAL_FLASK_250ML } from './conicalFlask';
import { MAGNETIC_STIRRER_COMPACT } from './magneticStirrer';
import { PH_PROBE_COMBINATION } from './phProbe';
import { PIPETTE_25ML_VOLUMETRIC } from './pipette';
import { REAGENT_BOTTLE_250ML } from './reagentBottle';
import { RETORT_STAND_600MM } from './retortStand';
import { TEST_TUBE_16X100MM } from './testTube';
import { VOLUMETRIC_FLASK_250ML } from './volumetricFlask';
import { WORKBENCH_STANDARD } from './workbench';

export {
  BEAKER_250ML_LOW_FORM,
  BURETTE_50ML_CLASS_A,
  BURETTE_CLAMP_BOSS_HEAD,
  CONICAL_FLASK_250ML,
  MAGNETIC_STIRRER_COMPACT,
  PH_PROBE_COMBINATION,
  PIPETTE_25ML_VOLUMETRIC,
  REAGENT_BOTTLE_250ML,
  RETORT_STAND_600MM,
  TEST_TUBE_16X100MM,
  VOLUMETRIC_FLASK_250ML,
  WORKBENCH_STANDARD,
};

/** The P0 vertical-slice equipment set (shared contract §6, step 1). */
export const P0_DEFINITIONS: readonly ApparatusDefinition[] = [
  WORKBENCH_STANDARD,
  RETORT_STAND_600MM,
  BURETTE_CLAMP_BOSS_HEAD,
  BURETTE_50ML_CLASS_A,
  CONICAL_FLASK_250ML,
  REAGENT_BOTTLE_250ML,
  MAGNETIC_STIRRER_COMPACT,
  PH_PROBE_COMBINATION,
];

/** Additional P1-library equipment built so far (brief's "beakers, test tubes, volumetric flasks,
 * pipettes" subset; see the module README for what P1 equipment remains unbuilt). */
export const P1_DEFINITIONS: readonly ApparatusDefinition[] = [BEAKER_250ML_LOW_FORM, TEST_TUBE_16X100MM, VOLUMETRIC_FLASK_250ML, PIPETTE_25ML_VOLUMETRIC];

export const ALL_DEFINITIONS: readonly ApparatusDefinition[] = [...P0_DEFINITIONS, ...P1_DEFINITIONS];

let registered = false;

/** Idempotent: registers every definition above into `apparatusRegistry` exactly once per process
 * (repeated calls, e.g. from several entry points or hot-reloaded modules, are harmless no-ops). */
export function registerAllApparatusDefinitions(): void {
  if (registered) return;
  for (const definition of ALL_DEFINITIONS) registerApparatus(definition);
  registered = true;
}

registerAllApparatusDefinitions();
