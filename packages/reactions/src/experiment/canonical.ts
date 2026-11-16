/**
 * Two JSON encodings used by the experiment pipeline:
 *
 * - `canonicalJson`: keys sorted, no whitespace, so that the text (and its hash) depends on the content of
 *   a value and not on the order in which its properties were written;
 * - `toSerializable` / `fromSerializable`: a lossless detour around what JSON cannot hold. Typed arrays
 *   become plain arrays, and the numbers JSON has no notation for (NaN, the infinities, negative zero)
 *   become `{ "$number": "NaN" }` and so on, so that a value read back is equal to the value written.
 */

const NUMBER_TAG = '$number';
const SPECIAL_NUMBERS: Readonly<Record<string, number>> = { NaN: Number.NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 };

function specialNumber(value: number): string | undefined {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (Object.is(value, -0)) return '-0';
  return undefined;
}

const isTypedArray = (value: unknown): value is ArrayLike<number> & ArrayBufferView => ArrayBuffer.isView(value) && !(value instanceof DataView);

function unsupported(value: unknown): never {
  throw new TypeError(`A value of type ${typeof value} cannot be written as JSON.`);
}

/**
 * JSON text of a value with the keys of every object in sorted order and no whitespace. Properties whose
 * value is `undefined` are left out; typed arrays are written as arrays; NaN and the infinities are written
 * as `{"$number":"NaN"}` and so on; negative zero is written as 0.
 *
 * Two values that differ only in the order of their object keys give the same text. The order of array
 * elements is part of the content and is kept.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number': {
      const special = specialNumber(value);
      if (special === '-0') return '0';
      return special ? `{${JSON.stringify(NUMBER_TAG)}:${JSON.stringify(special)}}` : JSON.stringify(value);
    }
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
      if (isTypedArray(value)) return `[${Array.from(value, (item) => canonicalJson(item)).join(',')}]`;
      const record = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        if (record[key] !== undefined) parts.push(`${JSON.stringify(key)}:${canonicalJson(record[key])}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      return unsupported(value);
  }
}

/** A copy of a value that `JSON.stringify` writes without loss; see the notes at the top of this file. */
export function toSerializable(value: unknown): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value;
    case 'number': {
      const special = specialNumber(value);
      return special ? { [NUMBER_TAG]: special } : value;
    }
    case 'object': {
      if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : toSerializable(item)));
      if (isTypedArray(value)) return Array.from(value, (item) => toSerializable(item));
      const record = value as Record<string, unknown>;
      if (Object.hasOwn(record, NUMBER_TAG)) throw new TypeError(`An object with a "${NUMBER_TAG}" property cannot be written: the name is reserved.`);
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record)) if (record[key] !== undefined) out[key] = toSerializable(record[key]);
      return out;
    }
    default:
      return unsupported(value);
  }
}

/** The inverse of `toSerializable` for everything except typed arrays, which come back as plain arrays. */
export function fromSerializable(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(fromSerializable);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === NUMBER_TAG) {
    const tag = record[NUMBER_TAG];
    if (typeof tag !== 'string' || !Object.hasOwn(SPECIAL_NUMBERS, tag)) throw new TypeError(`Unknown number tag ${JSON.stringify(tag)}.`);
    return SPECIAL_NUMBERS[tag];
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const item = fromSerializable(record[key]);
    // A plain assignment to "__proto__" would change the prototype instead of creating a property.
    if (key === '__proto__') Object.defineProperty(out, key, { value: item, enumerable: true, writable: true, configurable: true });
    else out[key] = item;
  }
  return out;
}
