import { STANDARD_TEMPERATURE_K } from '@matterlab/core';
import type { KineticModel, RateConstantResult } from '../kinetics/models';
import type { KineticsResult } from '../kinetics/simulate';
import { LIQUID_WATER_RANGE_K, THERMO_NO_WARNING_SPAN_K, THERMO_VALIDATED_SPAN_K } from '../thermo/reaction';
import type { ReactionThermo } from '../thermo/reaction';
import { celsius, formatEntered } from './describe';
import { formatFixed } from './format';
import type { ReadSpecies } from './input';
import type { KineticsPlan } from './plan';
import type { ExperimentInput } from './types';

/**
 * Phrases that the corresponding limitation sentences always contain, so that an interface (or a test) can
 * recognise them without depending on the rest of the wording.
 */
export const LIMITATION_PHRASES = {
  noPrediction: 'did not predict',
  catalystsAndSolvents: 'recorded with the experiment but not modelled',
  pressure: 'no pressure dependence is modelled',
  environment: 'Environment mismatch',
  gibbsNotRate: 'says nothing about rate',
  singleStep: 'not a model of a real mixture',
  temperature: 'outside the range',
} as const;

export interface Limitation {
  readonly key: string;
  /** The full sentence, as it appears in `ExperimentResult.limitations`. */
  readonly text: string;
  /** The same in plain language, for the beginner explanation. */
  readonly plain: string;
  /** True when the limitation arises from this particular experiment rather than from the method as such. */
  readonly specific: boolean;
}

/** What the limitations are derived from. */
export interface LimitationFacts {
  readonly input: ExperimentInput;
  readonly species: readonly ReadSpecies[];
  /** True when a uniquely balanced equation exists. */
  readonly hasEquation: boolean;
  /** True when thermodynamics was asked for and the equation is balanced. */
  readonly thermoRequested: boolean;
  readonly thermo: ReactionThermo | null;
  readonly kineticsPlan: KineticsPlan;
  readonly kineticModel: KineticModel | null;
  readonly rate: RateConstantResult | null;
  readonly kinetics: KineticsResult | null;
}

