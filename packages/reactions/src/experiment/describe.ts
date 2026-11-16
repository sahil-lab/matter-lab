import { GAS_CONSTANT_J_PER_MOL_K } from '@matterlab/core';
import type { KineticModel, RateConstantResult } from '../kinetics/models';
import type { KineticsResult } from '../kinetics/simulate';
import type { ReactionThermo } from '../thermo/reaction';
import { MINUS, ROUNDING_RULES, decimalsForUncertainty, decimalsPrinted, formatEquilibriumConstant, formatFixed, formatSignificant, formatWithUncertainty, prettyUnit, superscript } from './format';
import { thermoRecordOf } from './plan';

/** A number that was entered by the user, written without changing its digits. */
export function formatEntered(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const magnitude = Math.abs(value);
  if (value === 0 || (magnitude >= 1e-3 && magnitude < 1e5)) return String(value).replace('-', MINUS);
  const [mantissa, exponent] = value.toExponential().split('e') as [string, string];
  return `${mantissa.replace('-', MINUS)} \u00d7 10${superscript(String(Number(exponent)))}`;
}

/** Temperature in degrees Celsius to the nearest degree, for readers who do not think in kelvin. */
export const celsius = (temperatureK: number): string => `${formatFixed(temperatureK - 273.15, 0)} \u00b0C`;

export interface ThermoText {
  /** e.g. "−890.36 kJ/mol" or "−571.66 ± 0.08 kJ/mol". */
  readonly deltaH: string;
  readonly deltaS?: string;
  readonly deltaG?: string;
  /** e.g. "log10 K = 83.1 ± 0.1". */
  readonly log10K?: string;
  /** e.g. "about 10⁸³" or "1.8 × 10⁻⁵". */
  readonly K?: string;
  /** How the numbers above were rounded, in words. */
  readonly rounding: readonly string[];
  /** True when the reaction enthalpy carries an uncertainty, that is, when the source prints one for every value used. */
  readonly enthalpyHasUncertainty: boolean;
  /** True when the Gibbs energy carries an uncertainty. */
  readonly gibbsHasUncertainty: boolean;
  /**
   * True when the Gibbs energy and the equilibrium constant are rough estimates (temperature outside the
   * validated range); they are then written with "≈" and without uncertainty.
   */
  readonly approximate: boolean;
}

/**
 * The fewest decimals the source printed among the table values that went into a sum. Values that are
 * exact by definition do not limit the precision.
 */
function leastPrintedDecimals(thermo: ReactionThermo, pick: 'deltaHf298' | 's298'): number | undefined {
  let least: number | undefined;
  for (const term of thermo.terms) {
    const record = term.speciesId ? thermoRecordOf(term.speciesId) : undefined;
    const value = record?.[pick];
    if (!value || value.exact) continue;
    const decimals = decimalsPrinted(value.asPrinted);
    if (decimals !== undefined && (least === undefined || decimals < least)) least = decimals;
  }
  return least;
}

/** The thermodynamic results of an experiment as text, rounded as `ROUNDING_RULES` describes. */
export function describeThermo(thermo: ReactionThermo): ThermoText | undefined {
  if (!thermo.deltaH) return undefined;
  const rounding: string[] = [];
  const hDecimals = leastPrintedDecimals(thermo, 'deltaHf298') ?? 2;
  const hUncertain = thermo.deltaH.uncertainty !== undefined && thermo.deltaH.uncertainty > 0;
  const deltaH = `${formatWithUncertainty(thermo.deltaH.value, thermo.deltaH.uncertainty, hDecimals)} kJ/mol`;
  rounding.push(
    hUncertain
      ? 'The reaction enthalpy is rounded to the second significant figure of its uncertainty.'
      : `The reaction enthalpy has no uncertainty and is rounded to ${hDecimals} decimal${hDecimals === 1 ? '' : 's'}, the fewest printed by the source among the enthalpies of formation used.`,
  );
  if (!thermo.deltaS || !thermo.deltaG || thermo.lnK === undefined) return { deltaH, rounding, enthalpyHasUncertainty: hUncertain, gibbsHasUncertainty: false, approximate: false };

  const sDecimals = leastPrintedDecimals(thermo, 's298') ?? 2;
  const deltaS = `${formatWithUncertainty(thermo.deltaS.value, thermo.deltaS.uncertainty, sDecimals)} J/(mol K)`;

  // Without uncertainties the Gibbs energy is no more precise than the enthalpy, nor than T times the entropy.
  const gUncertainty = thermo.deltaG.uncertainty;
  const gUncertain = gUncertainty !== undefined && gUncertainty > 0;
  const gDecimals = Math.max(0, Math.min(hDecimals, Math.floor(sDecimals + 3 - Math.log10(thermo.temperatureK))));
  const log10Value = thermo.lnK / Math.LN10;
  if (!thermo.withinValidatedRange) {
    // A rough estimate: the error of the approximation is unknown, so the uncertainty of the table values
    // would understate it and fine digits would mean nothing.
    rounding.push(ROUNDING_RULES.estimate);
    return {
      deltaH,
      deltaS,
      deltaG: `${formatFixed(thermo.deltaG.value, 0)} kJ/mol`,
      log10K: `log10 K \u2248 ${formatFixed(log10Value, 1)}`,
      K: formatEquilibriumConstant(thermo.lnK, Infinity),
      rounding,
      enthalpyHasUncertainty: hUncertain,
      gibbsHasUncertainty: false,
      approximate: true,
    };
  }
  const deltaG = `${formatWithUncertainty(thermo.deltaG.value, gUncertainty, gDecimals)} kJ/mol`;
  rounding.push(
    gUncertain
      ? 'The reaction entropy and the Gibbs energy are rounded to the second significant figure of their uncertainties.'
      : `The Gibbs energy has no uncertainty and is rounded to ${gDecimals} decimal${gDecimals === 1 ? '' : 's'}, as far as the printed digits of the enthalpies and entropies used reach.`,
  );

  // log10 K = −ΔG / (RT ln 10). Its uncertainty follows from that of ΔG. Where the source gives none, the
  // rounding of ΔG is only a lower bound on it, so no more than two digits are shown.
  const rtLn10 = (GAS_CONSTANT_J_PER_MOL_K * thermo.temperatureK * Math.LN10) / 1000;
  const log10Uncertainty = gUncertain ? gUncertainty / rtLn10 : Math.max((0.5 * 10 ** -gDecimals) / rtLn10, 0.005);
  const log10K = gUncertain
    ? `log10 K = ${formatWithUncertainty(log10Value, log10Uncertainty, 1)}`
    : `log10 K = ${formatFixed(log10Value, Math.min(2, decimalsForUncertainty(log10Uncertainty)))}`;
  const K = formatEquilibriumConstant(thermo.lnK, log10Uncertainty);
  rounding.push(
    gUncertain
      ? `The equilibrium constant is given with the digits that the uncertainty of the Gibbs energy supports (log10 K is uncertain by about ${formatSignificant(log10Uncertainty, 1)}).`
      : 'The equilibrium constant is given with at most two significant figures: the source states no uncertainty, so the printed digits of the Gibbs energy are the only guide to its precision.',
  );
  return { deltaH, deltaS, deltaG, log10K, K, rounding, enthalpyHasUncertainty: hUncertain, gibbsHasUncertainty: gUncertain, approximate: false };
}

