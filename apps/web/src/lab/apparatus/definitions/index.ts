/**
 * Registers every P0/P1 apparatus definition into the process-wide `apparatusRegistry` (brief
 * point 6: "asset loading registry ... without modifying editor core" — importing this module is
 * the only integration step any other agent needs). `ALL_DEFINITIONS` is exported separately for
 * tooling (tests, the socket compatibility matrix, the demo scene) that wants the list directly
 * without going through the registry singleton.
 */
import { registerApparatus } from '../registry';
import type { ApparatusDefinition } from '../types';
import { BALANCE_STANDARD } from './balance';
import { BEAKER_250ML_LOW_FORM } from './beaker';
import { BURETTE_50ML_CLASS_A } from './burette';
import { BURETTE_CLAMP_BOSS_HEAD } from './buretteClamp';
import { CONDUCTIVITY_METER_STANDARD } from './conductivityMeter';
import { CONICAL_FLASK_250ML } from './conicalFlask';
import { DROPPER_STANDARD } from './dropper';
import { FUNNEL_STANDARD } from './funnel';
import { GRADUATED_CYLINDER_100ML } from './graduatedCylinder';
import { LAB_JACK_STANDARD } from './labJack';
import { MAGNETIC_STIRRER_COMPACT } from './magneticStirrer';
import { PH_PROBE_COMBINATION } from './phProbe';
import { PIPETTE_25ML_VOLUMETRIC } from './pipette';
import { REAGENT_BOTTLE_250ML } from './reagentBottle';
import { RETORT_STAND_600MM } from './retortStand';
import { SUPPORT_RING_STANDARD } from './supportRing';
import { TEMPERATURE_SENSOR_STANDARD } from './temperatureSensor';
import { TEST_TUBE_16X100MM } from './testTube';
import { THERMOMETER_STANDARD } from './thermometer';
import { VOLUMETRIC_FLASK_250ML } from './volumetricFlask';
import { WORKBENCH_STANDARD } from './workbench';

export * from './builderRegistry';

export {
  BALANCE_STANDARD,
  BEAKER_250ML_LOW_FORM,
  BURETTE_50ML_CLASS_A,
  BURETTE_CLAMP_BOSS_HEAD,
  CONDUCTIVITY_METER_STANDARD,
  CONICAL_FLASK_250ML,
  DROPPER_STANDARD,
  FUNNEL_STANDARD,
  GRADUATED_CYLINDER_100ML,
  LAB_JACK_STANDARD,
  MAGNETIC_STIRRER_COMPACT,
  PH_PROBE_COMBINATION,
  PIPETTE_25ML_VOLUMETRIC,
  REAGENT_BOTTLE_250ML,
  RETORT_STAND_600MM,
  SUPPORT_RING_STANDARD,
  TEMPERATURE_SENSOR_STANDARD,
  TEST_TUBE_16X100MM,
  THERMOMETER_STANDARD,
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

/** The complete P1-library equipment list from the brief: beakers, test tubes, volumetric flasks,
 * pipettes, droppers, graduates, funnels, support rings, lab jack, thermometer, conductivity
 * meter, balance, temperature sensor. */
export const P1_DEFINITIONS: readonly ApparatusDefinition[] = [
  BEAKER_250ML_LOW_FORM,
  TEST_TUBE_16X100MM,
  VOLUMETRIC_FLASK_250ML,
  PIPETTE_25ML_VOLUMETRIC,
  DROPPER_STANDARD,
  GRADUATED_CYLINDER_100ML,
  FUNNEL_STANDARD,
  SUPPORT_RING_STANDARD,
  LAB_JACK_STANDARD,
  THERMOMETER_STANDARD,
  CONDUCTIVITY_METER_STANDARD,
  BALANCE_STANDARD,
  TEMPERATURE_SENSOR_STANDARD,
];

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
