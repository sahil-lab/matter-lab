export type ElementCategory =
  | 'nonmetal'
  | 'noble-gas'
  | 'alkali-metal'
  | 'alkaline-earth-metal'
  | 'metalloid'
  | 'halogen'
  | 'post-transition-metal'
  | 'transition-metal'
  | 'lanthanide'
  | 'actinide';

export type ElementBlock = 's' | 'p' | 'd' | 'f';

export interface ElementInfo {
  /** Atomic number (number of protons). */
  readonly z: number;
  readonly symbol: string;
  readonly name: string;
  /**
   * Standard atomic weight in unified atomic mass units. For elements with no stable isotope this is
   * the mass of a long-lived isotope, as listed by PubChem.
   */
  readonly atomicWeight: number;
  readonly period: number;
  /** IUPAC group 1-18; `null` for the lanthanide and actinide series. */
  readonly group: number | null;
  readonly block: ElementBlock;
  /** 1-based row/column in the 18-column long-form table; the f-block series occupy rows 9 and 10. */
  readonly tableRow: number;
  readonly tableColumn: number;
  readonly category: ElementCategory;
  readonly standardState: 'solid' | 'liquid' | 'gas';
  /** True when the standard state is a prediction rather than an observation. */
  readonly standardStatePredicted: boolean;
  /** Ground-state configuration of the neutral atom, e.g. `[He] 2s2 2p2`. */
  readonly electronConfiguration: string;
  readonly electronConfigurationPredicted: boolean;
  readonly electronegativityPauling: number | null;
  /** First ionisation energy in eV. */
  readonly ionizationEnergyEv: number | null;
  readonly electronAffinityEv: number | null;
  readonly oxidationStates: readonly number[];
  readonly meltingPointK: number | null;
  readonly boilingPointK: number | null;
  readonly densityGPerCm3: number | null;
  readonly yearDiscovered: number | 'ancient';
  /** Single-bond covalent radius in angstrom (Cordero et al. 2008, as distributed with RDKit). */
  readonly covalentRadius: number;
  /** van der Waals radius in angstrom. */
  readonly vdwRadius: number;
  readonly vdwRadiusSource: 'pubchem' | 'rdkit';
  /** sRGB hex colour following the Jmol/CPK convention, e.g. `#FF0D0D`. */
  readonly color: string;
  readonly colorSource: 'pubchem' | 'jmol' | 'fallback';
  /** Total valences RDKit's valence model permits for the neutral atom. */
  readonly valences: readonly number[];
  /** True when RDKit places no upper bound on the valence (most metals). */
  readonly valenceUnconstrained: boolean;
  /** Number of outer-shell electrons used by the valence model. */
  readonly outerElectrons: number;
  /** Mass number of the most abundant (or longest-lived) isotope. */
  readonly mostCommonIsotope: number;
  /** Mass of that isotope in unified atomic mass units. */
  readonly mostCommonIsotopeMass: number;
}

export interface ElementDataSource {
  readonly id: string;
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly version?: string;
  readonly retrieved?: string;
  readonly license?: string;
  /** Which `ElementInfo` fields this source supplies. */
  readonly fields: string;
}
