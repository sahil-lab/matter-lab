export function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeJson);
    Object.freeze(value);
  }
  return value;
}

export function copyJson<T>(value: T): T {
  return freezeJson(JSON.parse(JSON.stringify(value)) as T);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sameNumber(left: number, right: number, absoluteTolerance = 1e-10): boolean {
  return Number.isFinite(left) && Number.isFinite(right) &&
    Math.abs(left - right) <= absoluteTolerance + 1e-10 * Math.max(Math.abs(left), Math.abs(right));
}
