import type { ExperimentPreset } from './types';

/**
 * Representative experiments across the supported reaction classes, including two that are meant to fail
 * in an instructive way. Every input runs, and the test suite checks that each one produces the status
 * stated here.
 *
 * The concentrations and durations of the kinetic presets are starting values chosen so that the change is
 * visible within the run. They are example input, not data about any real system.
 */
export const EXPERIMENT_PRESETS: readonly ExperimentPreset[] = [
  {
    id: 'methane-combustion',
    title: 'Combustion of methane',
    description: 'Methane burning in oxygen to carbon dioxide and liquid water, at 298.15 K: how much heat is released, and which side is favoured.',
    reactionClass: 'combustion',
    expectedStatus: 'completed',
    demonstrates: 'Reaction enthalpy, entropy, Gibbs energy and equilibrium constant from the reference table; no kinetics, because flames are not modelled.',
    input: {
      title: 'Combustion of methane',
      species: [
        { formula: 'CH4', phase: 'g', role: 'reactant', name: 'methane' },
        { formula: 'O2', phase: 'g', role: 'reactant', name: 'oxygen' },
        { formula: 'CO2', phase: 'g', role: 'product', name: 'carbon dioxide' },
        { formula: 'H2O', phase: 'l', role: 'product', name: 'water' },
      ],
      conditions: { temperatureK: 298.15, pressureBar: 1, durationSeconds: 60, environment: 'unspecified', concentrationUnit: 'mol/L' },
      method: 'auto',
    },
  },
  {
    id: 'ammonia-synthesis-298k',
    title: 'Ammonia synthesis equilibrium at 298.15 K',
    description: 'Nitrogen and hydrogen forming ammonia, evaluated at the temperature of the reference data.',
    reactionClass: 'gas-equilibrium',
    expectedStatus: 'completed',
    demonstrates: 'A gas-phase equilibrium constant at 298.15 K, with propagated uncertainty.',
    input: {
      title: 'Ammonia synthesis at 298.15 K',
      species: [
        { formula: 'N2', phase: 'g', role: 'reactant', name: 'nitrogen' },
        { formula: 'H2', phase: 'g', role: 'reactant', name: 'hydrogen' },
        { formula: 'NH3', phase: 'g', role: 'product', name: 'ammonia' },
      ],
      conditions: { temperatureK: 298.15, pressureBar: 1, durationSeconds: 60, environment: 'gas-phase', concentrationUnit: 'mol/L' },
      method: 'auto',
    },
  },
  {
    id: 'ammonia-synthesis-700k',
    title: 'Ammonia synthesis at 700 K and 200 bar over an iron catalyst',
    description: 'The same equilibrium far from 298.15 K, at high pressure and with a catalyst listed: three things the model does not cover, each of which the result says so.',
    reactionClass: 'gas-equilibrium',
    expectedStatus: 'completed',
    demonstrates:
      'The Gibbs energy becomes a rule-based estimate far from 298.15 K; the pressure does not enter the standard-state values; the catalyst is recorded but not modelled.',
    input: {
      title: 'Ammonia synthesis at 700 K and 200 bar',
      species: [
        { formula: 'N2', phase: 'g', role: 'reactant', name: 'nitrogen' },
        { formula: 'H2', phase: 'g', role: 'reactant', name: 'hydrogen' },
        { formula: 'NH3', phase: 'g', role: 'product', name: 'ammonia' },
        { formula: 'Fe', phase: 's', role: 'catalyst', name: 'iron' },
      ],
      conditions: { temperatureK: 700, pressureBar: 200, durationSeconds: 60, environment: 'gas-phase', concentrationUnit: 'mol/L' },
      method: 'auto',
    },
  },
  {
    id: 'neutralisation',
    title: 'Neutralisation',
    description: 'Hydrogen ions and hydroxide ions forming water in aqueous solution.',
    reactionClass: 'acid-base',
    expectedStatus: 'completed',
    demonstrates: 'Aqueous ions in the hydrogen-ion convention of the reference table; water listed as the solvent is recorded but not modelled.',
    input: {
      title: 'Neutralisation of a strong acid by a strong base',
      species: [
        { formula: 'H+', phase: 'aq', role: 'reactant', name: 'hydrogen ion' },
        { formula: 'OH-', phase: 'aq', role: 'reactant', name: 'hydroxide ion' },
        { formula: 'H2O', phase: 'l', role: 'product', name: 'water' },
        { formula: 'H2O', phase: 'l', role: 'solvent', name: 'water' },
      ],
      conditions: { temperatureK: 298.15, pressureBar: 1, durationSeconds: 60, environment: 'aqueous-solution', concentrationUnit: 'mol/L' },
      method: 'auto',
    },
  },
  {
    id: 'silver-chloride-precipitation',
    title: 'Precipitation of silver chloride',
    description: 'Silver ions and chloride ions forming solid silver chloride.',
    reactionClass: 'dissolution-precipitation',
    expectedStatus: 'completed',
    demonstrates: 'A precipitation from aqueous ions; the equilibrium constant is the reciprocal of a standard-state solubility product.',
    input: {
      title: 'Precipitation of silver chloride',
      species: [
        { formula: 'Ag+', phase: 'aq', role: 'reactant', name: 'silver ion' },
        { formula: 'Cl-', phase: 'aq', role: 'reactant', name: 'chloride ion' },
        { formula: 'AgCl', phase: 's', role: 'product', name: 'silver chloride' },
        { formula: 'H2O', phase: 'l', role: 'solvent', name: 'water' },
      ],
      conditions: { temperatureK: 298.15, pressureBar: 1, durationSeconds: 60, environment: 'aqueous-solution', concentrationUnit: 'mol/L' },
      method: 'auto',
    },
  },
  {
    id: 'zinc-copper-displacement',
    title: 'Displacement of copper by zinc',
    description: 'Zinc metal and copper(II) ions giving zinc ions and copper metal.',
    reactionClass: 'redox-aqueous',
    expectedStatus: 'completed',
    demonstrates: 'A complete ionic redox equation balanced for atoms and charge and evaluated from the reference table.',
    input: {
      title: 'Zinc and copper(II) ions',
      species: [
        { formula: 'Zn', phase: 's', role: 'reactant', name: 'zinc' },
        { formula: 'Cu^2+', phase: 'aq', role: 'reactant', name: 'copper(II) ion' },
        { formula: 'Zn^2+', phase: 'aq', role: 'product', name: 'zinc ion' },
        { formula: 'Cu', phase: 's', role: 'product', name: 'copper' },
        { formula: 'H2O', phase: 'l', role: 'solvent', name: 'water' },
      ],
      conditions: { temperatureK: 298.15, pressureBar: 1, durationSeconds: 60, environment: 'aqueous-solution', concentrationUnit: 'mol/L' },
      method: 'auto',
    },
  },
  {
    id: 'sodium-chloride-dissolution',
    title: 'Dissolution of sodium chloride',
    description: 'Solid sodium chloride going into solution as sodium and chloride ions.',
    reactionClass: 'dissolution-precipitation',
    expectedStatus: 'completed',
    demonstrates: 'Values from two reference tables combined (the solid from the NIST WebBook, the ions from CODATA), which the result points out.',
    input: {
      title: 'Dissolution of sodium chloride',
      species: [
        { formula: 'NaCl', phase: 's', role: 'reactant', name: 'sodium chloride' },
        { formula: 'Na+', phase: 'aq', role: 'product', name: 'sodium ion' },
        { formula: 'Cl-', phase: 'aq', role: 'product', name: 'chloride ion' },
        { formula: 'H2O', phase: 'l', role: 'solvent', name: 'water' },
      ],
      conditions: { temperatureK: 298.15, pressureBar: 1, durationSeconds: 60, environment: 'aqueous-solution', concentrationUnit: 'mol/L' },
      method: 'auto',
    },
  },
  {
    id: 'no-o3-kinetics',
    title: 'Nitric oxide and ozone: thermodynamics and kinetics',
    description: 'The gas-phase reaction of nitric oxide with ozone at 298 K, followed for five minutes.',
    reactionClass: 'gas-bimolecular',
    expectedStatus: 'completed',
    demonstrates: 'A sourced second-order rate law integrated in time, with half-life and an energy diagram that includes the empirical Arrhenius activation energy.',
    input: {
      title: 'Nitric oxide and ozone',
      species: [
        { formula: 'NO', phase: 'g', role: 'reactant', name: 'nitric oxide', initialConcentration: 5e11 },
        { formula: 'O3', phase: 'g', role: 'reactant', name: 'ozone', initialConcentration: 1e12 },
        { formula: 'NO2', phase: 'g', role: 'product', name: 'nitrogen dioxide' },
        { formula: 'O2', phase: 'g', role: 'product', name: 'oxygen' },
      ],
      conditions: { temperatureK: 298, pressureBar: 1, durationSeconds: 300, environment: 'gas-phase', concentrationUnit: 'molecule/cm3' },
      method: 'auto',
    },
  },
  {
    id: 'no-o2-termolecular-kinetics',
    title: 'Oxidation of nitric oxide by oxygen',
    description: 'The third-order gas-phase reaction of nitric oxide with oxygen at 298 K.',
    reactionClass: 'gas-termolecular',
    expectedStatus: 'completed',
    demonstrates: 'A termolecular rate law whose rate constant falls with rising temperature, so that no energy barrier is drawn.',
    input: {
      title: 'Nitric oxide and oxygen',
      species: [
        { formula: 'NO', phase: 'g', role: 'reactant', name: 'nitric oxide', initialConcentration: 1e15 },
        { formula: 'O2', phase: 'g', role: 'reactant', name: 'oxygen', initialConcentration: 5e18 },
        { formula: 'NO2', phase: 'g', role: 'product', name: 'nitrogen dioxide' },
      ],
      conditions: { temperatureK: 298, pressureBar: 1, durationSeconds: 20000, environment: 'gas-phase', concentrationUnit: 'molecule/cm3' },
      method: 'auto',
    },
  },
  {
    id: 'mpan-decomposition-kinetics',
    title: 'Thermal decomposition of MPAN',
    description: 'First-order decomposition of peroxymethacryloyl nitrate at 298 K and 1 bar, followed for two hours.',
    reactionClass: 'gas-unimolecular-decomposition',
    expectedStatus: 'completed',
    demonstrates: 'A first-order rate law that is valid at 1 bar only; no energy diagram, because no reaction enthalpy is available for these species.',
    input: {
      title: 'Thermal decomposition of MPAN',
      species: [
        { formula: 'C4H5NO5', phase: 'g', role: 'reactant', name: 'peroxymethacryloyl nitrate (MPAN)', initialConcentration: 1e10 },
        { formula: 'C4H5O3', phase: 'g', role: 'product', name: 'methacryloylperoxy radical' },
        { formula: 'NO2', phase: 'g', role: 'product', name: 'nitrogen dioxide' },
      ],
      conditions: { temperatureK: 298, pressureBar: 1, durationSeconds: 7200, environment: 'gas-phase', concentrationUnit: 'molecule/cm3' },
      method: 'kinetics',
    },
  },
  {
    id: 'iron-oxidation-missing-data',
    title: 'Oxidation of iron: a species without reference data',
    description: 'Iron and oxygen forming iron(III) oxide. The equation balances, but the reference table has no iron species.',
    reactionClass: 'formation-decomposition',
    expectedStatus: 'partial',
    demonstrates: 'A deliberate gap: the equation is balanced, the missing species are named, and no thermodynamic value is estimated for them.',
    input: {
      title: 'Oxidation of iron',
      species: [
        { formula: 'Fe', phase: 's', role: 'reactant', name: 'iron' },
        { formula: 'O2', phase: 'g', role: 'reactant', name: 'oxygen' },
        { formula: 'Fe2O3', phase: 's', role: 'product', name: 'iron(III) oxide' },
      ],
      conditions: { temperatureK: 298.15, pressureBar: 1, durationSeconds: 60, environment: 'unspecified', concentrationUnit: 'mol/L' },
      method: 'auto',
    },
  },
  {
    id: 'methane-oxygen-no-products',
    title: 'Methane and oxygen with no products entered',
    description: 'Only reactants are given. MATTER LAB does not predict what they form; the catalogue lookup can list known reactions of these species.',
    reactionClass: 'combustion',
    expectedStatus: 'unsupported',
    demonstrates: 'A deliberate refusal: without products nothing is calculated and nothing is guessed.',
    input: {
      title: 'Methane and oxygen, products not entered',
      species: [
        { formula: 'CH4', phase: 'g', role: 'reactant', name: 'methane' },
        { formula: 'O2', phase: 'g', role: 'reactant', name: 'oxygen' },
      ],
      conditions: { temperatureK: 298.15, pressureBar: 1, durationSeconds: 60, environment: 'gas-phase', concentrationUnit: 'mol/L' },
      method: 'auto',
    },
  },
];
