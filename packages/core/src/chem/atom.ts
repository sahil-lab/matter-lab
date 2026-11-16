import { ELECTRON_MASS_U } from '../constants';
import { getElement } from '../elements';
import { describeStability, findIsotope, isotopeMass, naturalIsotopes, representativeIsotope } from '../isotopes';
import type { IsotopeInfo } from '../isotopes';
import type { EvidenceLevel } from '../provenance';
import type { Atom } from '../types';

type Particles = Pick<Atom, 'protons' | 'neutrons' | 'electrons'>;

const SUPERSCRIPT_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉';

export function toSuperscript(n: number): string {
  return String(Math.abs(n)).replace(/\d/g, (d) => SUPERSCRIPT_DIGITS[Number(d)]!);
}

export function toSubscript(n: number): string {
  return String(Math.abs(n)).replace(/\d/g, (d) => SUBSCRIPT_DIGITS[Number(d)]!);
}

/** Charge as written by chemists: "", "+", "2+", "−", "3−" (with a true minus sign). */
export function formatCharge(charge: number): string {
  if (charge === 0) return '';
  const magnitude = Math.abs(charge);
  return `${magnitude === 1 ? '' : magnitude}${charge > 0 ? '+' : '−'}`;
}

/** Charge as a superscript suffix, e.g. "²⁻". */
export function formatChargeSuperscript(charge: number): string {
  if (charge === 0) return '';
  const magnitude = Math.abs(charge);
  return `${magnitude === 1 ? '' : toSuperscript(magnitude)}${charge > 0 ? '⁺' : '⁻'}`;
}

/** Net charge in units of e. */
export function atomCharge(atom: Particles): number {
  return atom.protons - atom.electrons;
}

export function atomSymbol(atom: Pick<Atom, 'protons'>): string {
  return getElement(atom.protons).symbol;
}

/** Mass number A = Z + N, or `null` when no isotope is specified. */
export function atomMassNumber(atom: Particles): number | null {
  return atom.neutrons === null ? null : atom.protons + atom.neutrons;
}

/** Species label such as "C", "¹³C", "Na⁺" or "¹⁸O²⁻". */
export function atomLabel(atom: Particles): string {
  const a = atomMassNumber(atom);
  return `${a === null ? '' : toSuperscript(a)}${atomSymbol(atom)}${formatChargeSuperscript(atomCharge(atom))}`;
}

export interface AtomMass {
  /** Mass in unified atomic mass units, including the electron-count correction for ions. */
  readonly mass: number;
  /**
   * `standard-atomic-weight`: no isotope specified, natural composition assumed.
   * `isotope-mass`: evaluated mass of the specified nuclide (AME2020).
   * `mass-number-estimate`: the nuclide has no evaluated mass, so A u is used as a rough estimate.
   */
  readonly basis: 'standard-atomic-weight' | 'isotope-mass' | 'mass-number-estimate';
}

/**
 * Mass of the atom or ion. Tabulated masses are for neutral atoms, so one electron mass is removed
 * or added per unit of charge; electron binding energies (a few eV, ~1e-8 u) are neglected.
 */
export function atomMass(atom: Particles): AtomMass {
  const correction = -atomCharge(atom) * ELECTRON_MASS_U;
  if (atom.neutrons === null) {
    return { mass: getElement(atom.protons).atomicWeight + correction, basis: 'standard-atomic-weight' };
  }
  const evaluated = isotopeMass(atom.protons, atom.neutrons);
  if (evaluated !== null) return { mass: evaluated + correction, basis: 'isotope-mass' };
  return { mass: atom.protons + atom.neutrons + correction, basis: 'mass-number-estimate' };
}

export type AtomNoteCode =
  | 'hypothetical-nuclide'
  | 'radioactive'
  | 'short-lived'
  | 'no-natural-isotope'
  | 'superheavy'
  | 'bare-nucleus'
  | 'unusual-charge'
  | 'unbound-anion';

export interface AtomNote {
  readonly severity: 'info' | 'warning';
  readonly code: AtomNoteCode;
  readonly message: string;
  readonly evidence: EvidenceLevel;
}

