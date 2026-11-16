import { balanceEquation } from './balance';
import { asEquation, checkConservation } from './equation';
import type { ReactionEquation } from './equation';
import { findKineticModels } from './kinetics/models';
import { reactionThermodynamics } from './thermo/reaction';
import type { ReactionThermo } from './thermo/reaction';

export interface ReactionClassInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Equations of this class, in a form `parseEquation` reads. */
  readonly exampleEquations: readonly string[];
  /**
   * What the package can do for the class. A flag is `true` only when it holds for every example
   * equation above (the test suite checks this), so `false` means "not as a class": an individual reaction
   * may still be covered, which `reactionSupport` reports.
   */
  readonly supports: { readonly stoichiometry: boolean; readonly thermodynamics: boolean; readonly kinetics: boolean };
  /** What is not covered, in plain language, for display next to the class. */
  readonly limitations: readonly string[];
}

/**
 * The reaction classes this package genuinely supports. "Supports" always means that the package can
 * do the arithmetic for a reaction someone has written down; it never means that the package predicts
 * that the reaction happens.
 */
export const SUPPORTED_REACTION_CLASSES: readonly ReactionClassInfo[] = [
  {
    id: 'combustion',
    name: 'Combustion in oxygen',
    description: 'Complete or partial oxidation of an element or compound by O2, written as an overall equation.',
    exampleEquations: [
      '2 H2(g) + O2(g) -> 2 H2O(l)',
      'CH4(g) + 2 O2(g) -> CO2(g) + 2 H2O(l)',
      'C2H5OH(l) + 3 O2(g) -> 2 CO2(g) + 3 H2O(l)',
      '2 CO(g) + O2(g) -> 2 CO2(g)',
      'C(s) + O2(g) -> CO2(g)',
    ],
    supports: { stoichiometry: true, thermodynamics: true, kinetics: false },
    limitations: [
      'Thermodynamics only for fuels and products that are in the reference table; for ethane, propane and gaseous benzene the table has no entropy, so only the reaction enthalpy is available.',
      'No kinetics: flames are chain reactions with many steps, and the package has no model for them. Ignition, flame temperature and explosion limits are out of scope.',
    ],
  },
  {
    id: 'formation-decomposition',
    name: 'Formation and decomposition',
    description: 'A compound formed from simpler substances, or broken down into them.',
    exampleEquations: ['H2(g) + Cl2(g) -> 2 HCl(g)', '2 HgO(s) -> 2 Hg(l) + O2(g)', 'CaO(s) + H2O(l) -> Ca(OH)2(s)', '2 H2O2(g) -> 2 H2O(g) + O2(g)'],
    supports: { stoichiometry: true, thermodynamics: true, kinetics: false },
    limitations: [
      'Thermodynamics only for substances in the reference table, in the phase tabulated there.',
      'No kinetics, and no statement about whether a decomposition needs heating, light or a catalyst.',
    ],
  },
  {
    id: 'gas-equilibrium',
    name: 'Gas-phase equilibria',
    description: 'Reversible reactions between gases, for which the equilibrium constant is the quantity of interest.',
    exampleEquations: ['N2(g) + 3 H2(g) <=> 2 NH3(g)', 'N2O4(g) <=> 2 NO2(g)', '2 SO2(g) + O2(g) <=> 2 SO3(g)', 'H2(g) + I2(g) <=> 2 HI(g)', 'CO(g) + H2O(g) <=> CO2(g) + H2(g)'],
    supports: { stoichiometry: true, thermodynamics: true, kinetics: false },
    limitations: [
      'The equilibrium constant refers to ideal gases at a standard pressure of 1 bar. Equilibrium compositions, reaction quotients and the effect of pressure are not computed.',
      'Away from 298.15 K the constant is an estimate from temperature-independent reaction enthalpy and entropy, labelled as such; the table holds no heat capacities.',
      'No kinetics: how fast an equilibrium is reached is not modelled.',
    ],
  },
  {
    id: 'acid-base',
    name: 'Acid-base reactions',
    description: 'Neutralisation and proton transfer, with aqueous species written as ions.',
    exampleEquations: ['H+(aq) + OH-(aq) -> H2O(l)', 'NH3(g) + H+(aq) -> NH4+(aq)', 'CO3^2-(aq) + H+(aq) -> HCO3-(aq)', 'NH3(g) + HCl(g) -> NH4Cl(s)'],
    supports: { stoichiometry: true, thermodynamics: true, kinetics: false },
    limitations: [
      'Dissolved strong acids, bases and salts must be written as their ions; the table has no entries such as HCl(aq) or NaOH(aq).',
      'Results are for standard states (ideal solution, unit activity). pH, buffers, titration curves and activity corrections are not computed.',
      'No kinetics.',
    ],
  },
  {
    id: 'dissolution-precipitation',
    name: 'Dissolution and precipitation',
    description: 'A solid or gas going into aqueous solution as ions or molecules, or ions forming a solid.',
    exampleEquations: [
      'NaCl(s) -> Na+(aq) + Cl-(aq)',
      'CaCl2(s) -> Ca^2+(aq) + 2 Cl-(aq)',
      'NH4Cl(s) -> NH4+(aq) + Cl-(aq)',
      'Ag+(aq) + Cl-(aq) -> AgCl(s)',
      'Pb^2+(aq) + SO4^2-(aq) -> PbSO4(s)',
      'CO2(g) -> CO2(aq)',
    ],
    supports: { stoichiometry: true, thermodynamics: true, kinetics: false },
    limitations: [
      'Thermodynamics only for the solids and ions in the reference table. The equilibrium constant of a dissolution is a standard-state solubility product; actual solubilities, which depend on activities and on other ions present, are not computed.',
      'The package does not predict which combinations of ions give a precipitate.',
      'No kinetics.',
    ],
  },
  {
    id: 'redox-aqueous',
    name: 'Redox reactions in aqueous solution',
    description: 'Electron transfer between metals, ions, halogens and hydrogen, written as a complete ionic equation.',
    exampleEquations: ['Zn(s) + Cu^2+(aq) -> Zn^2+(aq) + Cu(s)', 'Mg(s) + 2 H+(aq) -> Mg^2+(aq) + H2(g)', 'Cu(s) + 2 Ag+(aq) -> Cu^2+(aq) + 2 Ag(s)', 'Cl2(g) + 2 Br-(aq) -> 2 Cl-(aq) + Br2(l)'],
    supports: { stoichiometry: true, thermodynamics: true, kinetics: false },
    limitations: [
      'Thermodynamics only for complete reactions between species in the reference table. Half-reactions containing "e-" can be balanced but not evaluated, and electrode potentials are not computed.',
      'Many common redox species (iron, manganese, chromium ions and others) are not in the table; equations with them can be balanced only.',
      'No kinetics, no overpotentials, no passivation: a favourable Gibbs energy does not mean the reaction is observed.',
    ],
  },
  {
    id: 'redox-balancing',
    name: 'Balancing redox equations with charges',
    description: 'Finding coefficients for ionic redox equations, in acidic or basic solution, by conservation of atoms and charge.',
    exampleEquations: ['MnO4- + Fe^2+ + H+ -> Mn^2+ + Fe^3+ + H2O', 'Cr2O7^2- + Fe^2+ + H+ -> Cr^3+ + Fe^3+ + H2O', 'Cu + NO3- + H+ -> Cu^2+ + NO + H2O', 'Fe^3+ + e- -> Fe^2+'],
    supports: { stoichiometry: true, thermodynamics: false, kinetics: false },
    limitations: [
      'Bookkeeping only. H+, OH- and H2O must be written into the equation; the package does not add them.',
      'When conservation allows more than one independent solution the equation is reported as underdetermined rather than balanced by an arbitrary choice.',
    ],
  },
  {
    id: 'gas-bimolecular',
    name: 'Elementary bimolecular gas reactions',
    description: 'Single-step reactions between two gas-phase species with a second-order rate law, from the IUPAC evaluation of kinetic data for atmospheric chemistry.',
    exampleEquations: ['NO + O3 -> NO2 + O2', 'NO2 + O3 -> NO3 + O2', 'O + O3 -> 2 O2', 'OH + H2 -> H2O + H', 'NO + NO3 -> 2 NO2'],
    supports: { stoichiometry: true, thermodynamics: false, kinetics: true },
    limitations: [
      'Kinetics only for the reactions listed, each within its own validated temperature range; outside it the rate constant is an extrapolation and is labelled as one.',
      'Each model is one elementary step in isolation. Further reactions of the products and competing reactions of the reactants are not included, so a simulation is not a model of a real gas mixture.',
      'Thermodynamics is available only for those of these reactions whose species are all in the reference table (NO + O3 and O + O3); OH and NO3 are not tabulated.',
    ],
  },
  {
    id: 'gas-termolecular',
    name: 'Termolecular gas reaction',
    description: 'The third-order oxidation of nitric oxide by oxygen, whose rate falls as the temperature rises.',
    exampleEquations: ['2 NO + O2 -> 2 NO2'],
    supports: { stoichiometry: true, thermodynamics: true, kinetics: true },
    limitations: ['One reaction only. The rate law is the overall third-order expression of the evaluation; the underlying mechanism is not modelled.'],
  },
  {
    id: 'gas-radical-self-reaction',
    name: 'Radical self-reaction',
    description: 'Two identical radicals reacting with each other, second order in one species.',
    exampleEquations: ['2 C2H3O3 -> 2 C2H3O2 + O2'],
    supports: { stoichiometry: true, thermodynamics: false, kinetics: true },
    limitations: [
      'One reaction only: the self-reaction of the acetylperoxy radical, written by composition (C2H3O3 is CH3C(O)O2).',
      'No thermodynamic data for the radicals. The acetyloxy radical formed decomposes further, which is not modelled.',
    ],
  },
  {
    id: 'gas-unimolecular-decomposition',
    name: 'Unimolecular decomposition',
    description: 'Thermal decomposition of a single gas-phase species with a first-order rate law at a stated pressure.',
    exampleEquations: ['C4H5NO5 -> C4H5O3 + NO2'],
    supports: { stoichiometry: true, thermodynamics: false, kinetics: true },
    limitations: [
      'One reaction only: peroxymethacryloyl nitrate (MPAN), written by composition. The rate expression holds only at the total pressure and within the temperature range stated in the model.',
      'The reverse association, which re-forms MPAN unless the peroxy radical is removed, is not modelled. No thermodynamic data for these species.',
    ],
  },
];

