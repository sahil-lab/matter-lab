import { balanceEquation } from '../balance';
import { SUPPORTED_REACTION_CLASSES } from '../catalogue';
import { checkConservation, formatEquation, parseEquation } from '../equation';
import type { Phase, ReactionEquation } from '../equation';
import { hillFormula, parseFormula } from '../formula';
import { KINETIC_MODELS, findKineticModels } from '../kinetics/models';
import type { KineticModel } from '../kinetics/models';
import { reactionThermodynamics } from '../thermo/reaction';
import type { CataloguedReaction } from './types';

/**
 * Titles of the example reactions of `SUPPORTED_REACTION_CLASSES`, keyed by the example as it is written
 * there. Reactions with a kinetic model take the name of the model instead. Each title only names the
 * reaction that the equation states.
 */
const TITLES: Readonly<Record<string, string>> = {
  '2 H2(g) + O2(g) -> 2 H2O(l)': 'Combustion of hydrogen',
  'CH4(g) + 2 O2(g) -> CO2(g) + 2 H2O(l)': 'Combustion of methane',
  'C2H5OH(l) + 3 O2(g) -> 2 CO2(g) + 3 H2O(l)': 'Combustion of ethanol',
  '2 CO(g) + O2(g) -> 2 CO2(g)': 'Combustion of carbon monoxide',
  'C(s) + O2(g) -> CO2(g)': 'Combustion of carbon (graphite)',
  'H2(g) + Cl2(g) -> 2 HCl(g)': 'Formation of hydrogen chloride from its elements',
  '2 HgO(s) -> 2 Hg(l) + O2(g)': 'Decomposition of mercury(II) oxide',
  'CaO(s) + H2O(l) -> Ca(OH)2(s)': 'Calcium oxide with water (slaking of lime)',
  '2 H2O2(g) -> 2 H2O(g) + O2(g)': 'Decomposition of hydrogen peroxide vapour',
  'N2(g) + 3 H2(g) <=> 2 NH3(g)': 'Ammonia synthesis equilibrium',
  'N2O4(g) <=> 2 NO2(g)': 'Dissociation of dinitrogen tetroxide',
  '2 SO2(g) + O2(g) <=> 2 SO3(g)': 'Oxidation of sulfur dioxide to sulfur trioxide',
  'H2(g) + I2(g) <=> 2 HI(g)': 'Hydrogen iodide equilibrium',
  'CO(g) + H2O(g) <=> CO2(g) + H2(g)': 'Water-gas shift equilibrium',
  'H+(aq) + OH-(aq) -> H2O(l)': 'Neutralisation of hydrogen ions by hydroxide ions',
  'NH3(g) + H+(aq) -> NH4+(aq)': 'Protonation of ammonia',
  'CO3^2-(aq) + H+(aq) -> HCO3-(aq)': 'Protonation of carbonate',
  'NH3(g) + HCl(g) -> NH4Cl(s)': 'Ammonia with hydrogen chloride',
  'NaCl(s) -> Na+(aq) + Cl-(aq)': 'Dissolution of sodium chloride',
  'CaCl2(s) -> Ca^2+(aq) + 2 Cl-(aq)': 'Dissolution of calcium chloride',
  'NH4Cl(s) -> NH4+(aq) + Cl-(aq)': 'Dissolution of ammonium chloride',
  'Ag+(aq) + Cl-(aq) -> AgCl(s)': 'Precipitation of silver chloride',
  'Pb^2+(aq) + SO4^2-(aq) -> PbSO4(s)': 'Precipitation of lead(II) sulfate',
  'CO2(g) -> CO2(aq)': 'Dissolution of carbon dioxide in water',
  'Zn(s) + Cu^2+(aq) -> Zn^2+(aq) + Cu(s)': 'Displacement of copper by zinc',
  'Mg(s) + 2 H+(aq) -> Mg^2+(aq) + H2(g)': 'Magnesium with hydrogen ions',
  'Cu(s) + 2 Ag+(aq) -> Cu^2+(aq) + 2 Ag(s)': 'Displacement of silver by copper',
  'Cl2(g) + 2 Br-(aq) -> 2 Cl-(aq) + Br2(l)': 'Displacement of bromine by chlorine',
  'MnO4- + Fe^2+ + H+ -> Mn^2+ + Fe^3+ + H2O': 'Permanganate with iron(II) in acid',
  'Cr2O7^2- + Fe^2+ + H+ -> Cr^3+ + Fe^3+ + H2O': 'Dichromate with iron(II) in acid',
  'Cu + NO3- + H+ -> Cu^2+ + NO + H2O': 'Copper with nitrate in acid, giving nitric oxide',
  'Fe^3+ + e- -> Fe^2+': 'Iron(III) to iron(II) half-reaction',
};