export interface AtomDescription {
  readonly symbol: string;
  readonly name: string;
  readonly protons: number;
  readonly neutrons: number | null;
  readonly electrons: number;
  readonly massNumber: number | null;
  readonly charge: number;
  readonly label: string;
  readonly kind: 'neutral atom' | 'cation' | 'anion';
  /** Evaluated data for the specified nuclide; undefined when no isotope is specified or it is not in the evaluation. */
  readonly isotope: IsotopeInfo | undefined;
  /** The isotope that best represents the element (most abundant, else longest-lived). */
  readonly representative: IsotopeInfo | undefined;
  readonly mass: AtomMass;
  readonly notes: readonly AtomNote[];
}

export interface DescribeAtomContext {
  /** Whether the atom has any bonds; isolated-ion caveats only apply to unbonded atoms. */
  readonly bonded?: boolean;
}

/** Everything the inspector needs to say about one atom, including honest caveats. */
export function describeAtom(atom: Particles, context: DescribeAtomContext = {}): AtomDescription {
  const element = getElement(atom.protons);
  const charge = atomCharge(atom);
  const isotope = atom.neutrons === null ? undefined : findIsotope(atom.protons, atom.neutrons);
  const representative = representativeIsotope(atom.protons);
  const label = atomLabel(atom);
  const notes: AtomNote[] = [];

  if (atom.neutrons !== null) {
    if (!isotope) {
      notes.push({
        severity: 'warning',
        code: 'hypothetical-nuclide',
        message: `No nuclide with ${atom.protons} protons and ${atom.neutrons} neutrons appears in the evaluated nuclear data. It is treated as hypothetical and its mass is only estimated from the mass number.`,
        evidence: 'reference',
      });
    } else if (isotope.stability !== 'S') {
      const fleeting = isotope.halfLifeSeconds !== null && isotope.halfLifeSeconds < 1;
      notes.push({
        severity: fleeting ? 'warning' : 'info',
        code: fleeting ? 'short-lived' : 'radioactive',
        message: `${atomLabel({ ...atom, electrons: atom.protons })} is radioactive. ${describeStability(isotope)}.`,
        evidence: 'reference',
      });
    }
  } else if (naturalIsotopes(atom.protons).length === 0) {
    notes.push({
      severity: 'info',
      code: 'no-natural-isotope',
      message: `${element.name} has no stable or naturally abundant isotope. The atomic weight shown is the mass of a long-lived isotope; choose a specific isotope for a definite mass.`,
      evidence: 'reference',
    });
  }

  if (atom.protons >= 104) {
    notes.push({
      severity: 'info',
      code: 'superheavy',
      message: `${element.name} is a synthetic superheavy element that has only been made a few atoms at a time. Most of its listed properties are predictions, not measurements.`,
      evidence: 'reference',
    });
  }

  if (atom.electrons === 0) {
    notes.push({
      severity: 'info',
      code: 'bare-nucleus',
      message: 'With no electrons this is a bare nucleus (fully ionised).',
      evidence: 'rule-based',
    });
  } else if (charge !== 0 && element.oxidationStates.length > 0) {
    const max = Math.max(...element.oxidationStates, 0);
    const min = Math.min(...element.oxidationStates, 0);
    if (charge > max || charge < min) {
      const listed = element.oxidationStates.map((s) => (s > 0 ? `+${s}` : `${s}`)).join(', ');
      notes.push({
        severity: 'warning',
        code: 'unusual-charge',
        message: `A charge of ${charge > 0 ? '+' : '−'}${Math.abs(charge)} lies outside the oxidation states listed for ${element.name} (${listed}).`,
        evidence: 'reference',
      });
    }
  }

  if (charge <= -2 && context.bonded === false) {
    notes.push({
      severity: 'info',
      code: 'unbound-anion',
      message:
        'An isolated atomic anion with a charge of −2 or beyond cannot hold its extra electrons in the gas phase. Such ions exist only when stabilised by a crystal lattice or solvent.',
      evidence: 'rule-based',
    });
  }

  return {
    symbol: element.symbol,
    name: element.name,
    protons: atom.protons,
    neutrons: atom.neutrons,
    electrons: atom.electrons,
    massNumber: atomMassNumber(atom),
    charge,
    label,
    kind: charge === 0 ? 'neutral atom' : charge > 0 ? 'cation' : 'anion',
    isotope,
    representative,
    mass: atomMass(atom),
    notes,
  };
}
