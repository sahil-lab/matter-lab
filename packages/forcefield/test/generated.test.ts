/**
 * The generated data tables must be exactly what the vendored RDKit sources contain, and RDKit's
 * periodic-table data must agree with the element data the rest of MATTER LAB uses.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getElement } from '@matterlab/core';
import { RDKIT_VERSION } from '../src';
import {
  RDKIT_ELEMENTS_PROVENANCE,
  RDKIT_ELEMENT_SYMBOLS,
  RDKIT_MAX_ATOMIC_NUMBER,
  RDKIT_OUTER_ELECTRONS,
  RDKIT_VALENCE_LISTS,
} from '../src/generated/rdkitElements.generated';
import { UFF_G, UFF_LAMBDA, UFF_PARAMS_PROVENANCE, UFF_PARAM_ROWS } from '../src/generated/uffParams.generated';
import { uffAtomicParams, uffAtomTypeLabels } from '../src/params';
import { loadReference } from './helpers/reference';

const SRC = new URL('../tools/rdkit-src/', import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, SRC), 'utf8');
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

interface Manifest {
  tag: string;
  commit: string;
  files: Record<string, { sha256: string; bytes: number }>;
}
const manifest = JSON.parse(read('MANIFEST.json')) as Manifest;

/** An independent reading of the table in Params.cpp: the text between the quotes, split on tabs. */
function parseParamsCpp(): string[][] {
  const text = read('Code/ForceField/UFF/Params.cpp');
  const start = text.indexOf('const std::string defaultParamData =');
  const end = text.indexOf(';', start);
  const literals = text.slice(start, end).match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  const data = literals.map((l) => l.slice(1, -1)).join('').replace(/\\n/g, '\n');
  return data
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split('\t'));
}

describe('generated UFF parameter table', () => {
  it('records the RDKit release the reference data was computed with', () => {
    const ref = loadReference();
    expect(UFF_PARAMS_PROVENANCE.rdkitVersion).toBe(ref.meta.rdkitVersion);
    expect(RDKIT_ELEMENTS_PROVENANCE.rdkitVersion).toBe(ref.meta.rdkitVersion);
    expect(RDKIT_VERSION).toBe(ref.meta.rdkitVersion);
    expect(UFF_PARAMS_PROVENANCE.rdkitTag).toBe(manifest.tag);
    expect(UFF_PARAMS_PROVENANCE.rdkitCommit).toBe(manifest.commit);
  });

  it('was generated from the vendored Params.cpp, which is the file named in the manifest', () => {
    const text = read('Code/ForceField/UFF/Params.cpp');
    expect(sha256(text)).toBe(manifest.files['Code/ForceField/UFF/Params.cpp'].sha256);
    expect(UFF_PARAMS_PROVENANCE.sourceSha256).toBe(sha256(text));
    expect(RDKIT_ELEMENTS_PROVENANCE.sourceSha256).toBe(sha256(read('Code/GraphMol/atomic_data.cpp')));
  });

  it('contains every row of RDKit\'s table, value for value', () => {
    const rows = parseParamsCpp();
    expect(rows.length).toBe(127);
    expect(UFF_PARAM_ROWS.length).toBe(rows.length);
    rows.forEach((cols, r) => {
      expect(cols.length).toBe(12);
      const generated = UFF_PARAM_ROWS[r];
      expect(generated[0]).toBe(cols[0]);
      for (let c = 1; c < 12; c++) expect(generated[c]).toBe(Number(cols[c]));
    });
    expect(new Set(uffAtomTypeLabels()).size).toBe(127);
  });

  it('takes the scalar constants from Params.h', () => {
    const header = read('Code/ForceField/UFF/Params.h');
    expect(UFF_LAMBDA).toBe(Number(/const\s+double\s+lambda\s*=\s*([0-9.]+)/.exec(header)?.[1]));
    expect(UFF_G).toBe(Number(/const\s+double\s+G\s*=\s*([0-9.]+)/.exec(header)?.[1]));
  });

  it('converts natural angles to radians the way RDKit does', () => {
    const c3 = uffAtomicParams('C_3');
    expect(c3).toBeDefined();
    expect(c3?.theta0).toBe((109.47 * Math.PI) / 180);
    expect(uffAtomicParams('C_4')).toBeUndefined();
  });
});

describe("RDKit's periodic-table data", () => {
  it('covers elements 0 to 118', () => {
    expect(RDKIT_MAX_ATOMIC_NUMBER).toBe(118);
    expect(RDKIT_ELEMENT_SYMBOLS.length).toBe(119);
    expect(RDKIT_OUTER_ELECTRONS.length).toBe(119);
    expect(RDKIT_VALENCE_LISTS.length).toBe(119);
  });

  it('agrees with the element data of @matterlab/core', () => {
    for (let z = 1; z <= 118; z++) {
      const el = getElement(z);
      expect(RDKIT_ELEMENT_SYMBOLS[z], `symbol of element ${z}`).toBe(el.symbol);
      expect(RDKIT_OUTER_ELECTRONS[z], `outer electrons of ${el.symbol}`).toBe(el.outerElectrons);
      // core keeps the allowed valences and a separate "unconstrained" flag for RDKit's trailing -1
      const list = RDKIT_VALENCE_LISTS[z];
      expect(list.filter((v) => v >= 0), `valences of ${el.symbol}`).toEqual([...el.valences]);
      expect(list.includes(-1), `unconstrained valence of ${el.symbol}`).toBe(el.valenceUnconstrained);
    }
  });

  it('is what the installed RDKit reports (fixture written by tools/gen_rdkit_checks.py)', () => {
    interface Fixture {
      meta: { rdkitVersion: string };
      periodicTable: { z: number; symbol: string; outerElectrons: number; valenceList: number[]; defaultValence: number }[];
    }
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/rdkit_checks.json', import.meta.url), 'utf8')) as Fixture;
    expect(fixture.meta.rdkitVersion).toBe(RDKIT_VERSION);
    expect(fixture.periodicTable).toHaveLength(119);
    for (const el of fixture.periodicTable) {
      expect(RDKIT_ELEMENT_SYMBOLS[el.z], `symbol of element ${el.z}`).toBe(el.symbol);
      expect(RDKIT_OUTER_ELECTRONS[el.z], `outer electrons of ${el.symbol}`).toBe(el.outerElectrons);
      expect([...RDKIT_VALENCE_LISTS[el.z]], `valence list of ${el.symbol}`).toEqual(el.valenceList);
      // the typer's "default valence" is the first entry of the list
      expect(RDKIT_VALENCE_LISTS[el.z][0], `default valence of ${el.symbol}`).toBe(el.defaultValence);
    }
  });
});
