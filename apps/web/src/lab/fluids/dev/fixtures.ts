/**
 * Regression scenario fixtures for the standalone fluids dev harness (`dev/FluidsDevApp.tsx`,
 * served at `/fluids-lab.html`). These are plain data fixtures, not a simulation: they exist only
 * to give the real `lab/fluids` components (GlassVessel, LiquidBody, GraduationMarks,
 * DropletStream, InstrumentReadout) believable inputs to render, in isolation from Agent 06/07's
 * not-yet-available real solver and runtime. Nothing under `lab/fluids/{geometry,color,materials,
 * components}` imports anything from this file or from `dev/` at all.
 *
 * `devOnlyTitrationPh` is the one exception worth flagging explicitly: it is a real implementation
 * of the strong-acid/strong-base equilibrium model named in Section 6 of
 * `00_SHARED_INTEGRATION_CONTRACT.md` (water autoionization, finite-volume charge balance) — not
 * invented chemistry — but it is a LOCAL FIXTURE for this dev harness only. Agent 06 owns the real
 * solver; production code must read a live `Observation`, never call this function.
 */
import { buretteProfile, erlenmeyerFlaskProfile } from '../geometry/vesselProfile';
import type { VesselProfile } from '../contracts';

export const KW_25C = 1.0e-14;

export interface TitrationFixtureParams {
  readonly acidConcentrationMolPerL: number;
  readonly acidVolumeL: number;
  readonly baseConcentrationMolPerL: number;
  readonly kw?: number;
}

export const DEFAULT_TITRATION_FIXTURE: TitrationFixtureParams = {
  acidConcentrationMolPerL: 0.1,
  acidVolumeL: 0.025,
  baseConcentrationMolPerL: 0.1,
};

/**
 * DEV-ONLY FIXTURE (see file header). Strong acid titrated by strong base: solves the proton/charge
 * balance `[H+] - [OH+] = C` with `[OH-] = Kw/[H+]`, i.e. `[H+]^2 - C[H+] - Kw = 0`, for
 * `C = (moles acid - moles base added) / total volume`. This is exact through the equivalence point
 * (no divide-by-zero or sign flip at C=0, where it correctly gives [H+] = sqrt(Kw), pH 7 at 25 C),
 * unlike the simpler "leftover concentration" approximation usually shown for points away from
 * equivalence.
 */
export function devOnlyTitrationPh(params: TitrationFixtureParams, deliveredVolumeL: number): number {
  const kw = params.kw ?? KW_25C;
  const totalVolumeL = params.acidVolumeL + Math.max(deliveredVolumeL, 0);
  if (totalVolumeL <= 0) return 7;
  const netAcidMolarity = (params.acidConcentrationMolPerL * params.acidVolumeL - params.baseConcentrationMolPerL * deliveredVolumeL) / totalVolumeL;
  const hydronium = (netAcidMolarity + Math.sqrt(netAcidMolarity * netAcidMolarity + 4 * kw)) / 2;
  return -Math.log10(hydronium);
}

/** The delivered volume (mL) at which the two reactants are in exact stoichiometric balance. */
export function equivalenceVolumeMl(params: TitrationFixtureParams): number {
  return (1000 * (params.acidConcentrationMolPerL * params.acidVolumeL)) / params.baseConcentrationMolPerL;
}

export interface VesselFixture {
  readonly key: string;
  readonly profile: VesselProfile;
  readonly volumeL: number;
  readonly colorHex: string;
  readonly agitation?: number;
  readonly positionM: readonly [number, number, number];
  readonly label: string;
}

const WATER_TINT = '#eef6fb';
const COPPER_SULFATE_TINT = '#3e8fd6';

/** Scene 1: a plain, clear/colorless liquid (the baseline transparency legibility case). */
export function clearLiquidScene(): VesselFixture[] {
  const profile = erlenmeyerFlaskProfile('flask-clear');
  return [{ key: 'clear', profile, volumeL: profile.capacityL * 0.55, colorHex: WATER_TINT, positionM: [0, 0, 0], label: 'Water (clear/colorless)' }];
}

/** Scene 2: a strongly tinted liquid (copper(II) sulfate blue), to check transmission with saturated color. */
export function tintedLiquidScene(): VesselFixture[] {
  const profile = erlenmeyerFlaskProfile('flask-tinted');
  return [{ key: 'tinted', profile, volumeL: profile.capacityL * 0.6, colorHex: COPPER_SULFATE_TINT, positionM: [0, 0, 0], label: 'Aqueous copper(II) sulfate (tinted)' }];
}

/**
 * Scene 3: three burettes side by side at full, half and near-empty — covers the near-empty/full
 * burette cases and, because the three sit side by side, is also the "multiple transparent
 * vessels" depth-sorting case.
 */
export function buretteLevelsScene(): VesselFixture[] {
  const full = buretteProfile('burette-full', 50);
  const half = buretteProfile('burette-half', 50);
  const nearEmpty = buretteProfile('burette-near-empty', 50);
  const deadVolumeL = (profile: VesselProfile) => (profile.graduation ? profile.capacityL - (profile.graduation.maxML - profile.graduation.minML) / 1000 : 0);
  return [
    { key: 'full', profile: full, volumeL: full.capacityL, colorHex: WATER_TINT, positionM: [-0.09, 0, 0], label: 'Full (50.00 mL)' },
    { key: 'half', profile: half, volumeL: deadVolumeL(half) + 0.025, colorHex: WATER_TINT, positionM: [0, 0, 0], label: 'Half delivered (25.00 mL remaining)' },
    { key: 'near-empty', profile: nearEmpty, volumeL: deadVolumeL(nearEmpty) + 0.002, colorHex: WATER_TINT, positionM: [0.09, 0, 0], label: 'Near-empty (2.00 mL remaining)' },
  ];
}

/** Scene 4: a continuously agitated liquid (magnetic-stirrer-style swirl), purely decorative motion. */
export function swirlingScene(): VesselFixture[] {
  const profile = erlenmeyerFlaskProfile('flask-swirl');
  return [{ key: 'swirl', profile, volumeL: profile.capacityL * 0.5, colorHex: COPPER_SULFATE_TINT, agitation: 1, positionM: [0, 0, 0], label: 'Stirred (agitation = 1)' }];
}

export const BURETTE_CAPACITY_ML = 50;

/** Static vessel setup for the endpoint-titration scene; the burette/flask fill levels are derived live from the delivered volume (see `FluidsDevApp`), not stored here. */
export function endpointTitrationProfiles(): { readonly burette: VesselProfile; readonly flask: VesselProfile } {
  return { burette: buretteProfile('endpoint-burette', BURETTE_CAPACITY_ML), flask: erlenmeyerFlaskProfile('endpoint-flask') };
}

export const SCENARIO_IDS = ['clear-liquid', 'tinted-liquid', 'burette-levels', 'swirling', 'endpoint-titration'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export const SCENARIO_TITLES: Readonly<Record<ScenarioId, string>> = {
  'clear-liquid': 'Clear / colorless liquid',
  'tinted-liquid': 'Tinted liquid',
  'burette-levels': 'Burette fill levels (near-empty, full, multiple vessels)',
  swirling: 'Swirling / stirred liquid',
  'endpoint-titration': 'Endpoint transition (strong acid / strong base)',
};