const listOf = (items: readonly string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** Contradictions between the declared environment and the phase labels of the reacting species. */
export function environmentMismatches(input: ExperimentInput, species: readonly ReadSpecies[]): { readonly text: string; readonly plain: string }[] {
  const reacting = species.filter((entry) => entry.species.role === 'reactant' || entry.species.role === 'product');
  const out: { text: string; plain: string }[] = [];
  if (input.conditions.environment === 'gas-phase') {
    const notGas = reacting.filter((entry) => entry.species.phase !== undefined && entry.species.phase !== 'g').map((entry) => entry.label);
    if (notGas.length > 0) {
      out.push({
        text:
          `${LIMITATION_PHRASES.environment}: the environment is given as gas phase, but ${listOf(notGas)} ${notGas.length === 1 ? 'is not labelled as a gas' : 'are not labelled as gases'}. ` +
          'The results are those of the equation with the phases as labelled.',
        plain: `You chose a gas-phase setting, but ${listOf(notGas)} ${notGas.length === 1 ? 'is not a gas' : 'are not gases'}. The values are for the substances in the states you labelled.`,
      });
    }
  }
  if (input.conditions.environment === 'aqueous-solution' && reacting.length > 0) {
    const allLabelled = reacting.every((entry) => entry.species.phase !== undefined);
    const inSolution = reacting.some((entry) => entry.species.phase === 'aq' || (entry.species.phase === 'l' && entry.composition === 'H2O'));
    if (allLabelled && !inSolution) {
      out.push({
        text:
          `${LIMITATION_PHRASES.environment}: the environment is given as aqueous solution, but none of the reacting species is labelled (aq) and liquid water is not among them. ` +
          'The results are those of the equation with the phases as labelled, not of a reaction in solution.',
        plain: 'You chose a setting in water, but none of the substances is labelled as dissolved. The values are for the substances in the states you labelled.',
      });
    }
  }
  return out;
}

/** Everything a reader must know before trusting the result, most general first. */
export function buildLimitations(facts: LimitationFacts): Limitation[] {
  const { input, thermo, kineticsPlan, kineticModel, rate, kinetics } = facts;
  const { conditions } = input;
  const out: Limitation[] = [];
  const kineticsShown = kineticModel !== null && rate !== null;
  const thermoShown = thermo !== null && (thermo.status === 'ok' || thermo.status === 'partial');

  if (facts.hasEquation) {
    out.push({
      key: 'no-prediction',
      text:
        `MATTER LAB ${LIMITATION_PHRASES.noPrediction} this reaction: it evaluated the equation built from the species that were entered. ` +
        'A balanced equation is bookkeeping, not evidence that the reaction takes place.',
      plain: 'MATTER LAB did not predict that these substances react. It only did the sums for the reaction you entered.',
      specific: false,
    });
  } else {
    out.push({
      key: 'no-prediction',
      text: `MATTER LAB ${LIMITATION_PHRASES.noPrediction} a reaction and does not predict products: it works only on a complete set of reactants and products that someone enters.`,
      plain: 'MATTER LAB does not work out what a reaction makes. It needs to be told the starting substances and the products.',
      specific: false,
    });
  }

  const bystanders = facts.species.filter((entry) => entry.species.role === 'catalyst' || entry.species.role === 'solvent');
  if (bystanders.length > 0) {
    const named = bystanders.map((entry) => `${entry.label} (${entry.species.role})`);
    out.push({
      key: 'catalysts-solvents',
      text:
        `Catalysts and solvents are ${LIMITATION_PHRASES.catalystsAndSolvents}: no supported model describes catalysis or solvation, so the results are those of the reaction as written. ` +
        `Recorded: ${listOf(named)}.`,
      plain: `${listOf(named)} ${named.length === 1 ? 'is' : 'are'} noted down but not part of the calculation. The results are for the reaction exactly as written.`,
      specific: true,
    });
  }

  if (conditions.pressureBar !== 1) {
    out.push({
      key: 'pressure',
      text:
        `The pressure of ${formatEntered(conditions.pressureBar)} bar is recorded but does not enter the calculation: thermodynamic values are standard-state (1 bar) values and ${LIMITATION_PHRASES.pressure}.` +
        (kineticsShown ? ' The rate law works with the concentrations that were entered, not with the pressure.' : ''),
      plain: `The pressure you set (${formatEntered(conditions.pressureBar)} bar) is not used. All values are for the standard pressure of 1 bar.`,
      specific: true,
    });
  }

  for (const mismatch of environmentMismatches(input, facts.species)) out.push({ key: 'environment', ...mismatch, specific: true });

  // --- thermodynamics -------------------------------------------------------------------------------------
  if (thermoShown && thermo) {
    out.push({
      key: 'standard-state',
      text:
        'Thermodynamic values refer to every species in its standard state (pure solids and liquids, ideal gases at 1 bar, ideal solutes). ' +
        'They are not the values of an actual mixture, and no equilibrium composition is computed.',
      plain: 'The energy values are for pure substances under standard conditions, not for a real mixture.',
      specific: false,
    });
    if (thermo.status === 'ok') {
      out.push({
        key: 'gibbs-not-rate',
        text: `A favourable Gibbs energy ${LIMITATION_PHRASES.gibbsNotRate}: thermodynamics tells where the equilibrium lies, not how fast it is reached or whether the reaction starts at all without ignition or a catalyst.`,
        plain: 'Being favoured is not the same as being fast. A favoured reaction can be far too slow to notice, or may need a spark to start.',
        specific: false,
      });
      const span = Math.abs(conditions.temperatureK - STANDARD_TEMPERATURE_K);
      const temperature = `${formatEntered(conditions.temperatureK)} K`;
      if (span > THERMO_VALIDATED_SPAN_K) {
        out.push({
          key: 'thermo-temperature',
          text:
            `The temperature of ${temperature} is ${LIMITATION_PHRASES.temperature} in which the constant-enthalpy, constant-entropy estimate is trusted (within ${THERMO_VALIDATED_SPAN_K} K of 298.15 K): ` +
            `it is ${formatFixed(span, 1)} K away. The Gibbs energy and the equilibrium constant are rough estimates, labelled rule-based; the size of their error is unknown, and melting, boiling or decomposition in between is not checked.`,
          plain: `The table values are for 25 \u00b0C. At ${temperature} (${celsius(conditions.temperatureK)}) the energy balance is only a rough estimate.`,
          specific: true,
        });
      } else if (span > THERMO_NO_WARNING_SPAN_K) {
        out.push({
          key: 'thermo-temperature',
          text:
            `The temperature of ${temperature} is ${formatFixed(span, 1)} K from 298.15 K, the temperature of the reference data. The Gibbs energy and the equilibrium constant assume a reaction enthalpy and entropy ` +
            'that do not change with temperature; the error of that approximation is not estimated.',
          plain: `The table values are for 25 \u00b0C. At ${temperature} (${celsius(conditions.temperatureK)}) the energy balance is an approximation.`,
          specific: true,
        });
      }
      const needsWater = thermo.terms.filter((term) => term.speciesId !== undefined && (term.speciesId.endsWith('(aq)') || term.speciesId === 'H2O(l)')).map((term) => term.speciesId!);
      if (needsWater.length > 0 && (conditions.temperatureK < LIQUID_WATER_RANGE_K[0] || conditions.temperatureK > LIQUID_WATER_RANGE_K[1])) {
        out.push({
          key: 'liquid-water',
          text:
            `The temperature of ${temperature} is ${LIMITATION_PHRASES.temperature} of liquid water at 1 bar (about ${LIQUID_WATER_RANGE_K[0]} K to ${LIQUID_WATER_RANGE_K[1]} K), ` +
            `so the standard states of ${listOf([...new Set(needsWater)])} do not exist there; the Gibbs energy and the equilibrium constant are a formal extrapolation.`,
          plain: `Water is not liquid at ${temperature} and normal pressure, so the values for dissolved substances are only formal.`,
          specific: true,
        });
      }
    } else {
      out.push({
        key: 'enthalpy-only',
        text:
          `Only the reaction enthalpy is given: the reference table has no standard entropy for ${listOf(thermo.missingEntropy)}, so no Gibbs energy or equilibrium constant can be computed. ` +
          `The enthalpy alone ${LIMITATION_PHRASES.gibbsNotRate} or about where the equilibrium lies.`,
        plain: `Only the heat of reaction is given. The table lacks the data needed to say which side is favoured (${listOf(thermo.missingEntropy)}).`,
        specific: true,
      });
    }
  } else if (facts.thermoRequested && thermo) {
    const missing = thermo.status === 'ambiguous-phase' ? thermo.terms.filter((term) => term.lookup === 'phase-required').map((term) => term.term) : thermo.missingSpecies;
    const why =
      thermo.status === 'ambiguous-phase'
        ? `${listOf(missing)} ${missing.length === 1 ? 'is' : 'are'} tabulated in several phases and no phase was given`
        : `${listOf(missing)} ${missing.length === 1 ? 'is' : 'are'} not in the reference table`;
    out.push({
      key: 'missing-thermo-data',
      text: `No thermodynamic values are given because ${why}. Nothing is estimated for a missing species, and no value is taken from a similar one.`,
      plain:
        thermo.status === 'ambiguous-phase'
          ? `MATTER LAB cannot tell which state ${listOf(missing)} ${missing.length === 1 ? 'is' : 'are'} in, so it gives no energy values. Choose a state for each.`
          : `MATTER LAB has no reference data for ${listOf(missing)}, so it gives no energy values. It does not guess them.`,
      specific: true,
    });
  }

  // --- kinetics -------------------------------------------------------------------------------------------
  if (kineticsPlan.kind === 'none') {
    out.push({
      key: 'no-rate-law',
      text: 'No sourced rate law is available for this reaction, so nothing is said about how fast it is. MATTER LAB does not substitute the rate law of a similar reaction.',
      plain: 'MATTER LAB has no published speed data for this reaction, so it says nothing about how fast it goes.',
      specific: false,
    });
  } else if (kineticsPlan.kind === 'refused') {
    out.push({
      key: kineticsPlan.why === 'environment' ? 'environment' : 'kinetics-pressure',
      text: kineticsPlan.message,
      plain:
        kineticsPlan.why === 'environment'
          ? 'Published speed data exist for this reaction between gases only. They do not apply in water, so no speed is given.'
          : `Published speed data for this reaction are valid at ${kineticsPlan.model.requiredPressureBar} bar only, so no speed is given at ${formatEntered(conditions.pressureBar)} bar.`,
      specific: true,
    });
  } else if (kineticsPlan.kind === 'needs-concentrations') {
    out.push({
      key: 'kinetics-not-run',
      text: `${kineticsPlan.message} The kinetics was therefore not simulated.`,
      plain: `Published speed data exist for this reaction, but the starting concentration of ${listOf(kineticsPlan.missing)} is needed to use them.`,
      specific: true,
    });
  }

  if (kineticsShown && kineticModel && rate) {
    const [low, high] = kineticModel.validTemperatureRangeK;
    out.push({
      key: 'single-step',
      text:
        `The simulation follows one elementary step in isolation, at constant temperature in a perfectly mixed volume. It is ${LIMITATION_PHRASES.singleStep}: ` +
        'further reactions of the products, competing reactions of the reactants and the reverse reaction are not included.',
      plain: 'The simulation follows only this one reaction. In a real mixture other reactions happen at the same time.',
      specific: false,
    });
    out.push({
      key: 'gas-phase-rate-law',
      text:
        `The rate expression is a gas-phase one, recommended by its source for ${low} K to ${high} K` +
        (kineticModel.conditions ? ` at ${kineticModel.conditions} only; MATTER LAB has no pressure-dependent expression for this reaction.` : '.'),
      plain: `The published speed data are for gases between ${low} K and ${high} K${kineticModel.conditions ? ` at ${kineticModel.conditions}` : ''}.`,
      specific: false,
    });
    if (!rate.withinValidatedRange) {
      out.push({
        key: 'kinetics-temperature',
        text:
          `The temperature of ${formatEntered(conditions.temperatureK)} K is ${LIMITATION_PHRASES.temperature} for which the rate expression is recommended (${low} K to ${high} K). ` +
          'The rate constant and everything computed from it are extrapolations, labelled rule-based; their error is unknown.',
        plain: `The published speed data cover ${low} K to ${high} K. At ${formatEntered(conditions.temperatureK)} K the speed is an extrapolation and may be far off.`,
        specific: true,
      });
    }
    if (kinetics && kinetics.status === 'incomplete') {
      const end = kinetics.times.length > 0 ? kinetics.times[kinetics.times.length - 1]! : 0;
      out.push({
        key: 'kinetics-incomplete',
        text: `The concentration curves are incomplete: they end at t = ${formatEntered(end)} s of ${formatEntered(conditions.durationSeconds)} s. ${kinetics.reasons.join(' ')}`,
        plain: `The step-by-step calculation stopped early, at ${formatEntered(end)} s of ${formatEntered(conditions.durationSeconds)} s, so the curves do not cover the whole time.`,
        specific: true,
      });
    }
    if (!kinetics || kinetics.status === 'unsupported') {
      out.push({
        key: 'kinetics-failed',
        text: `The rate constant is given, but no concentration curves could be computed. ${kinetics ? kinetics.reasons.join(' ') : ''}`.trim(),
        plain: 'The speed constant is given, but the concentration curves could not be calculated.',
        specific: true,
      });
    }
  }
  return out;
}
