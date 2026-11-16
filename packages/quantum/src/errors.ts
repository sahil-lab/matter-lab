/** Thrown by `runRhf` (and the field evaluators) for systems the engine cannot treat. */
export class UnsupportedSystemError extends Error {
  /** The same human-readable reasons `checkSupport` reports. */
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`The quantum engine cannot compute this system: ${reasons.join(' ')}`);
    this.name = 'UnsupportedSystemError';
    this.reasons = [...reasons];
  }
}
