import { LAB_LIMITS } from './common.ts';
import type { JsonValue, LabErrorCode, ValidationIssue } from './common.ts';
import { LAB_JSON_SCHEMA } from './json-schema.ts';
import type { JsonSchema } from './json-schema.ts';

export const pointer = (path: string, key: string | number): string =>
  `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

export function issue(errors: ValidationIssue[], path: string, message: string, code: LabErrorCode = 'INVALID_INPUT'): void {
  if (errors.length < LAB_LIMITS.maxValidationIssues) errors.push({ code, path, message });
}

/** Reject values JSON would silently change, invoke, omit or fail to encode before validating shape. */
export function inspectJson(input: unknown, errors: ValidationIssue[]): void {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  function visit(value: unknown, path: string, depth: number): void {
    if (errors.length >= LAB_LIMITS.maxValidationIssues) return;
    if (++nodes > LAB_LIMITS.maxJsonNodes || depth > LAB_LIMITS.maxJsonDepth) {
      issue(errors, path, 'JSON nesting or node limit exceeded.', 'LIMIT_EXCEEDED');
      return;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) issue(errors, path, 'Numbers must be finite.', 'NON_FINITE_NUMBER');
      return;
    }
    if (typeof value === 'string') {
      if (value.length > LAB_LIMITS.maxStringLength) issue(errors, path, 'String limit exceeded.', 'LIMIT_EXCEEDED');
      if (/[\uD800-\uDFFF]/u.test(value)) issue(errors, path, 'Unpaired Unicode surrogates are not valid canonical JSON.');
      return;
    }
    if (value === null || typeof value === 'boolean') return;
    if (typeof value !== 'object') {
      issue(errors, path, 'Expected a JSON value; undefined, functions, symbols and bigint are forbidden.');
      return;
    }
    if (ancestors.has(value)) {
      issue(errors, path, 'Cyclic data cannot be serialized.', 'SERIALIZATION_FAILED');
      return;
    }
    const isArray = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if ((isArray && prototype !== Array.prototype) ||
        (!isArray && prototype !== Object.prototype && prototype !== null)) {
      issue(errors, path, 'Only plain JSON objects and arrays are accepted.');
      return;
    }
    if (isArray && value.length > LAB_LIMITS.maxEvents) {
      issue(errors, path, 'Array limit exceeded.', 'LIMIT_EXCEEDED');
      return;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (!isArray && ownKeys.length > LAB_LIMITS.maxObjectProperties) {
      issue(errors, path, 'Object property limit exceeded.', 'LIMIT_EXCEEDED');
      return;
    }
    ancestors.add(value);
    for (const key of ownKeys) {
      if (isArray && key === 'length') continue;
      if (typeof key !== 'string') {
        issue(errors, path, 'Symbol properties are not JSON.');
        continue;
      }
      const at = pointer(path, key);
      if (['__proto__', 'constructor', 'prototype'].includes(key)) {
        issue(errors, at, 'Reserved object keys are not accepted.');
        continue;
      }
      if (key.length > 256 || /[\uD800-\uDFFF]/u.test(key)) {
        issue(errors, at, 'Object keys must be bounded Unicode scalar strings.');
      }
      if (isArray && !/^(0|[1-9][0-9]*)$/.test(key)) {
        issue(errors, at, 'Array properties would be lost during serialization.');
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        issue(errors, at, 'Accessors and non-enumerable properties are not accepted.');
        continue;
      }
      visit(descriptor.value, at, depth + 1);
      if (nodes > LAB_LIMITS.maxJsonNodes) break;
    }
    if (isArray && ownKeys.length !== value.length + 1) issue(errors, path, 'Sparse arrays are not accepted.');
    ancestors.delete(value);
  }
  visit(input, '', 0);
  if (errors.length === 0) {
    const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
    if (bytes > LAB_LIMITS.maxJsonBytes) issue(errors, '', 'Serialized JSON byte limit exceeded.', 'LIMIT_EXCEEDED');
  }
}

export type SemanticValidator = (name: string, value: unknown, path: string, errors: ValidationIssue[]) => void;

export function checkSchema(
  schema: JsonSchema,
  input: unknown,
  path: string,
  errors: ValidationIssue[],
  refine?: SemanticValidator,
): void {
  if (errors.length >= LAB_LIMITS.maxValidationIssues) return;
  if (schema.$ref) {
    const name = schema.$ref.slice('#/$defs/'.length);
    const target = LAB_JSON_SCHEMA.$defs[name];
    if (!target || !schema.$ref.startsWith('#/$defs/')) throw new Error(`Unknown local schema reference: ${schema.$ref}`);
    const before = errors.length;
    checkSchema(target, input, path, errors, refine);
    if (before === errors.length) refine?.(name, input, path, errors);
    return;
  }
  const variants = schema.oneOf ?? schema.anyOf;
  if (variants) {
    const candidates = typeof input === 'object' && input !== null && !Array.isArray(input)
      ? variants.filter((variant) => Object.entries(variant.properties ?? {}).every(([key, property]) =>
        property.const === undefined || !Object.hasOwn(input, key) ||
        (input as Record<string, unknown>)[key] === property.const))
      : variants;
    let successes = 0;
    let best: ValidationIssue[] | undefined;
    for (const variant of candidates.length > 0 ? candidates : variants) {
      const variantErrors: ValidationIssue[] = [];
      checkSchema(variant, input, path, variantErrors, refine);
      if (variantErrors.length === 0) {
        successes++;
        if (schema.anyOf) return;
      } else if (!best || variantErrors.length < best.length) best = variantErrors;
    }
    if (successes === 1) return;
    if (successes > 1) issue(errors, path, 'Input matches more than one contract variant.');
    else if (best) best.forEach((error) => issue(errors, error.path, error.message, error.code));
    else issue(errors, path, 'Input does not match a supported contract variant.');
    return;
  }
  if ('const' in schema && input !== schema.const) {
    issue(errors, path, `Expected ${JSON.stringify(schema.const)}.`,
      path.endsWith('/schemaVersion') ? 'UNSUPPORTED_SCHEMA_VERSION' : path.endsWith('/unit') ? 'INVALID_UNIT' : 'INVALID_INPUT');
  }
  if (schema.enum && !schema.enum.some((value) => value === input)) issue(errors, path, 'Value is not in the declared enum.');
  if (schema.type === undefined) return;
  if (schema.type === 'object') {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      issue(errors, path, 'Expected an object.');
      return;
    }
    const value = input as Record<string, unknown>;
    const entries = Object.entries(value);
    if (schema.maxProperties !== undefined && entries.length > schema.maxProperties) issue(errors, path, 'Too many properties.', 'LIMIT_EXCEEDED');
    if (schema.minProperties !== undefined && entries.length < schema.minProperties) issue(errors, path, 'Too few properties.');
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) issue(errors, pointer(path, key), 'Required property is missing.');
    }
    for (const [key, child] of entries) {
      const at = pointer(path, key);
      if (schema.propertyNames) checkSchema(schema.propertyNames, key, at, errors, refine);
      const property = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties?.[key] : undefined;
      if (property) checkSchema(property, child, at, errors, refine);
      else if (schema.additionalProperties === false) issue(errors, at, 'Unknown property is not permitted.');
      else if (typeof schema.additionalProperties === 'object') checkSchema(schema.additionalProperties, child, at, errors, refine);
    }
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(input)) {
      issue(errors, path, 'Expected an array.');
      return;
    }
    if (schema.minItems !== undefined && input.length < schema.minItems) issue(errors, path, 'Array is too short.');
    if (schema.maxItems !== undefined && input.length > schema.maxItems) {
      issue(errors, path, 'Array limit exceeded.', 'LIMIT_EXCEEDED');
      return;
    }
    const seen = new Set<string>();
    input.forEach((value: unknown, index: number) => {
      if (schema.items) checkSchema(schema.items, value, pointer(path, index), errors, refine);
      if (schema.uniqueItems) {
        const key = JSON.stringify(value);
        if (seen.has(key)) issue(errors, pointer(path, index), 'Duplicate entry.', 'DUPLICATE_ID');
        seen.add(key);
      }
    });
    return;
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof input !== 'number' || !Number.isFinite(input)) {
      issue(errors, path, 'Expected a finite number.', typeof input === 'number' ? 'NON_FINITE_NUMBER' : 'INVALID_INPUT');
      return;
    }
    if (schema.type === 'integer' && !Number.isSafeInteger(input)) issue(errors, path, 'Expected a safe integer.');
    if (schema.minimum !== undefined && input < schema.minimum) issue(errors, path, `Value must be >= ${schema.minimum}.`);
    if (schema.exclusiveMinimum !== undefined && input <= schema.exclusiveMinimum) issue(errors, path, `Value must be > ${schema.exclusiveMinimum}.`);
    if (schema.maximum !== undefined && input > schema.maximum) issue(errors, path, `Value must be <= ${schema.maximum}.`, 'LIMIT_EXCEEDED');
    return;
  }
  if (schema.type === 'string') {
    if (typeof input !== 'string') {
      issue(errors, path, 'Expected a string.');
      return;
    }
    const length = [...input].length;
    if (schema.minLength !== undefined && length < schema.minLength) issue(errors, path, 'String is too short.');
    if (schema.maxLength !== undefined && length > schema.maxLength) issue(errors, path, 'String limit exceeded.', 'LIMIT_EXCEEDED');
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(input)) {
      issue(errors, path, 'String does not match the required format.', schema.format === 'uuid' ? 'INVALID_UUID' : 'INVALID_INPUT');
    }
    if (schema.format === 'date-time' && !Number.isFinite(Date.parse(input))) issue(errors, path, 'Invalid UTC timestamp.');
    return;
  }
  if (schema.type === 'null' ? input !== null : typeof input !== schema.type) issue(errors, path, `Expected ${schema.type}.`);
}

export function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((child: unknown) => freezeJson(child));
    Object.freeze(value);
  }
  return value;
}

/** JCS ordering is UTF-16 lexicographic; arrays retain their order and JSON.stringify writes numbers. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((child) => canonicalJson(child)).join(',')}]`;
  const objectValue = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(objectValue).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key]!)}`).join(',')}}`;
}
