/** Small deterministic statistics helpers used by the scoring rubric. No randomness, ever. */

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Sample standard deviation (n-1 divisor); 0 for fewer than two values. */
export function sampleStdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Relative standard deviation as a percentage; `0` when the mean is zero or there is one sample. */
export function rsdPercent(values: readonly number[]): number {
  const m = mean(values);
  if (values.length < 2 || m === 0) return 0;
  return (sampleStdDev(values) / Math.abs(m)) * 100;
}

export function linearScore(value: number, goodAt: number, zeroAt: number): number {
  if (goodAt === zeroAt) return value <= goodAt ? 1 : 0;
  const t = (zeroAt - value) / (zeroAt - goodAt);
  return clamp01(t);
}
