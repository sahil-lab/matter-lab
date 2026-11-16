/** S = stable, R = radioactive with an evaluated half-life, U = half-life not evaluated. */
export type IsotopeStability = 'S' | 'R' | 'U';

/** Qualifier on a half-life value: a bound (GT, LT, GE, LE) or an approximate value (AP). */
export type HalfLifeLimit = '' | 'GT' | 'LT' | 'GE' | 'LE' | 'AP';

/** Compact storage row; see `IsotopeInfo` for the meaning of each entry. */
export type IsotopeRow = readonly [
  z: number,
  n: number,
  mass: number | null,
  massFromSystematics: number,
  abundancePercent: number | null,
  halfLifeSeconds: number | null,
  stability: string,
  halfLifeLimit: string,
  decayMode: string,
  decayPercent: number | null,
  spinParity: string,
];

export interface IsotopeInfo {
  /** Proton count. */
  readonly z: number;
  /** Neutron count. */
  readonly n: number;
  /** Mass number A = Z + N. */
  readonly a: number;
  /** Atomic mass in unified atomic mass units (AME2020), or `null` when it has not been evaluated. */
  readonly mass: number | null;
  /** True when the mass was estimated from systematics rather than measured. */
  readonly massFromSystematics: boolean;
  /** Natural isotopic abundance as a mole fraction (0-1), or `null` if it does not occur naturally. */
  readonly abundance: number | null;
  readonly stability: IsotopeStability;
  /** Half-life in seconds; `null` for stable nuclides and for nuclides with no evaluated half-life. */
  readonly halfLifeSeconds: number | null;
  readonly halfLifeLimit: HalfLifeLimit;
  /** Most probable decay mode in ENSDF notation (B-, B+, EC, A, SF, IT, P, N, ...), if any. */
  readonly decayMode: string | null;
  /** Branching percentage of that decay mode, when evaluated. */
  readonly decayPercent: number | null;
  /** Ground-state spin and parity in ENSDF notation, e.g. "1/2+". */
  readonly spinParity: string | null;
}
