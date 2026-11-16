import { MODEL_LIMITS, SCIENCE_METHOD_ID } from './model.js';

export type AnalyticalComponentId = 'ion:sodium' | 'ion:chloride' | 'family:acetate' | 'family:ammonia';
export type ReagentRole = 'SOLVENT' | 'STRONG_ACID' | 'STRONG_BASE' | 'WEAK_ACID' | 'WEAK_BASE'
  | 'CONJUGATE_ACID' | 'CONJUGATE_BASE' | 'NEUTRAL_SALT';

export interface AnalyticalComponentDefinition {
  readonly id: AnalyticalComponentId;
  readonly kind: 'RESOLVED_SPECTATOR' | 'ANALYTICAL_FAMILY';
  readonly label: string;
  readonly equilibriumSpeciesIds: readonly string[];
  readonly semantics: string;
}

export interface ReagentDefinition {
  readonly id: string;
  readonly label: string;
  readonly formula: string;
  readonly formulaBasis: 'REAGENT_ANALYTICAL_FORMULA';
  readonly phase: 'aq' | 'l';
  readonly role: ReagentRole;
  readonly modelId: string;
  readonly defaultConcentrationMolL: number;
  readonly maximumConcentrationMolL: number;
  readonly temperatureK: number;
  readonly components: readonly { readonly speciesId: AnalyticalComponentId; readonly molesPerMole: number }[];
  readonly sourceIds: readonly string[];
  readonly semantics: string;
  readonly safety: string;
}

const components: readonly AnalyticalComponentDefinition[] = [
  {
    id: 'ion:sodium', kind: 'RESOLVED_SPECTATOR', label: 'Dissolved sodium ion, Na+(aq)',
    equilibriumSpeciesIds: ['ion:sodium'],
    semantics: 'Conserved aqueous spectator-ion moles; positive charge supplies the strong-base equivalent when not balanced by an anion.',
  },
  {
    id: 'ion:chloride', kind: 'RESOLVED_SPECTATOR', label: 'Dissolved chloride ion, Cl-(aq)',
    equilibriumSpeciesIds: ['ion:chloride'],
    semantics: 'Conserved aqueous spectator-ion moles; negative charge supplies the strong-acid equivalent when not balanced by a cation.',
  },
  {
    id: 'family:acetate', kind: 'ANALYTICAL_FAMILY', label: 'Total aqueous acetic acid + acetate',
    equilibriumSpeciesIds: ['molecule:acetic-acid', 'ion:acetate'],
    semantics: 'Conserved CH3COOH + CH3COO- family total, not a count of free acetate ions. Speciation is an output of the solver.',
  },
  {
    id: 'family:ammonia', kind: 'ANALYTICAL_FAMILY', label: 'Total aqueous ammonia + ammonium',
    equilibriumSpeciesIds: ['molecule:ammonia', 'ion:ammonium'],
    semantics: 'Conserved NH3 + NH4+ family total, not a count of free NH3 or NH4+. Speciation is an output of the solver.',
  },
];

function reagent(
  id: string, label: string, formula: string, role: ReagentRole,
  recipe: readonly AnalyticalComponentId[], semantics: string, concentration = 0.1,
): ReagentDefinition {
  return {
    id, label, formula, role, formulaBasis: 'REAGENT_ANALYTICAL_FORMULA', phase: role === 'SOLVENT' ? 'l' : 'aq',
    modelId: SCIENCE_METHOD_ID,
    defaultConcentrationMolL: concentration,
    maximumConcentrationMolL: role === 'SOLVENT' ? 0 : MODEL_LIMITS.maximumComponentConcentrationMolL,
    temperatureK: MODEL_LIMITS.temperatureK,
    components: recipe.map((speciesId) => ({ speciesId, molesPerMole: 1 })),
    sourceIds: ['openstax-chem2e-14-2', 'openstax-chem2e-14-3'],
    semantics,
    safety: 'Virtual educational reagent only. This catalogue is not a preparation procedure or a substitute for chemical safety guidance.',
  };
}

const reagents: readonly ReagentDefinition[] = [
  reagent('water', 'Water (closed, ideal)', 'H2O', 'SOLVENT', [],
    'Water is implicit solvent, not 55.5 mol/L of a tracked solute. concentrationMolL must be zero.', 0),
  reagent('hcl', 'Hydrochloric acid (aqueous)', 'HCl', 'STRONG_ACID', ['ion:chloride'],
    'HCl is the analytical reagent formula, not intact aqueous HCl. Its chloride inventory and charge balance determine hydronium.'),
  reagent('naoh', 'Sodium hydroxide (aqueous)', 'NaOH', 'STRONG_BASE', ['ion:sodium'],
    'NaOH is the analytical reagent formula, not intact aqueous NaOH. Sodium inventory and charge balance determine hydroxide.'),
  reagent('acetic-acid', 'Acetic acid (aqueous)', 'CH3COOH', 'WEAK_ACID', ['family:acetate'],
    'One mole supplies one mole of total CH3COOH + CH3COO-, without assuming it remains undissociated.'),
  reagent('sodium-acetate', 'Sodium acetate (aqueous)', 'CH3COONa', 'CONJUGATE_BASE',
    ['ion:sodium', 'family:acetate'],
    'One mole supplies one mole each of sodium ions and the total acetate analytical family.', 0.05),
  reagent('ammonia', 'Ammonia (aqueous)', 'NH3', 'WEAK_BASE', ['family:ammonia'],
    'One mole supplies one mole of total NH3 + NH4+, with no volatilization or gas exchange.'),
  reagent('ammonium-chloride', 'Ammonium chloride (aqueous)', 'NH4Cl', 'CONJUGATE_ACID',
    ['ion:chloride', 'family:ammonia'],
    'One mole supplies one mole each of chloride ions and the total ammonia analytical family.', 0.05),
  reagent('sodium-chloride', 'Sodium chloride (aqueous)', 'NaCl', 'NEUTRAL_SALT',
    ['ion:sodium', 'ion:chloride'],
    'One mole supplies one mole each of dissolved sodium and chloride spectator ions.', 0.05),
];

export function getAnalyticalComponentDefinitions(): readonly AnalyticalComponentDefinition[] {
  return components.map((entry) => ({ ...entry, equilibriumSpeciesIds: [...entry.equilibriumSpeciesIds] }));
}

export function getReagentDefinitions(): readonly ReagentDefinition[] {
  return reagents.map((entry) => ({
    ...entry, components: entry.components.map((component) => ({ ...component })), sourceIds: [...entry.sourceIds],
  }));
}

export function findReagent(id: string): ReagentDefinition | undefined {
  return getReagentDefinitions().find((entry) => entry.id === id);
}

export function isAnalyticalComponentId(id: string): id is AnalyticalComponentId {
  return components.some((component) => component.id === id);
}
