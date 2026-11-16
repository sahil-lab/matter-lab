/** One reason why the Universal Force Field (as implemented in RDKit) cannot handle a molecule. */
export interface ForceFieldProblem {
  /** Index into `FfMolecule.atoms`. */
  readonly atomIndex: number;
  readonly reason: string;
}

/**
 * Thrown when UFF cannot be applied to a molecule: an atom has no UFF type, or RDKit's own valence
 * model would refuse the molecule before typing it. Every offending atom is listed in `problems`;
 * nothing is ever typed by guesswork.
 */
export class UnsupportedForceFieldError extends Error {
  readonly problems: readonly { atomIndex: number; reason: string }[];

  constructor(problems: readonly ForceFieldProblem[], message?: string) {
    super(message ?? UnsupportedForceFieldError.describe(problems));
    this.name = 'UnsupportedForceFieldError';
    this.problems = problems.map((p) => ({ atomIndex: p.atomIndex, reason: p.reason }));
    // Keep `instanceof` working when the class is transpiled to ES5-style constructors.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  private static describe(problems: readonly ForceFieldProblem[]): string {
    const shown = problems.slice(0, 8).map((p) => `atom ${p.atomIndex}: ${p.reason}`);
    const more = problems.length > shown.length ? ` (and ${problems.length - shown.length} more)` : '';
    const noun = problems.length === 1 ? 'atom' : 'atoms';
    return `The Universal Force Field cannot be applied: ${problems.length} ${noun} unsupported. ${shown.join('; ')}${more}`;
  }
}
