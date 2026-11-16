import { ELEMENT_RECORDS } from './elements.generated';
import type { ElementCategory, ElementInfo } from './types';

export { ELEMENT_DATA_SOURCES, FALLBACK_ELEMENT_COLOR } from './elements.generated';
export type { ElementBlock, ElementCategory, ElementDataSource, ElementInfo } from './types';

export const MAX_ATOMIC_NUMBER = 118;

/** All 118 elements ordered by atomic number; `ELEMENTS[z - 1]` is element `z`. */
export const ELEMENTS: readonly ElementInfo[] = ELEMENT_RECORDS;

const BY_SYMBOL = new Map(ELEMENTS.map((e) => [e.symbol.toLowerCase(), e]));

export function isAtomicNumber(z: number): boolean {
  return Number.isInteger(z) && z >= 1 && z <= MAX_ATOMIC_NUMBER;
}

export function findElement(z: number): ElementInfo | undefined {
  return isAtomicNumber(z) ? ELEMENTS[z - 1] : undefined;
}

export function getElement(z: number): ElementInfo {
  const element = findElement(z);
  if (!element) throw new RangeError(`There is no element with atomic number ${z}.`);
  return element;
}

/** Case-insensitive lookup by chemical symbol, e.g. "cl" or "Cl". */
export function elementBySymbol(symbol: string): ElementInfo | undefined {
  return BY_SYMBOL.get(symbol.trim().toLowerCase());
}

export const ELEMENT_CATEGORY_LABELS: Readonly<Record<ElementCategory, string>> = {
  nonmetal: 'Nonmetal',
  'noble-gas': 'Noble gas',
  'alkali-metal': 'Alkali metal',
  'alkaline-earth-metal': 'Alkaline earth metal',
  metalloid: 'Metalloid',
  halogen: 'Halogen',
  'post-transition-metal': 'Post-transition metal',
  'transition-metal': 'Transition metal',
  lanthanide: 'Lanthanide',
  actinide: 'Actinide',
};
