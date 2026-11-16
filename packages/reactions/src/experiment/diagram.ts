import { GAS_CONSTANT_J_PER_MOL_K } from '@matterlab/core';
import { formatTerm, parseEquation } from '../equation';
import type { ReactionEquation, SpeciesTerm } from '../equation';
import { hillFormula } from '../formula';
import type { KineticModel } from '../kinetics/models';
import type { ReactionThermo } from '../thermo/reaction';
import { describeThermo, formatEntered } from './describe';
import { formatFixed, formatWithUncertainty } from './format';
import type { EnergyDiagram, EnergyLevel } from './types';

export interface DiagramFacts {
  readonly balanced: ReactionEquation;
  readonly temperatureK: number;
  /** True when thermodynamics was asked for. */
  readonly thermoRequested: boolean;
  readonly thermo: ReactionThermo | null;
  /** The kinetic model that was used, or `null`. */
  readonly kineticModel: KineticModel | null;
}

const side = (terms: readonly SpeciesTerm[]): string => terms.map(formatTerm).join(' + ');

/** The Arrhenius activation energy of a model in words: "10.9 ± 1.7 kJ/mol (E/R = 1310 K)". */
export function activationEnergyText(model: KineticModel): string {
  const uncertainty = model.reliability ? (model.reliability.deltaEOverRK * GAS_CONSTANT_J_PER_MOL_K) / 1000 : undefined;
  const value = formatWithUncertainty(model.arrhenius.EaKJPerMol, uncertainty, 1);
  const eOverR = model.asPublished ? ` (E/R = ${formatEntered(model.asPublished.EOverRK)} K${model.reliability ? ` \u00b1 ${formatEntered(model.reliability.deltaEOverRK)} K` : ''})` : '';
  return `${value} kJ/mol${eOverR}`;
}

/**
 * How many times the model's reaction, as its source writes it, goes into the balanced equation of the
 * experiment. It is 1 for every shipped model, because both are written with the smallest whole numbers.
 */
function scaleToModel(balanced: ReactionEquation, model: KineticModel): number {
  const reference = parseEquation(model.equation);
  const first = balanced.reactants[0]!;
  const match = reference.reactants.find((term) => hillFormula(term.parsed) === hillFormula(first.parsed));
  return match ? first.coefficient / match.coefficient : Number.NaN;
}

/**
 * Energy-level diagrams for an experiment.
 *
 * - The enthalpy diagram has the reactants at 0 and the products at the standard reaction enthalpy: the
 *   value computed from the reference table or, when the table cannot give it, the value printed on the
 *   data sheet of the kinetic model.
 * - A barrier is drawn only when a sourced kinetic model was used and its Arrhenius activation energy is
 *   positive, and only together with a product level. It is the empirical activation energy of the rate
 *   expression, not a computed transition state.
 * - When nothing honest can be drawn the enthalpy entry has no levels and its notes say why.
 * - The Gibbs diagram exists only when a Gibbs energy was computed, and never has a barrier.
 *
 * No diagram at all is returned when neither thermodynamics nor a kinetic model is in play.
 */
