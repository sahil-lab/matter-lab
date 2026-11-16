import { getElement } from '../elements';
import type { AtomId, Scene } from '../types';
import { atomCharge, atomMass, formatChargeSuperscript, toSubscript } from './atom';

export interface FormulaPart {
  readonly z: number;
  readonly symbol: string;
  readonly count: number;
}

export interface Composition {
  /** Elements in Hill order: carbon, hydrogen, then alphabetical; purely alphabetical when there is no carbon. */
  readonly parts: readonly FormulaPart[];
  readonly atomCount: number;
  /** Net charge in units of e. */
  readonly charge: number;
  readonly electrons: number;
}

function atomsOf(scene: Scene, atomIds?: Iterable<AtomId>) {
  if (!atomIds) return [...scene.atoms.values()];
  const list = [];
  for (const id of atomIds) {
    const atom = scene.atoms.get(id);
    if (atom) list.push(atom);
  }
  return list;
}

export function composition(scene: Scene, atomIds?: Iterable<AtomId>): Composition {
  const counts = new Map<number, number>();
  let charge = 0;
  let electrons = 0;
  let atomCount = 0;
  for (const atom of atomsOf(scene, atomIds)) {
    counts.set(atom.protons, (counts.get(atom.protons) ?? 0) + 1);
    charge += atomCharge(atom);
    electrons += atom.electrons;
    atomCount++;
  }
  const hasCarbon = counts.has(6);
  const rank = (symbol: string) => (hasCarbon && symbol === 'C' ? 0 : hasCarbon && symbol === 'H' ? 1 : 2);
  const parts = [...counts.entries()]
    .map(([z, count]) => ({ z, symbol: getElement(z).symbol, count }))
    .sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol));
  return { parts, atomCount, charge, electrons };
}

/** Formats a composition as a Hill formula, e.g. "C₂H₆O" or "H₄N⁺" (`unicode`), "C2H6O" or "H4N+" (`plain`). */
export function formatFormula(c: Composition, style: 'unicode' | 'plain' = 'unicode'): string {
  if (c.parts.length === 0) return '';
  const body = c.parts
    .map((p) => `${p.symbol}${p.count === 1 ? '' : style === 'unicode' ? toSubscript(p.count) : p.count}`)
    .join('');
  if (c.charge === 0) return body;
  if (style === 'unicode') return `${body}${formatChargeSuperscript(c.charge)}`;
  const magnitude = Math.abs(c.charge);
  return `${body}${magnitude === 1 ? '' : magnitude}${c.charge > 0 ? '+' : '-'}`;
}

export function hillFormula(scene: Scene, atomIds?: Iterable<AtomId>, style: 'unicode' | 'plain' = 'unicode'): string {
  return formatFormula(composition(scene, atomIds), style);
}

export interface MassSummary {
  /** Mass in unified atomic mass units (numerically equal to g/mol). */
  readonly mass: number;
  /**
   * `standard`: every atom uses its standard atomic weight (natural isotopic composition).
   * `isotopic`: every atom is a specified isotope.
   * `mixed`: some atoms are specified isotopes and some are not.
   */
  readonly basis: 'standard' | 'isotopic' | 'mixed';
  /** True when at least one specified nuclide has no evaluated mass, so its mass number was used instead. */
  readonly estimated: boolean;
}

export function molecularMass(scene: Scene, atomIds?: Iterable<AtomId>): MassSummary {
  let mass = 0;
  let standard = 0;
  let isotopic = 0;
  let estimated = false;
  for (const atom of atomsOf(scene, atomIds)) {
    const m = atomMass(atom);
    mass += m.mass;
    if (m.basis === 'standard-atomic-weight') standard++;
    else isotopic++;
    if (m.basis === 'mass-number-estimate') estimated = true;
  }
  return { mass, basis: isotopic === 0 ? 'standard' : standard === 0 ? 'isotopic' : 'mixed', estimated };
}
