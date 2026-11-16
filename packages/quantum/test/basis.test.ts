import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ELEMENTS } from '@matterlab/core';
import { describe, expect, it } from 'vitest';
import { buildBasis, countBasisFunctions, elementSymbol, MAX_SUPPORTED_Z, sto3gLibrary } from '../src/basis/basis';
import { STO3G_REFERENCES, STO3G_SHELLS, STO3G_SOURCE, STO3G_SYMBOLS } from '../src/basis/sto3g.generated';
import { computeOverlapKineticDipole } from '../src/integrals/oneElectron';
import { ENGINE_VERSION } from '../src/index';

const dataFile = (name: string): string => fileURLToPath(new URL(`../data/${name}`, import.meta.url));

interface BseShell {
  function_type: string;
  angular_momentum: number[];
  exponents: string[];
  coefficients: string[][];
}
interface BseBasis {
  name: string;
  version: string;
  revision_date: string;
  elements: Record<string, { electron_shells: BseShell[]; references: { reference_keys: string[] }[] }>;
}

describe('bundled STO-3G data', () => {
  const raw = readFileSync(dataFile('sto-3g.bse.json'));
  const snapshot = JSON.parse(raw.toString('utf8')) as BseBasis;
  const manifest = JSON.parse(readFileSync(dataFile('manifest.json'), 'utf8'))['sto-3g'];

  it('is the committed Basis Set Exchange snapshot, byte for byte', () => {
    const sha256 = createHash('sha256').update(raw).digest('hex');
    expect(sha256).toBe(manifest.files['sto-3g.bse.json'].sha256);
    expect(STO3G_SOURCE.sha256).toBe(sha256);
    expect(STO3G_SOURCE.url).toBe(manifest.files['sto-3g.bse.json'].url);
    expect(STO3G_SOURCE.url).toMatch(/^https:\/\/www\.basissetexchange\.org\/api\/basis\/sto-3g\/format\/json/);
    expect(STO3G_SOURCE.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(STO3G_SOURCE.bseVersion).toBe(manifest.bseVersion);
    expect(STO3G_SOURCE.name).toBe(snapshot.name);
    expect(STO3G_SOURCE.basisVersion).toBe(snapshot.version);
    expect(STO3G_SOURCE.revisionDate).toBe(snapshot.revision_date);
  });

  it('states the Basis Set Exchange version found in the header of the NWChem-format download', () => {
    const header = readFileSync(dataFile('sto-3g.bse.nw'), 'utf8').split(/\r?\n/).slice(0, 6).join('\n');
    expect(header).toContain('Basis Set Exchange');
    expect(header).toContain(`Version ${STO3G_SOURCE.bseVersion}`);
  });

  it('has generated shells identical to the snapshot for Z = 1..18 (no digit lost or invented)', () => {
    expect(STO3G_SHELLS.length).toBe(18);
    expect(MAX_SUPPORTED_Z).toBe(18);
    for (let z = 1; z <= 18; z++) {
      const expected = snapshot.elements[String(z)].electron_shells;
      const actual = STO3G_SHELLS[z - 1];
      expect(actual.length, `Z=${z}`).toBe(expected.length);
      expected.forEach((shell, index) => {
        expect(shell.function_type).toBe('gto');
        expect(actual[index].angularMomentum).toEqual(shell.angular_momentum);
        expect(actual[index].exponents).toEqual(shell.exponents.map(Number));
        expect(actual[index].coefficients).toEqual(shell.coefficients.map((row) => row.map(Number)));
      });
    }
    // Elements beyond argon are not part of the snapshot and not supported.
    expect(Object.keys(snapshot.elements).map(Number).sort((a, b) => a - b)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(sto3gLibrary(19)).toBeUndefined();
    expect(sto3gLibrary(0)).toBeUndefined();
    expect(sto3gLibrary(1.5)).toBeUndefined();
  });

  it('lists the references the Basis Set Exchange gives for each element', () => {
    for (let z = 1; z <= 18; z++) {
      const keys = snapshot.elements[String(z)].references.flatMap((reference) => reference.reference_keys);
      const listed = STO3G_REFERENCES.filter((reference) => reference.elements.includes(z)).map((reference) => reference.key);
      expect([...listed].sort(), `Z=${z}`).toEqual([...keys].sort());
    }
    for (const reference of STO3G_REFERENCES) {
      expect(reference.doi).toMatch(/^10\.\d{4}\//);
      expect(reference.authors.length).toBeGreaterThan(0);
      expect(reference.year).toBeGreaterThan(1960);
    }
  });

  it('uses the same element symbols as @matterlab/core', () => {
    expect(STO3G_SYMBOLS).toEqual(ELEMENTS.slice(0, 18).map((element) => element.symbol));
    expect(elementSymbol(8)).toBe('O');
    expect(elementSymbol(19)).toBe('?');
  });

  it('keeps the engine version in step with package.json', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    expect(ENGINE_VERSION).toBe(pkg.version);
  });
});

describe('basis construction', () => {
  it('gives 1 function to H-He, 5 to Li-Ne and 9 to Na-Ar', () => {
    for (let z = 1; z <= 18; z++) {
      expect(countBasisFunctions(z), `Z=${z}`).toBe(z <= 2 ? 1 : z <= 10 ? 5 : 9);
      const basis = buildBasis([{ z, position: [0, 0, 0] }]);
      expect(basis.nBasis).toBe(countBasisFunctions(z));
      const shells = basis.functions.map((fn) => fn.shell);
      const expected = z <= 2 ? ['1s'] : z <= 10 ? ['1s', '2s', '2px', '2py', '2pz'] : ['1s', '2s', '2px', '2py', '2pz', '3s', '3px', '3py', '3pz'];
      expect(shells).toEqual(expected);
    }
    expect(countBasisFunctions(19)).toBe(0);
  });

  it('normalises every contracted function of every element to unit self-overlap', () => {
    for (let z = 1; z <= 18; z++) {
      const basis = buildBasis([{ z, position: [0.3, -0.2, 0.1] }]);
      const { overlap } = computeOverlapKineticDipole(basis);
      for (let mu = 0; mu < basis.nBasis; mu++) expect(Math.abs(overlap[mu * basis.nBasis + mu] - 1), `Z=${z} function ${mu}`).toBeLessThan(1e-13);
    }
  });

  it('orders functions atom by atom and labels them with element symbol and 1-based atom number', () => {
    const basis = buildBasis([
      { z: 1, position: [0, 0, 0] },
      { z: 17, position: [0, 0, 1.275] },
      { z: 6, position: [2, 0, 0] },
    ]);
    expect(basis.functions.map((fn) => fn.label)).toEqual([
      'H1 1s',
      'Cl2 1s', 'Cl2 2s', 'Cl2 2px', 'Cl2 2py', 'Cl2 2pz', 'Cl2 3s', 'Cl2 3px', 'Cl2 3py', 'Cl2 3pz',
      'C3 1s', 'C3 2s', 'C3 2px', 'C3 2py', 'C3 2pz',
    ]);
    expect(Array.from(basis.atomOfFunction)).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
    expect(basis.functions.map((fn) => fn.index)).toEqual(Array.from({ length: 15 }, (_, i) => i));
  });

  it('refuses elements without basis functions instead of guessing', () => {
    expect(() => buildBasis([{ z: 26, position: [0, 0, 0] }])).toThrow(/No basis functions/);
  });
});
