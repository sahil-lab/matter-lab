import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BasisLibrary, ShellDefinition } from '../../src/basis/basis';

/** Absolute path of a file under packages/quantum/test/fixtures. */
export function fixturePath(relative: string): string {
  return fileURLToPath(new URL(`../fixtures/${relative}`, import.meta.url));
}

export function readFixture(relative: string): string {
  return readFileSync(fixturePath(relative), 'utf8');
}

export function readJsonFixture<T>(relative: string): T {
  return JSON.parse(readFixture(relative)) as T;
}

function numbers(line: string): number[] {
  return line
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map(Number);
}

function dataLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

export interface CrawfordGeometry {
  /** Atomic numbers. */
  readonly z: number[];
  /** Positions in bohr, as printed in geom.dat. */
  readonly bohr: [number, number, number][];
}

/** geom.dat: atom count, then one "Z x y z" line per atom with coordinates in bohr. */
export function parseCrawfordGeometry(text: string): CrawfordGeometry {
  const lines = dataLines(text);
  const count = Number(lines[0].trim());
  const z: number[] = [];
  const bohr: [number, number, number][] = [];
  for (let i = 1; i <= count; i++) {
    const [charge, x, y, zz] = numbers(lines[i]);
    z.push(Math.round(charge));
    bohr.push([x, y, zz]);
  }
  return { z, bohr };
}

/** s.dat, t.dat, v.dat, mu?.dat: "i j value" with 1-based i >= j; returns the full symmetric matrix. */
export function parseCrawfordMatrix(text: string, n: number): Float64Array {
  const matrix = new Float64Array(n * n).fill(Number.NaN);
  for (const line of dataLines(text)) {
    const [i, j, value] = numbers(line);
    matrix[(i - 1) * n + (j - 1)] = value;
    matrix[(j - 1) * n + (i - 1)] = value;
  }
  if (matrix.some((value) => Number.isNaN(value))) throw new Error('Crawford matrix file does not list every element.');
  return matrix;
}

export interface CrawfordEri {
  readonly i: number;
  readonly j: number;
  readonly k: number;
  readonly l: number;
  readonly value: number;
}

/** eri.dat: "i j k l value" (1-based, chemists' notation (ij|kl)); returned with 0-based indices. */
export function parseCrawfordEri(text: string): CrawfordEri[] {
  return dataLines(text).map((line) => {
    const [i, j, k, l, value] = numbers(line);
    return { i: i - 1, j: j - 1, k: k - 1, l: l - 1, value };
  });
}

export interface CrawfordOutput {
  readonly electronicEnergy: number;
  readonly totalEnergy: number;
  readonly dipole: [number, number, number];
  readonly charges: number[];
}

/** Final SCF energies (last iteration line), dipole moment (a.u.) and Mulliken charges of output.txt. */
export function parseCrawfordOutput(text: string): CrawfordOutput {
  let electronicEnergy = Number.NaN;
  let totalEnergy = Number.NaN;
  const dipole: [number, number, number] = [Number.NaN, Number.NaN, Number.NaN];
  const charges: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const iteration = /^\s*(\d\d)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/.exec(line);
    if (iteration) {
      electronicEnergy = Number(iteration[2]);
      totalEnergy = Number(iteration[3]);
      continue;
    }
    const mu = /^Mu-([XYZ])\s*=\s*(-?\d+\.\d+)/.exec(line);
    if (mu) {
      dipole['XYZ'.indexOf(mu[1])] = Number(mu[2]);
      continue;
    }
    const charge = /^Charge on atom (\d+):\s*(-?\d+\.\d+)/.exec(line);
    if (charge) charges[Number(charge[1])] = Number(charge[2]);
  }
  if (![electronicEnergy, totalEnergy, ...dipole].every(Number.isFinite) || charges.length === 0) {
    throw new Error('Could not parse the Crawford reference output.');
  }
  return { electronicEnergy, totalEnergy, dipole, charges };
}

interface Psi3Shell {
  readonly type: 'S' | 'P';
  readonly primitives: readonly { readonly exponent: string; readonly coefficient: string }[];
}

const PSI3_ELEMENT_Z: Readonly<Record<string, number>> = { HYDROGEN: 1, CARBON: 6, OXYGEN: 8 };

function toDefinition(shell: Psi3Shell): ShellDefinition {
  return {
    angularMomentum: [shell.type === 'S' ? 0 : 1],
    exponents: shell.primitives.map((p) => Number(p.exponent)),
    coefficients: [shell.primitives.map((p) => Number(p.coefficient))],
  };
}

/**
 * STO-3G exactly as PSI3 defines it (8-digit parameters, separate S and P shells), from the
 * fixture extracted from PSI3's pbasis.dat. The shell order S, S, P gives the same function order
 * (1s, 2s, 2px, 2py, 2pz) as the Crawford integral files.
 */
export function psi3Sto3gLibrary(): BasisLibrary {
  const file = readJsonFixture<{ basis: Record<string, Psi3Shell[]> }>('crawford/psi3-sto-3g.json');
  const byZ = new Map<number, ShellDefinition[]>();
  for (const [name, shells] of Object.entries(file.basis)) byZ.set(PSI3_ELEMENT_Z[name], shells.map(toDefinition));
  return (z) => byZ.get(z);
}

/**
 * The basis written out in a PSI3 input file, e.g. the Crawford CH4 case:
 *   basis: ( carbon: "STO-3G" = ( (S (71.6 0.154) ...) (P ...) )  hydrogen: "STO-3G" = ( ... ) )
 */
export function parsePsi3InputBasis(text: string): BasisLibrary {
  const start = text.search(/^basis:\s*\(/m);
  if (start < 0) throw new Error('The PSI3 input has no basis block.');
  const body = text.slice(start);
  const byZ = new Map<number, ShellDefinition[]>();
  const entry = /(\w+):\s*"[^"]*"\s*=/g;
  const heads: { name: string; at: number }[] = [];
  for (let match = entry.exec(body); match; match = entry.exec(body)) heads.push({ name: match[1].toUpperCase(), at: match.index + match[0].length });
  heads.forEach((head, index) => {
    const segment = body.slice(head.at, index + 1 < heads.length ? heads[index + 1].at : undefined);
    const shells: ShellDefinition[] = [];
    const shellPattern = /\(\s*([SP])\s*((?:\(\s*[-\d.]+\s+[-\d.]+\s*\)\s*)+)\)/g;
    for (let shell = shellPattern.exec(segment); shell; shell = shellPattern.exec(segment)) {
      const primitives = [...shell[2].matchAll(/\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/g)];
      shells.push({
        angularMomentum: [shell[1] === 'S' ? 0 : 1],
        exponents: primitives.map((p) => Number(p[1])),
        coefficients: [primitives.map((p) => Number(p[2]))],
      });
    }
    const z = PSI3_ELEMENT_Z[head.name];
    if (z === undefined || shells.length === 0) throw new Error(`Could not parse the basis of ${head.name}.`);
    byZ.set(z, shells);
  });
  return (z) => byZ.get(z);
}