export interface UnsupportedFeature {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/** What the package deliberately does not do, so that an interface can say so instead of implying otherwise. */
export const UNSUPPORTED_FEATURES: readonly UnsupportedFeature[] = [
  {
    id: 'reaction-prediction',
    name: 'Predicting reactions',
    description:
      'The package never decides whether substances react, what the products are, or under which conditions. It works on equations a person supplies. Putting substances in one container is not a reaction.',
  },
  {
    id: 'mechanisms',
    name: 'Reaction mechanisms and networks',
    description: 'Only single reactions are simulated. Coupled or consecutive reactions, reversible kinetics, chain reactions, steady states and oscillations are not.',
  },
  {
    id: 'solution-kinetics',
    name: 'Kinetics in solution, at surfaces or with catalysts',
    description: 'No sourced rate laws are shipped for reactions in solution, heterogeneous or enzymatic catalysis, electrode processes or photochemistry.',
  },
  {
    id: 'pressure-dependent-kinetics',
    name: 'Pressure-dependent rate constants',
    description: 'Fall-off expressions for association and dissociation reactions are not implemented; the one first-order model applies only at the total pressure stated in it.',
  },
  {
    id: 'non-standard-conditions',
    name: 'Non-standard conditions',
    description: 'Thermodynamic results are standard-state values. Reaction quotients, equilibrium compositions, partial pressures, concentrations, activity or fugacity coefficients, pH and electrode potentials are not computed.',
  },
  {
    id: 'temperature-dependent-thermodynamics',
    name: 'Temperature-dependent thermodynamic data',
    description: 'The table holds values at 298.15 K only: no heat capacities, no phase-transition data. Gibbs energies at other temperatures are constant-enthalpy, constant-entropy estimates and are labelled as such.',
  },
  {
    id: 'missing-species',
    name: 'Species outside the reference table',
    description: 'Thermodynamics needs every species of the equation to be in the table, in the phase requested. Nothing is estimated for missing species, for example by group additivity or bond energies.',
  },
  {
    id: 'structure',
    name: 'Structure, isomers and names',
    description: 'Formulas are compositions. Structural formulas, isomers, isotopes, non-integer subscripts and chemical names are not understood.',
  },
  {
    id: 'nuclear',
    name: 'Nuclear reactions',
    description: 'Balancing conserves elements, so equations in which one element turns into another cannot be handled.',
  },
];

export interface ReactionSupport {
  /** Whether the equation as written conserves every element and the charge. */
  readonly balanced: boolean;
  /** Outcome of `balanceEquation` for the equation. */
  readonly balancing: 'balanced' | 'already-balanced' | 'impossible' | 'underdetermined';
  readonly thermodynamics: {
    /** True when at least the reaction enthalpy can be computed from the table. */
    readonly available: boolean;
    readonly status: ReactionThermo['status'];
    readonly missingSpecies: readonly string[];
    readonly missingEntropy: readonly string[];
  };
  readonly kinetics: {
    /** True when a sourced rate law for exactly this reaction is shipped. */
    readonly available: boolean;
    readonly modelIds: readonly string[];
  };
  readonly notes: readonly string[];
}

/**
 * What the package can do for one particular equation: whether it is balanced, whether the reference
 * table covers every species, and whether a sourced kinetic model exists for it.
 *
 * @throws ChemicalSyntaxError when a string input cannot be parsed.
 */
export function reactionSupport(input: ReactionEquation | string): ReactionSupport {
  const equation = asEquation(input);
  const balanced = checkConservation(equation).balanced;
  const thermo = reactionThermodynamics(equation);
  const models = findKineticModels(equation);
  const notes = ['Support describes what can be calculated for the equation as written. It is not a statement that the reaction takes place.'];
  if (!balanced) notes.push('The equation is not balanced as written; thermodynamic quantities are only defined for a balanced equation.');
  if (models.length === 0) notes.push('No sourced rate law is available for this reaction, so its kinetics cannot be simulated.');
  return {
    balanced,
    balancing: balanceEquation(equation).status,
    thermodynamics: {
      available: thermo.status === 'ok' || thermo.status === 'partial',
      status: thermo.status,
      missingSpecies: thermo.missingSpecies,
      missingEntropy: thermo.missingEntropy,
    },
    kinetics: { available: models.length > 0, modelIds: models.map((m) => m.id) },
    notes,
  };
}