export interface KineticsText {
  /** e.g. "1.7 × 10⁻¹⁴ cm³ molecule⁻¹ s⁻¹". */
  readonly k: string;
  /** e.g. "a factor of 1.2", when the source gives a reliability. */
  readonly kFactor?: string;
  readonly concentrationUnit: string;
  /** e.g. "58 s". */
  readonly halfLife?: string;
  readonly halfLifeSpecies?: string;
  /** Each species with its first and last concentration, e.g. "NO: 5 × 10¹¹ → 8.1 × 10¹⁰". */
  readonly change: readonly string[];
  /** Share of the limiting reactant that has reacted at the end of the trajectory, e.g. "84 %". */
  readonly conversion?: string;
  /** Time the trajectory ends at, e.g. "300 s". */
  readonly endTime?: string;
}

/** The kinetic results of an experiment as text: two significant figures, as the source prints its parameters. */
export function describeKinetics(model: KineticModel, rate: RateConstantResult, kinetics: KineticsResult | null): KineticsText {
  const k = `${formatSignificant(rate.k.value, 2)} ${prettyUnit(rate.k.unit)}`;
  const kFactor = rate.log10Uncertainty !== undefined ? `a factor of ${formatSignificant(10 ** rate.log10Uncertainty, 2)}` : undefined;
  const concentrationUnit = prettyUnit(model.concentrationUnit);
  if (!kinetics || kinetics.times.length === 0) return { k, ...(kFactor ? { kFactor } : {}), concentrationUnit, change: [] };

  const last = kinetics.times.length - 1;
  const change = kinetics.species.map((name) => {
    const series = kinetics.concentrations[name]!;
    return `${name}: ${formatSignificant(series[0]!, 2)} \u2192 ${formatSignificant(series[last]!, 2)} ${concentrationUnit}`;
  });
  let conversion: string | undefined;
  const limiting = kinetics.halfLife?.species;
  if (limiting) {
    const series = kinetics.concentrations[limiting];
    if (series && series[0]! > 0) {
      const percent = 100 * (1 - series[last]! / series[0]!);
      // Two significant figures, without writing "100" for a reaction that is only nearly over.
      conversion = series[last] === 0 ? '100 %' : percent >= 99.5 ? 'more than 99 %' : percent < 0.01 ? 'less than 0.01 %' : `${formatSignificant(percent, 2)} %`;
    }
  }
  return {
    k,
    ...(kFactor ? { kFactor } : {}),
    concentrationUnit,
    ...(kinetics.halfLife ? { halfLife: `${formatSignificant(kinetics.halfLife.seconds, 2)} s`, halfLifeSpecies: kinetics.halfLife.species } : {}),
    change,
    ...(conversion ? { conversion } : {}),
    // A complete trajectory ends at the duration that was entered; an incomplete one at a computed time.
    endTime: `${kinetics.status === 'ok' ? formatEntered(kinetics.times[last]!) : formatSignificant(kinetics.times[last]!, 3)} s`,
  };
}
