import { ISOTOPE_ROWS } from './isotopes.generated';
import type { HalfLifeLimit, IsotopeInfo, IsotopeStability } from './types';

export { ISOTOPE_DATA_SOURCE } from './isotopes.generated';
export type { HalfLifeLimit, IsotopeInfo, IsotopeStability } from './types';

let byElement: Map<number, IsotopeInfo[]> | undefined;

function table(): Map<number, IsotopeInfo[]> {
  if (byElement) return byElement;
  const map = new Map<number, IsotopeInfo[]>();
  for (const r of ISOTOPE_ROWS) {
    const info: IsotopeInfo = {
      z: r[0],
      n: r[1],
      a: r[0] + r[1],
      mass: r[2],
      massFromSystematics: r[3] === 1,
      abundance: r[4] === null ? null : r[4] / 100,
      halfLifeSeconds: r[5],
      stability: r[6] as IsotopeStability,
      halfLifeLimit: r[7] as HalfLifeLimit,
      decayMode: r[8] === '' ? null : r[8],
      decayPercent: r[9],
      spinParity: r[10] === '' ? null : r[10],
    };
    const list = map.get(info.z);
    if (list) list.push(info);
    else map.set(info.z, [info]);
  }
  byElement = map;
  return map;
}

/** All evaluated ground-state nuclides of element `z`, ordered by mass number. */
export function getIsotopes(z: number): readonly IsotopeInfo[] {
  return table().get(z) ?? [];
}

export function findIsotope(z: number, n: number): IsotopeInfo | undefined {
  return getIsotopes(z).find((iso) => iso.n === n);
}

/** Atomic mass of a specific nuclide in u, or `null` if the nuclide or its mass is not in the evaluation. */
export function isotopeMass(z: number, n: number): number | null {
  return findIsotope(z, n)?.mass ?? null;
}

/** Naturally occurring isotopes of element `z`, most abundant first. */
export function naturalIsotopes(z: number): readonly IsotopeInfo[] {
  return getIsotopes(z)
    .filter((iso) => iso.abundance !== null && iso.abundance > 0)
    .sort((x, y) => y.abundance! - x.abundance!);
}

/**
 * The isotope that best represents element `z`: the most abundant natural isotope, or for elements
 * that do not occur naturally the one with the longest evaluated half-life.
 */
export function representativeIsotope(z: number): IsotopeInfo | undefined {
  const natural = naturalIsotopes(z);
  if (natural.length > 0) return natural[0];
  let best: IsotopeInfo | undefined;
  for (const iso of getIsotopes(z)) {
    if (iso.stability === 'S') return iso;
    if (iso.halfLifeSeconds === null) continue;
    if (!best || iso.halfLifeSeconds > best.halfLifeSeconds!) best = iso;
  }
  return best ?? getIsotopes(z)[0];
}

const HALF_LIFE_UNITS: ReadonlyArray<readonly [string, number]> = [
  ['Gy', 3.15576e16],
  ['My', 3.15576e13],
  ['ky', 3.15576e10],
  ['y', 3.15576e7],
  ['d', 86400],
  ['h', 3600],
  ['min', 60],
  ['s', 1],
  ['ms', 1e-3],
  ['µs', 1e-6],
  ['ns', 1e-9],
  ['ps', 1e-12],
  ['fs', 1e-15],
  ['as', 1e-18],
  ['zs', 1e-21],
  ['ys', 1e-24],
];

/** Formats a half-life given in seconds with a sensible unit, e.g. `5.7 ky` or `12.3 y`. Years are Julian years. */
export function formatHalfLife(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'unknown';
  if (seconds >= 3.15576e19) return `${(seconds / 3.15576e7).toExponential(2).replace('e+', ' × 10^')} y`;
  const unit = HALF_LIFE_UNITS.find(([, size]) => seconds >= size) ?? HALF_LIFE_UNITS[HALF_LIFE_UNITS.length - 1]!;
  const value = seconds / unit[1];
  return `${Number(value.toPrecision(3))} ${unit[0]}`;
}

const LIMIT_PREFIX: Readonly<Record<HalfLifeLimit, string>> = {
  '': '',
  GT: '> ',
  GE: '≥ ',
  LT: '< ',
  LE: '≤ ',
  AP: '≈ ',
};

/** One-line stability summary, e.g. "Stable", "Half-life 5.7 ky (B-)" or "Half-life not evaluated". */
export function describeStability(iso: IsotopeInfo): string {
  if (iso.stability === 'S') return 'Stable';
  if (iso.halfLifeSeconds === null) return 'Half-life not evaluated';
  const mode = iso.decayMode ? ` (${iso.decayMode})` : '';
  return `Half-life ${LIMIT_PREFIX[iso.halfLifeLimit]}${formatHalfLife(iso.halfLifeSeconds)}${mode}`;
}