const LOOKUP_NOTE =
  'Catalogue lookup, not a prediction: this is a known reaction that MATTER LAB can evaluate, listed because its reactants are among the species given. ' +
  'It does not mean that the reaction takes place under your conditions.';

interface Entry {
  readonly reaction: CataloguedReaction;
  /** Each reactant by composition, with the phases a given species may have to count as that reactant (`null`: any). */
  readonly reactants: readonly { readonly composition: string; readonly phases: readonly Phase[] | null }[];
}

function describe(hasThermo: boolean, model: KineticModel | undefined): string {
  const thermo = hasThermo ? 'Its thermodynamics can be computed from the reference table.' : 'No thermodynamic values: at least one of its species is not in the reference table.';
  const kinetics = model
    ? `A sourced rate law is available (gas phase, ${model.validTemperatureRangeK[0]} K to ${model.validTemperatureRangeK[1]} K${model.conditions ? `, ${model.conditions}` : ''}).`
    : 'No sourced rate law, so no kinetics.';
  return `${LOOKUP_NOTE} ${thermo} ${kinetics}`;
}

function entry(id: string, title: string, reactionClass: string, equation: ReactionEquation): Entry {
  const model = findKineticModels(equation)[0];
  const status = reactionThermodynamics(equation).status;
  const hasThermo = status === 'ok' || status === 'partial';
  return {
    reaction: {
      id,
      equation: formatEquation(equation),
      title,
      reactionClass,
      hasThermo,
      hasKinetics: model !== undefined,
      note: describe(hasThermo, model),
      ...(model ? { kineticModelId: model.id } : {}),
    },
    reactants: equation.reactants.map((term) => ({
      composition: hillFormula(term.parsed),
      // The kinetic models are written without phase labels and are gas-phase reactions.
      phases: term.phase ? [term.phase] : model ? ['g'] : null,
    })),
  };
}

function build(): Entry[] {
  const entries: Entry[] = [];
  const modelled = new Set<string>();
  for (const info of SUPPORTED_REACTION_CLASSES) {
    info.exampleEquations.forEach((example, index) => {
      // An example that is balanced as written keeps its coefficients; a skeleton is balanced by conservation,
      // which must then leave no choice.
      const written = parseEquation(example);
      let equation: ReactionEquation | undefined;
      if (checkConservation(written).balanced) {
        equation = written;
      } else {
        const balance = balanceEquation(written);
        if (balance.status === 'balanced' && balance.independentSolutions === 1) equation = balance.equation;
      }
      if (!equation) throw new Error(`The catalogue example "${example}" does not have a unique balanced form.`);
      const model = findKineticModels(equation)[0];
      const title = model?.name ?? TITLES[example];
      if (!title) throw new Error(`The catalogue example "${example}" has no title.`);
      if (model) modelled.add(model.id);
      entries.push(entry(`${info.id}-${index + 1}`, title, info.id, equation));
    });
  }
  // A kinetic model that is not among the examples of its class still belongs to the catalogue.
  for (const model of KINETIC_MODELS) {
    if (!modelled.has(model.id)) entries.push(entry(`kinetic-${model.id}`, model.name, model.reactionClass, parseEquation(model.equation)));
  }
  return entries;
}

const ENTRIES: readonly Entry[] = build();

/**
 * Every reaction the package knows by name: the example equations of `SUPPORTED_REACTION_CLASSES` in
 * balanced form, and the kinetic models. It is a list of what can be evaluated, not of what happens.
 */
export const REACTION_CATALOGUE: readonly CataloguedReaction[] = ENTRIES.map((e) => e.reaction);

/**
 * The catalogued reactions whose reactants are all among the given species.
 *
 * A given species counts as a reactant when it has the same composition and charge and, if it carries a
 * phase label, the same phase (the gas-phase kinetic models, which are written without labels, count as
 * gases). Species that cannot be read as formulas are ignored. Extra species do not matter.
 *
 * This is a lookup in a fixed list. It predicts nothing: a reaction is returned because it is catalogued
 * and its reactants were named, not because it would occur under any particular conditions, and many
 * reactions that do occur are not in the list.
 */
export function suggestReactions(species: ReadonlyArray<{ readonly formula: string; readonly phase?: Phase }>): readonly CataloguedReaction[] {
  const given: { composition: string; phase: Phase | undefined }[] = [];
  for (const item of species) {
    try {
      given.push({ composition: hillFormula(parseFormula(item.formula)), phase: item.phase });
    } catch {
      // Not a formula: it cannot be the reactant of anything.
    }
  }
  if (given.length === 0) return [];
  return ENTRIES.filter((candidate) =>
    candidate.reactants.every((reactant) => given.some((g) => g.composition === reactant.composition && (g.phase === undefined || reactant.phases === null || reactant.phases.includes(g.phase)))),
  ).map((candidate) => candidate.reaction);
}
