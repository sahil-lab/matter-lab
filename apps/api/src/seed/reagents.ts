/**
 * Curated, safe reagent allow-list for the educational titration/dilution templates. Each entry is
 * cross-linked to the existing compound catalogue (services/science) by an exact name lookup at
 * seed time; `scienceCompoundId` is left null when no match is found (never guessed).
 */
export interface ReagentSeed {
  readonly speciesId: string;
  readonly name: string;
  readonly formula: string;
  readonly roles: readonly ('ANALYTE' | 'TITRANT' | 'INDICATOR' | 'SOLVENT' | 'OTHER')[];
  /** Name to look up in compound_synonyms (lower-cased exact match). */
  readonly scienceCompoundName: string;
  readonly recommendedConcentrationMolPerL?: { min: number; max: number };
  readonly hazardNotes?: string;
}

export const REAGENT_SEEDS: readonly ReagentSeed[] = [
  {
    speciesId: 'HCl(aq)',
    name: 'Hydrochloric acid',
    formula: 'HCl',
    roles: ['ANALYTE'],
    scienceCompoundName: 'hydrochloric acid',
    recommendedConcentrationMolPerL: { min: 0.01, max: 1.0 },
    hazardNotes: 'Corrosive at laboratory concentrations above approximately 1 mol/L; dilute educational concentrations only.',
  },
  {
    speciesId: 'NaOH(aq)',
    name: 'Sodium hydroxide',
    formula: 'NaOH',
    roles: ['TITRANT', 'ANALYTE'],
    scienceCompoundName: 'sodium hydroxide',
    recommendedConcentrationMolPerL: { min: 0.01, max: 1.0 },
    hazardNotes: 'Corrosive; standard titrant for acid-base educational titrations at dilute concentrations.',
  },
  {
    speciesId: 'KOH(aq)',
    name: 'Potassium hydroxide',
    formula: 'KOH',
    roles: ['TITRANT', 'ANALYTE'],
    scienceCompoundName: 'potassium hydroxide',
    recommendedConcentrationMolPerL: { min: 0.01, max: 1.0 },
    hazardNotes: 'Corrosive; standard strong-base titrant at dilute concentrations.',
  },
  {
    speciesId: 'CH3COOH(aq)',
    name: 'Acetic acid',
    formula: 'CH3COOH',
    roles: ['ANALYTE'],
    scienceCompoundName: 'acetic acid',
    recommendedConcentrationMolPerL: { min: 0.01, max: 1.0 },
    hazardNotes: 'Weak acid: not modeled by the strong-acid/strong-base run method currently registered; a run against this species reports UNSUPPORTED.',
  },
  {
    speciesId: 'Phenolphthalein(aq)',
    name: 'Phenolphthalein indicator',
    formula: 'C20H14O4',
    roles: ['INDICATOR'],
    scienceCompoundName: 'phenolphthalein',
    hazardNotes: 'Used in trace amounts as a visual endpoint indicator; not part of the computed chemistry.',
  },
  {
    speciesId: 'H2O(l)',
    name: 'Water',
    formula: 'H2O',
    roles: ['SOLVENT'],
    scienceCompoundName: 'water',
  },
];