export function buildEnergyDiagrams(facts: DiagramFacts): EnergyDiagram[] {
  const { balanced, thermo, kineticModel: model } = facts;
  if (!facts.thermoRequested && !model) return [];
  const text = thermo ? describeThermo(thermo) : undefined;
  const reactantsLabel = `Reactants: ${side(balanced.reactants)}`;
  const productsLabel = `Products: ${side(balanced.products)}`;
  const diagrams: EnergyDiagram[] = [];

  // --- enthalpy -------------------------------------------------------------------------------------------
  const notes: string[] = [];
  const levels: EnergyLevel[] = [];
  const scale = model ? scaleToModel(balanced, model) : Number.NaN;
  const printedEnthalpy = model?.asPublished?.reactionEnthalpyKJPerMol;
  const sheet = model?.asPublished ? `data sheet ${model.asPublished.dataSheet} of the IUPAC evaluation` : 'the source of the rate expression';
  /** Why the reference table gives no reaction enthalpy, when it does not. */
  const missing = thermo ? thermo.missingSpecies : [];
  const unavailable =
    thermo === null
      ? 'thermodynamics from the reference table was not requested'
      : thermo.status === 'ambiguous-phase'
        ? 'a species is tabulated in several phases and no phase was given'
        : missing.length > 0
          ? `${missing.length <= 1 ? missing.join('') : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`} ${missing.length === 1 ? 'is' : 'are'} not in the reference table`
          : 'the reference data are incomplete';
  let products: EnergyLevel | undefined;
  if (thermo?.deltaH && text) {
    products = {
      kind: 'products',
      label: productsLabel,
      value: thermo.deltaH.value,
      evidence: thermo.deltaH.evidence,
      note: `Standard reaction enthalpy at 298.15 K: ${text.deltaH}, by Hess's law from the reference table.`,
    };
    if (printedEnthalpy !== undefined && scale === 1) notes.push(`For comparison, ${sheet} prints a standard reaction enthalpy of ${formatFixed(printedEnthalpy, 1)} kJ/mol at 298 K for this reaction.`);
  } else if (model && printedEnthalpy !== undefined && Number.isFinite(scale)) {
    products = {
      kind: 'products',
      label: productsLabel,
      value: printedEnthalpy * scale,
      evidence: 'reference',
      note:
        `Standard reaction enthalpy at 298 K as printed on ${sheet}: ${formatFixed(printedEnthalpy, 1)} kJ/mol` +
        (scale === 1 ? '.' : `, multiplied by ${scale} because the equation here is written with ${scale} times the coefficients of the data sheet.`),
    };
    notes.push(`The reaction enthalpy shown is the value printed on ${sheet}, because ${unavailable}.`);
  }

  if (products) {
    levels.push({ kind: 'reactants', label: reactantsLabel, value: 0, evidence: products.evidence, note: 'Reference level: the reactants are at zero by definition.' });
    if (model && model.arrhenius.EaKJPerMol > 0 && scale === 1) {
      const rt = (GAS_CONSTANT_J_PER_MOL_K * facts.temperatureK) / 1000;
      levels.push({
        kind: 'barrier',
        label: 'Empirical Arrhenius activation energy',
        value: model.arrhenius.EaKJPerMol,
        evidence: 'reference',
        note:
          `Ea = ${activationEnergyText(model)}, from the temperature dependence of the evaluated rate expression (${sheet}). ` +
          'It is an empirical Arrhenius activation energy, not a computed transition state: no transition-state structure or energy was calculated, ' +
          `and it differs from an enthalpy of activation by a term of the order of RT (${formatFixed(rt, 1)} kJ/mol at ${formatEntered(facts.temperatureK)} K).`,
      });
    }
    levels.push(products);
    notes.unshift(
      `Levels are enthalpies relative to the reactants, in kJ per mole of reaction as written. They are standard-state values at ${thermo?.deltaH ? '298.15 K' : '298 K'}, not at the temperature of the experiment; ` +
        'the lines between them are not a computed reaction path.',
    );
  }

  if (!products) {
    if (model) {
      notes.push(
        `No enthalpy diagram is drawn. The evaluated rate expression has an Arrhenius activation energy of ${activationEnergyText(model)}, but the reaction enthalpy is not available ` +
          `(${unavailable}, and ${sheet} prints none)` +
          (model.arrhenius.EaKJPerMol > 0 ? ', and a barrier without a product level would be half a picture.' : '.'),
      );
    } else {
      notes.push(`No enthalpy diagram is drawn: the reaction enthalpy could not be computed because ${unavailable}.`);
    }
  }
  if (model && model.arrhenius.EaKJPerMol <= 0) {
    notes.push(
      model.arrhenius.EaKJPerMol === 0
        ? 'No barrier is drawn: the evaluated rate expression has no temperature dependence, so there is no activation energy to show.'
        : `No barrier is drawn: the evaluated rate expression has a negative Arrhenius activation energy (Ea = ${activationEnergyText(model)}), which means that its rate constant falls as the temperature rises. ` +
            'A reaction like that has no simple energy barrier that an activation energy could stand for.',
    );
  } else if (model && products && scale !== 1) {
    notes.push('No barrier is drawn because the equation is not written with the coefficients of the data sheet the activation energy belongs to.');
  } else if (!model && products) {
    notes.push('No barrier is drawn: no sourced rate law was used for this reaction, and MATTER LAB does not estimate activation energies.');
  }
  diagrams.push({ quantity: 'enthalpy', unit: 'kJ/mol', levels, notes });

  // --- Gibbs energy ---------------------------------------------------------------------------------------
  if (thermo?.deltaG && text?.deltaG) {
    const evidence = thermo.deltaG.evidence;
    const atReference = Math.abs(thermo.temperatureK - 298.15) < 1e-9;
    diagrams.push({
      quantity: 'gibbs',
      unit: 'kJ/mol',
      levels: [
        { kind: 'reactants', label: reactantsLabel, value: 0, evidence, note: 'Reference level: the reactants are at zero by definition.' },
        {
          kind: 'products',
          label: productsLabel,
          value: thermo.deltaG.value,
          evidence,
          note: `Standard reaction Gibbs energy at ${formatEntered(thermo.temperatureK)} K: ${text.approximate ? 'about ' : ''}${text.deltaG}${atReference ? '' : ', estimated from the 298.15 K reaction enthalpy and entropy'}.`,
        },
      ],
      notes: [
        `Levels are standard Gibbs energies at ${formatEntered(thermo.temperatureK)} K relative to the reactants, in kJ per mole of reaction as written, with every species in its standard state.`,
        ...(atReference ? [] : ['Away from 298.15 K the Gibbs energy is an estimate that takes the reaction enthalpy and entropy as independent of temperature.']),
        model && model.arrhenius.EaKJPerMol > 0
          ? 'No barrier is drawn here: an Arrhenius activation energy is not a Gibbs energy of activation.'
          : 'No barrier is drawn: MATTER LAB has no Gibbs energy of activation for this reaction.',
      ],
    });
  }
  return diagrams;
}
