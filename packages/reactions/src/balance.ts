import { asEquation, checkConservation, formatEquation } from './equation';
import type { ReactionEquation, SpeciesTerm } from './equation';
import { hillFormula } from './formula';
import { ONE, ZERO, add, compare, divide, fraction, isZero, multiply, negate, signOf, subtract, toSmallestIntegers } from './rational';
import type { Fraction } from './rational';

export interface BalanceResult {
  /**
   * - `balanced`: coefficients were found; they are the smallest positive whole numbers.
   * - `already-balanced`: the equation conserves every element and the charge as written; it is returned unchanged.
   * - `impossible`: no set of positive coefficients conserves every element and the charge.
   * - `underdetermined`: more than one independent set of coefficients does, so conservation alone cannot
   *   decide between them (typically two reactions written as one).
   */
  readonly status: 'balanced' | 'already-balanced' | 'impossible' | 'underdetermined';
  /** Present for `balanced` and `already-balanced`. */
  readonly equation?: ReactionEquation;
  /** Plain-language explanation of the outcome. */
  readonly message: string;
  /** Number of independent solutions of the conservation equations (the dimension of their null space). */
  readonly independentSolutions: number;
}

/**
 * Null space of a rational matrix by Gauss-Jordan elimination. Returns one basis vector per free column;
 * every entry is exact.
 */
function nullSpace(matrix: readonly (readonly Fraction[])[], columns: number): Fraction[][] {
  const m = matrix.map((row) => [...row]);
  const pivotColumn: number[] = [];
  let row = 0;
  for (let col = 0; col < columns && row < m.length; col++) {
    let pivot = row;
    while (pivot < m.length && isZero(m[pivot]![col]!)) pivot++;
    if (pivot === m.length) continue;
    [m[row], m[pivot]] = [m[pivot]!, m[row]!];
    const lead = m[row]![col]!;
    m[row] = m[row]!.map((v) => divide(v, lead));
    for (let r = 0; r < m.length; r++) {
      if (r === row) continue;
      const factor = m[r]![col]!;
      if (isZero(factor)) continue;
      m[r] = m[r]!.map((v, c) => subtract(v, multiply(factor, m[row]![c]!)));
    }
    pivotColumn.push(col);
    row++;
  }
  const free: number[] = [];
  for (let col = 0; col < columns; col++) if (!pivotColumn.includes(col)) free.push(col);
  return free.map((freeCol) => {
    const vector: Fraction[] = Array.from({ length: columns }, () => ZERO);
    vector[freeCol] = ONE;
    pivotColumn.forEach((col, r) => {
      vector[col] = negate(m[r]![freeCol]!);
    });
    return vector;
  });
}

/**
 * Decides exactly whether the homogeneous system A x = 0 has a solution with every x_i > 0.
 *
 * Because the system is homogeneous this is the same as asking for x_i >= 1. Writing x = 1 + y turns it
 * into A y = -A·1 with y >= 0, whose feasibility is settled by phase one of the simplex method. All
 * arithmetic is rational and Bland's rule is used for pivoting, so the answer is exact and the method
 * cannot cycle.
 */
