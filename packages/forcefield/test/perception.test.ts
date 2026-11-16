/**
 * Hybridisation, conjugation, valence, radical and small-ring perception against what RDKit itself
 * perceives for the same molecule (recorded in the fixture).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { perceiveUffMolecule } from '../src';
import { buildGraph, perceive } from '../src/perception';
import { loadReference, toMolecule } from './helpers/reference';
import type { RefBase } from './helpers/reference';
import { publish } from './helpers/report';

const ref = loadReference();
const everything: RefBase[] = [...ref.molecules, ...ref.unsupported];

const counts = { molecules: 0, atoms: 0, bonds: 0, hybridisationsCompared: 0 };

describe('perception of what UFF typing depends on', () => {
  afterAll(() => publish('perception', counts));

  for (const m of everything) {
    it(`matches RDKit for ${m.name}`, () => {
      // The internal perception works for every molecule, including those UFF cannot type.
      const p = perceive(buildGraph(toMolecule(m, m.coords)));
      expect(p.problems).toEqual([]);
      const rd = m.perception;
      for (let i = 0; i < m.nAtoms; i++) {
        // RDKit does not perceive the hydrogens that AddHs appends; they stay UNSPECIFIED there.
        const untouched = m.z[i] === 1 && rd.hybridization[i] === 'UNSPECIFIED';
        if (!untouched) {
          expect(p.hybridization[i], `hybridisation of atom ${i}`).toBe(rd.hybridization[i]);
          counts.hybridisationsCompared++;
        }
        expect(p.totalValence[i], `total valence of atom ${i}`).toBe(rd.totalValence[i]);
        expect(p.radicalElectrons[i], `radical electrons of atom ${i}`).toBe(rd.radicalElectrons[i]);
        expect(p.aromatic[i], `aromaticity of atom ${i}`).toBe(rd.aromaticAtoms[i]);
        expect(p.inRing3[i], `three-ring membership of atom ${i}`).toBe(rd.inRing3[i]);
        expect(p.inRing4[i], `four-ring membership of atom ${i}`).toBe(rd.inRing4[i]);
      }
      for (let b = 0; b < m.bonds.length; b++) {
        expect(p.conjugatedBond[b], `conjugation of bond ${b} (${m.bonds[b][0]}-${m.bonds[b][1]})`).toBe(rd.conjugatedBonds[b]);
      }
      // same partition into fragments (the numbering may differ)
      for (let i = 0; i < m.nAtoms; i++) {
        for (let j = i + 1; j < m.nAtoms; j++) {
          expect(p.fragment[i] === p.fragment[j]).toBe(rd.fragments[i] === rd.fragments[j]);
        }
      }
      expect(p.nFragments).toBe(new Set(rd.fragments).size);
      counts.molecules++;
      counts.atoms += m.nAtoms;
      counts.bonds += m.bonds.length;
    });
  }

  it('reports the same data through the public perceiveUffMolecule', () => {
    const m = ref.molecules.find((x) => x.name === 'aspirin');
    expect(m).toBeDefined();
    if (!m) return;
    const p = perceiveUffMolecule(toMolecule(m, m.coords));
    expect(p.nAtoms).toBe(m.nAtoms);
    expect(p.atomicNumbers).toEqual(m.z);
    expect(p.totalValence).toEqual(m.perception.totalValence);
    expect(p.radicalElectrons).toEqual(m.perception.radicalElectrons);
    expect(p.aromatic).toEqual(m.perception.aromaticAtoms.map((v) => v === 1));
    expect(p.conjugatedBonds).toEqual(m.perception.conjugatedBonds.map((v) => v === 1));
    expect(p.inRing3).toEqual(m.perception.inRing3.map((v) => v === 1));
    expect(p.inRing4).toEqual(m.perception.inRing4.map((v) => v === 1));
    expect(p.atomTypes.length).toBe(m.nAtoms);
    // plain data: survives a structured clone unchanged
    expect(structuredClone(p)).toEqual(p);
  });
});
