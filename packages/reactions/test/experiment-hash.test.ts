/**
 * The hash of an experiment: SHA-256 written in TypeScript (so that it runs synchronously in a browser),
 * the UTF-8 encoder under it, and the canonical JSON text that is hashed.
 *
 * The hash is checked three ways: against the standard test vectors, against Node's own implementation on
 * the same messages (which would expose a mistyped vector as well as a wrong hash), and against Node on
 * every message length around the block boundaries, where padding mistakes live.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, runExperiment, sha256Hex } from '../src';
import type { ExperimentInput } from '../src';
import { fromSerializable, toSerializable } from '../src/experiment/canonical';
import { sha256Bytes, utf8Bytes } from '../src/experiment/sha256';

const node = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** The message of the 448-bit test vector of FIPS 180: 56 characters. */
const MESSAGE_448_BITS = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';

describe('sha256Hex', () => {
  it('reproduces the standard test vectors for "", "abc" and the 448-bit message', () => {
    expect(MESSAGE_448_BITS.length * 8).toBe(448);
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(MESSAGE_448_BITS)).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('gives what Node gives for the same three messages, so the vectors above are not just remembered', () => {
    for (const message of ['', 'abc', MESSAGE_448_BITS]) expect(sha256Hex(message), message).toBe(node(message));
  });

  it('agrees with Node for every message length from 0 to 200 bytes, across three block boundaries', () => {
    const bytes = Uint8Array.from({ length: 200 }, (_unused, index) => (index * 37 + 11) % 256);
    for (let length = 0; length <= 200; length++) {
      const message = bytes.subarray(0, length);
      expect(sha256Hex(message), `length ${length}`).toBe(node(message));
    }
  });

  it('agrees with Node on a message of a million bytes', () => {
    const message = new Uint8Array(1_000_000).fill(0x61);
    const digest = sha256Hex(message);
    expect(digest).toBe(node(message));
    // The "one million a" vector of the standard.
    expect(digest).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('returns 32 bytes, and the hex form is those bytes', () => {
    const digest = sha256Bytes(utf8Bytes('abc'));
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest.length).toBe(32);
    expect(Buffer.from(digest).toString('hex')).toBe(sha256Hex('abc'));
  });

  it('hashes text as its UTF-8 encoding', () => {
    for (const text of ['\u0394G = \u0394H \u2212 T\u0394S', 'SO\u2084\u00b2\u207b', 'caf\u00e9', '\ud83e\uddea lab', 'a\u0000b']) {
      expect(sha256Hex(text), text).toBe(node(Buffer.from(text, 'utf8')));
    }
  });
});

describe('utf8Bytes', () => {
  it('encodes one-, two-, three- and four-byte characters as Node does', () => {
    for (const text of ['', 'plain ASCII', '\u00e9\u00fc\u00df', '\u0394\u03a3\u03bd', '\u2192\u2212\u00b1\u2248', '\ud83e\uddea\ud83d\udd2c', 'mixed: H\u2082O \u2192 \ud83d\udca7']) {
      expect(Array.from(utf8Bytes(text)), text).toEqual(Array.from(Buffer.from(text, 'utf8')));
    }
  });

  it('encodes every code point at the edges of the encoding lengths', () => {
    for (const codePoint of [0x00, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x10000, 0x10ffff]) {
      const text = String.fromCodePoint(codePoint);
      expect(Array.from(utf8Bytes(text)), codePoint.toString(16)).toEqual(Array.from(Buffer.from(text, 'utf8')));
    }
  });

  it('replaces an unpaired surrogate by U+FFFD, as the platform encoders do', () => {
    const replacement = [0xef, 0xbf, 0xbd];
    expect(Array.from(utf8Bytes('\ud83e'))).toEqual(replacement);
    expect(Array.from(utf8Bytes('\uddea'))).toEqual(replacement);
    expect(Array.from(utf8Bytes('a\ud83eb'))).toEqual([0x61, ...replacement, 0x62]);
    expect(Array.from(utf8Bytes('a\ud83eb'))).toEqual(Array.from(new TextEncoder().encode('a\ud83eb')));
  });
});

describe('canonicalJson', () => {
  it('does not depend on the order in which the keys of an object were written', () => {
    const a = { b: 1, a: { d: [1, 2, { z: 1, y: 2 }], c: 'x' } };
    const b = { a: { c: 'x', d: [1, 2, { y: 2, z: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[1,2,{"y":2,"z":1}]},"b":1}');
  });

  it('keeps the order of array elements, which is part of the content', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('is valid JSON that reads back to the same value', () => {
    const value = { text: 'quote " and \\ and \n', n: [0.1, 1e21, 1e-7, -3], flag: true, nothing: null };
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
  });

  it('leaves out properties that are undefined, as if they had not been written', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('writes the numbers JSON cannot hold in a tagged form, and negative zero as zero', () => {
    expect(canonicalJson(Number.NaN)).toBe('{"$number":"NaN"}');
    expect(canonicalJson(Infinity)).toBe('{"$number":"Infinity"}');
    expect(canonicalJson(-Infinity)).toBe('{"$number":"-Infinity"}');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson({ t: Number.NaN })).not.toBe(canonicalJson({ t: null }));
  });

  it('writes a typed array as an array of numbers', () => {
    expect(canonicalJson(Float64Array.of(1, 2.5))).toBe('[1,2.5]');
  });

  it('refuses what has no JSON form', () => {
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
    expect(() => canonicalJson(10n)).toThrow(TypeError);
  });
});

describe('toSerializable and fromSerializable', () => {
  it('carry NaN, the infinities and negative zero through JSON', () => {
    const value = { a: Number.NaN, b: [Infinity, -Infinity, -0, 0, 1.5], c: { d: 'text', e: null, f: true } };
    const back = fromSerializable(JSON.parse(JSON.stringify(toSerializable(value)))) as typeof value;
    expect(back).toStrictEqual(value);
    expect(Object.is(back.b[2], -0)).toBe(true);
    expect(Object.is(back.b[3], 0)).toBe(true);
  });

  it('turn a typed array into a plain array', () => {
    expect(toSerializable({ t: Float64Array.of(1, Number.NaN) })).toEqual({ t: [1, { $number: 'NaN' }] });
  });

  it('refuse an object that uses the reserved name, and an unknown tag', () => {
    expect(() => toSerializable({ $number: 'NaN' })).toThrow(/reserved/);
    expect(() => fromSerializable({ $number: 'seven' })).toThrow(/Unknown number tag/);
    expect(() => fromSerializable({ $number: 'toString' })).toThrow(/Unknown number tag/);
  });

  it('does not let a "__proto__" key in JSON change a prototype', () => {
    const back = fromSerializable(JSON.parse('{"__proto__":{"polluted":true},"a":1}')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
    expect((back as { polluted?: boolean }).polluted).toBeUndefined();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe('inputHash of an experiment', () => {
  const input: ExperimentInput = {
    title: 'Formation of water',
    species: [
      { formula: 'H2', phase: 'g', role: 'reactant' },
      { formula: 'O2', phase: 'g', role: 'reactant' },
      { formula: 'H2O', phase: 'l', role: 'product', name: 'water' },
    ],
    conditions: { temperatureK: 298.15, pressureBar: 1, durationSeconds: 60, environment: 'unspecified', concentrationUnit: 'mol/L' },
    method: 'auto',
  };

  it('is the SHA-256 of the canonical JSON of the normalised input', () => {
    const result = runExperiment(input);
    expect(result.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.inputHash).toBe(node(canonicalJson(result.input)));
    expect(result.input).toEqual(input);
  });

  it('does not depend on the order of the keys in the object the caller passes', () => {
    const shuffled = {
      method: 'auto',
      conditions: { concentrationUnit: 'mol/L', environment: 'unspecified', durationSeconds: 60, pressureBar: 1, temperatureK: 298.15 },
      species: [
        { role: 'reactant', phase: 'g', formula: 'H2' },
        { phase: 'g', formula: 'O2', role: 'reactant' },
        { name: 'water', role: 'product', formula: 'H2O', phase: 'l' },
      ],
      title: 'Formation of water',
    } as ExperimentInput;
    expect(runExperiment(shuffled).inputHash).toBe(runExperiment(input).inputHash);
    expect(runExperiment(shuffled)).toStrictEqual(runExperiment(input));
  });

  it('ignores properties that are not part of an experiment, and typographic variants of a formula', () => {
    const decorated = { ...input, comment: 'not part of the input', species: input.species.map((s) => ({ ...s, colour: 'red' })) } as unknown as ExperimentInput;
    expect(runExperiment(decorated).inputHash).toBe(runExperiment(input).inputHash);
    const typographic = { ...input, title: '  Formation of water ', species: [input.species[0]!, input.species[1]!, { ...input.species[2]!, formula: ' H\u2082O ' }] };
    expect(runExperiment(typographic).input).toEqual(input);
    expect(runExperiment(typographic).inputHash).toBe(runExperiment(input).inputHash);
  });

  it('changes when anything that is part of the experiment changes', () => {
    const hash = runExperiment(input).inputHash;
    const variants: ExperimentInput[] = [
      { ...input, method: 'thermodynamics' },
      { ...input, title: 'Another title' },
      { ...input, conditions: { ...input.conditions, temperatureK: 298.16 } },
      { ...input, conditions: { ...input.conditions, environment: 'gas-phase' } },
      { ...input, species: [input.species[1]!, input.species[0]!, input.species[2]!] },
      { ...input, species: [input.species[0]!, input.species[1]!, { ...input.species[2]!, phase: 'g' }] },
      { ...input, solver: { tolerance: 1e-6 } },
    ];
    const hashes = variants.map((variant) => runExperiment(variant).inputHash);
    for (const other of hashes) expect(other).not.toBe(hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});