function hasStrictlyPositiveSolution(matrix: readonly (readonly Fraction[])[], columns: number): boolean {
  const rows = matrix.length;
  // Tableau columns: y_0..y_{n-1}, artificial a_0..a_{m-1}, right-hand side.
  const tableau: Fraction[][] = matrix.map((source, r) => {
    let rhs = ZERO;
    for (const v of source) rhs = subtract(rhs, v);
    const flip = signOf(rhs) < 0;
    const line = source.map((v) => (flip ? negate(v) : v));
    for (let a = 0; a < rows; a++) line.push(a === r ? ONE : ZERO);
    line.push(flip ? negate(rhs) : rhs);
    return line;
  });
  const total = columns + rows;
  const basis = Array.from({ length: rows }, (_, r) => columns + r);
  const isArtificial = (col: number): boolean => col >= columns;

  for (let guard = 0; guard < 10000; guard++) {
    // Reduced cost of column j for the objective "sum of artificials": c_j - sum over basic artificial rows.
    let entering = -1;
    for (let col = 0; col < total && entering < 0; col++) {
      if (basis.includes(col)) continue;
      let reduced = isArtificial(col) ? ONE : ZERO;
      for (let r = 0; r < rows; r++) if (isArtificial(basis[r]!)) reduced = subtract(reduced, tableau[r]![col]!);
      if (signOf(reduced) < 0) entering = col;
    }
    if (entering < 0) break;
    let leaving = -1;
    let best: Fraction | undefined;
    for (let r = 0; r < rows; r++) {
      const coefficient = tableau[r]![entering]!;
      if (signOf(coefficient) <= 0) continue;
      const ratio = divide(tableau[r]![total]!, coefficient);
      const order = best === undefined ? -1 : compare(ratio, best);
      if (order < 0 || (order === 0 && basis[r]! < basis[leaving]!)) {
        best = ratio;
        leaving = r;
      }
    }
    if (leaving < 0) break; // cannot happen: the phase-one objective is bounded below by zero
    const pivot = tableau[leaving]![entering]!;
    tableau[leaving] = tableau[leaving]!.map((v) => divide(v, pivot));
    for (let r = 0; r < rows; r++) {
      if (r === leaving) continue;
      const factor = tableau[r]![entering]!;
      if (isZero(factor)) continue;
      tableau[r] = tableau[r]!.map((v, c) => subtract(v, multiply(factor, tableau[leaving]![c]!)));
    }
    basis[leaving] = entering;
  }
  // Feasible exactly when every artificial variable left in the basis is zero.
  let infeasibility = ZERO;
  for (let r = 0; r < rows; r++) if (isArtificial(basis[r]!)) infeasibility = add(infeasibility, tableau[r]![total]!);
  return isZero(infeasibility);
}

const termKey = (term: SpeciesTerm): string => `${hillFormula(term.parsed)}|${term.phase ?? ''}`;
const label = (term: SpeciesTerm): string => `${term.formula}${term.phase ? `(${term.phase})` : ''}`;

function repeatedSpecies(eq: ReactionEquation): string[] {
  const notes: string[] = [];
  const left = new Map<string, number>();
  const right = new Map<string, number>();
  for (const t of eq.reactants) left.set(termKey(t), (left.get(termKey(t)) ?? 0) + 1);
  for (const t of eq.products) right.set(termKey(t), (right.get(termKey(t)) ?? 0) + 1);
  const seen = new Set<string>();
  for (const t of [...eq.reactants, ...eq.products]) {
    const key = termKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    if (left.has(key) && right.has(key)) notes.push(`${label(t)} appears on both sides (a catalyst or spectator); leave it out to balance the net reaction`);
    else if ((left.get(key) ?? 0) > 1 || (right.get(key) ?? 0) > 1) notes.push(`${label(t)} is written more than once on the same side; combine the terms`);
  }
  return notes;
}

function withCoefficients(eq: ReactionEquation, coefficients: readonly number[]): ReactionEquation {
  const n = eq.reactants.length;
  return {
    reactants: eq.reactants.map((t, i) => ({ ...t, coefficient: coefficients[i]! })),
    products: eq.products.map((t, i) => ({ ...t, coefficient: coefficients[n + i]! })),
    reversible: eq.reversible,
  };
}

/**
 * Balances a reaction equation by conservation of every element and of charge.
 *
 * The coefficients are the null space of the composition matrix (one row per element plus one for the
 * charge, one column per species), computed in exact rational arithmetic and scaled to the smallest
 * positive whole numbers. Coefficients already present in the input are ignored unless the equation is
 * balanced as written, in which case it is returned unchanged with status `already-balanced`.
 *
 * Balancing is bookkeeping only: a balanced equation is not evidence that the reaction occurs.
 *
 * @throws ChemicalSyntaxError when a string input cannot be parsed.
 */
export function balanceEquation(input: ReactionEquation | string): BalanceResult {
  const eq = asEquation(input);
  const terms = [...eq.reactants, ...eq.products];
  const n = terms.length;

  const symbols: string[] = [];
  for (const t of terms) for (const s of Object.keys(t.parsed.elements)) if (!symbols.includes(s)) symbols.push(s);
  const matrix: Fraction[][] = symbols.map((s) =>
    terms.map((t, i) => fraction((i < eq.reactants.length ? 1 : -1) * (t.parsed.elements[s] ?? 0))),
  );
  if (terms.some((t) => t.parsed.charge !== 0)) {
    matrix.push(terms.map((t, i) => fraction((i < eq.reactants.length ? 1 : -1) * t.parsed.charge)));
  }
  const basis = nullSpace(matrix, n);
  const independentSolutions = basis.length;
  const repeated = repeatedSpecies(eq);
  const notUnique =
    independentSolutions > 1
      ? ` Conservation leaves ${independentSolutions} independent solutions, so these coefficients are one valid choice among many, not the only one.`
      : '';

  if (checkConservation(eq).balanced) {
    let message = 'The equation is already balanced as written: every element and the charge are conserved.';
    if (independentSolutions === 1) {
      const smallest = toSmallestIntegers(basis[0]!).map(Number);
      const reduced = withCoefficients(eq, smallest);
      if (terms.some((t, i) => t.coefficient !== smallest[i])) message += ` In smallest whole numbers it reads ${formatEquation(reduced)}.`;
    }
    return { status: 'already-balanced', equation: eq, message: message + notUnique, independentSolutions };
  }

  if (independentSolutions === 0) {
    return {
      status: 'impossible',
      message:
        'No choice of coefficients conserves every element and the charge. Check the formulas, or whether a reactant or product is missing.',
      independentSolutions,
    };
  }

  if (independentSolutions === 1) {
    const vector = basis[0]!;
    const zero = terms.filter((_, i) => isZero(vector[i]!));
    if (zero.length > 0) {
      return {
        status: 'impossible',
        message: `The only way to conserve every element and the charge gives ${zero.map(label).join(', ')} a coefficient of zero, so ${
          zero.length === 1 ? 'it cannot' : 'they cannot'
        } take part in this reaction as written.`,
        independentSolutions,
      };
    }
    const signs = new Set(vector.map(signOf));
    if (signs.size > 1) {
      const majority = vector.filter((v) => signOf(v) > 0).length >= vector.length / 2 ? 1 : -1;
      const misplaced = terms.filter((_, i) => signOf(vector[i]!) !== majority);
      return {
        status: 'impossible',
        message: `Conservation can only be satisfied with a negative coefficient for ${misplaced.map(label).join(', ')}, that is, by moving ${
          misplaced.length === 1 ? 'it' : 'them'
        } to the other side of the arrow. No positive coefficients balance the equation as written.`,
        independentSolutions,
      };
    }
    const coefficients = toSmallestIntegers(vector).map(Number);
    if (coefficients.some((c) => !Number.isSafeInteger(c))) {
      return { status: 'impossible', message: 'The balanced coefficients are too large to represent.', independentSolutions };
    }
    const balanced = withCoefficients(eq, coefficients);
    return { status: 'balanced', equation: balanced, message: `Balanced with the smallest whole-number coefficients: ${formatEquation(balanced)}.`, independentSolutions };
  }

  if (!hasStrictlyPositiveSolution(matrix, n)) {
    return {
      status: 'impossible',
      message: 'Conservation of the elements and the charge has solutions, but none in which every species has a positive coefficient, so the equation cannot be balanced as written.',
      independentSolutions,
    };
  }
  return {
    status: 'underdetermined',
    message:
      `Conservation of the elements and the charge leaves ${independentSolutions} independent solutions, so the coefficients are not fixed and no single balanced equation exists. ` +
      (repeated.length
        ? `${repeated.join('; ')}.`
        : 'This usually means that two or more reactions were written as one. Write them as separate equations, or fix the ratio between two of the species.'),
    independentSolutions,
  };
}
