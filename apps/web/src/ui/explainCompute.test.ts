import { EMPTY_SCENE, editScene, exampleScene, findExample, sortedAtoms, sortedBonds, vdist } from '@matterlab/core';
import type { AtomId, Scene, Vec3 } from '@matterlab/core';
import { optimizeUff } from '@matterlab/forcefield';
import { runRhf } from '@matterlab/quantum';
import { describe, expect, it } from 'vitest';
import type { FieldSettings, QuantumRecord, SliceSettings } from '../compute/quantum';
import type { OptimizationRecord } from '../compute/store';
import { CALIBRATION, explainOptimisation, explainQuantum } from './explainCompute';
import type { QuantumView } from './explainCompute';
import type { Explanation } from './explain';

/** What Part 10 of the specification asks every calculation's explanation to cover. */
const REQUIRED = ['Objective', 'Starting point and conditions', 'Method', 'Model', 'Assumptions', 'Result', 'Convergence', 'Confidence and uncertainty', 'Why the real molecule may differ'];

const text = (explanation: Explanation): string => explanation.sections.flatMap((s) => [s.heading, ...s.paragraphs, s.equation ?? '']).join('\n');
const section = (explanation: Explanation, heading: string): string => explanation.sections.find((s) => s.heading === heading)!.paragraphs.join('\n');
const angle = (a: Vec3, centre: Vec3, b: Vec3): number => {
  const u = [a[0] - centre[0], a[1] - centre[1], a[2] - centre[2]];
  const v = [b[0] - centre[0], b[1] - centre[1], b[2] - centre[2]];
  const dot = u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!;
  return (Math.acos(dot / (Math.hypot(...u) * Math.hypot(...v))) * 180) / Math.PI;
};

/** A hand-built water molecule, optimised with the real force field, recorded the way the application records it. */
function optimisedWater(maxSteps?: number): OptimizationRecord {
  const before = editScene(EMPTY_SCENE, 'water', (e) => {
    const o = e.addAtom({ protons: 8, position: [0, 0, 0] });
    e.addBond(o, e.addAtom({ protons: 1, position: [1.1, 0, 0] }), 1);
    e.addBond(o, e.addAtom({ protons: 1, position: [-0.2, 1.05, 0.1] }), 1);
  }).scene;
  const atoms = sortedAtoms(before);
  const index = new Map(atoms.map((atom, i) => [atom.id, i]));
  const result = optimizeUff(
    { atoms: atoms.map((a) => ({ z: a.protons, formalCharge: a.protons - a.electrons, position: a.position })), bonds: sortedBonds(before).map((b) => ({ a: index.get(b.a)!, b: index.get(b.b)!, order: b.order })) },
    maxSteps === undefined ? {} : { maxSteps },
  );
  const position = (i: number): Vec3 => [result.positions[3 * i]!, result.positions[3 * i + 1]!, result.positions[3 * i + 2]!];
  const after = editScene(before, 'optimise', (e) => atoms.forEach((atom, i) => e.moveAtom(atom.id, position(i)))).scene;
  const atomIds = atoms.map((a) => a.id);
  const moves = atomIds.map((id, i) => ({ atomId: id, distance: vdist(atoms[i]!.position, position(i)) }));
  return {
    sceneBefore: before,
    sceneAfter: after,
    atomIds,
    movable: atomIds.length,
    converged: result.converged,
    steps: result.steps,
    initialEnergy: result.initialEnergy,
    finalEnergy: result.finalEnergy,
    energyTerms: result.energyTerms,
    rmsGradient: result.rmsGradient,
    rmsDisplacement: result.rmsDisplacement,
    largestMove: moves.reduce((best, move) => (move.distance > best.distance ? move : best)),
    bondChanges: sortedBonds(before).map((b) => ({ a: b.a, b: b.b, before: vdist(before.atoms.get(b.a)!.position, before.atoms.get(b.b)!.position), after: vdist(after.atoms.get(b.a)!.position, after.atoms.get(b.b)!.position) })),
    atomTypes: new Map(atomIds.map((id, i) => [id, result.atomTypes[i]!])),
    warnings: result.warnings,
    elapsedMs: result.elapsedMs,
    provenance: result.provenance,
    trajectory: [],
    energyPath: { steps: [], energies: [] },
  };
}

function hartreeFock(scene: Scene): QuantumRecord {
  const atoms = sortedAtoms(scene);
  const input = { atoms: atoms.map((a) => ({ z: a.protons, position: a.position })), charge: atoms.reduce((sum, a) => sum + a.protons - a.electrons, 0) };
  const result = runRhf(input);
  return { id: 'test', scene, atomIds: atoms.map((a) => a.id), input, result, elapsedMs: result.timings.totalMs } as QuantumRecord;
}

const FIELD: FieldSettings = { kind: 'off', style: 'surface', orbital: 0, orbitalIso: 0.05, densityIso: 0.02, potentialIso: 0.002, potentialRange: null, opacity: 0.6, dots: 20000 };
const SLICE: SliceSettings = { enabled: false, field: 'density', axis: 'z', atoms: null, offset: 0, cut: false, flipped: false };
const view = (change: Partial<QuantumView> = {}): QuantumView => ({ field: FIELD, fieldInfo: null, slice: SLICE, sliceInfo: null, selectedAtom: null, ...change });

describe('explanation of a geometry optimisation', () => {
  const record = optimisedWater();

  it('quotes the worked example the force field really gives', () => {
    expect(record.converged).toBe(true);
    const [o, h1, h2] = sortedAtoms(record.sceneAfter);
    expect(vdist(o!.position, h1!.position)).toBeCloseTo(CALIBRATION.uffWater.bond, 3);
    expect(vdist(o!.position, h2!.position)).toBeCloseTo(CALIBRATION.uffWater.bond, 3);
    expect(angle(h1!.position, o!.position, h2!.position)).toBeCloseTo(CALIBRATION.uffWater.angle, 1);
  });

  it('covers every part the specification asks for, at both depths', () => {
    for (const level of ['beginner', 'advanced'] as const) {
      const explanation = explainOptimisation(record, level);
      expect(explanation.sections.map((s) => s.heading)).toEqual(REQUIRED);
      for (const s of explanation.sections) expect(s.paragraphs.length, s.heading).toBeGreaterThan(0);
    }
    const model = (level: 'beginner' | 'advanced') => explainOptimisation(record, level).sections.find((s) => s.heading === 'Model')!;
    expect(model('beginner').equation).toBeUndefined();
    expect(model('advanced').equation).toContain('(x/r)¹²');
    expect(text(explainOptimisation(record, 'advanced'))).toContain('BFGS quasi-Newton');
    expect(text(explainOptimisation(record, 'beginner'))).not.toContain('BFGS');
  });

  it('reports the numbers of this calculation, not generic ones', () => {
    const explanation = explainOptimisation(record, 'beginner');
    const result = section(explanation, 'Result');
    expect(result).toContain('Converged to a minimum');
    expect(result).toContain(`${record.steps} step`);
    // Water has no van der Waals term in UFF, so its minimum has no strain at all: zero, and written as zero.
    expect(Math.abs(record.finalEnergy)).toBeLessThan(5e-4);
    expect(result).toContain('to **0.000 kcal/mol**');
    expect(text(explanation)).not.toContain('−0.000');
    expect(result).toContain(`from ${record.initialEnergy.toFixed(3)} to`);
    expect(result).toContain(`${record.rmsDisplacement.toFixed(3)} Å`);
    expect(section(explanation, 'Starting point and conditions')).toContain('3 atoms and 2 bonds');
    expect(section(explanation, 'Convergence')).toContain('10⁻⁴ kcal/mol/Å');
    expect(section(explanation, 'Method')).not.toContain('undefined');
    // The types the force field assigned to this molecule are named in the detailed account.
    expect(section(explainOptimisation(record, 'advanced'), 'Method')).toContain('H_, O_3');
  });

  it('follows the selected atom', () => {
    const hydrogen = record.atomIds[1] as AtomId;
    const moved = vdist(record.sceneBefore.atoms.get(hydrogen)!.position, record.sceneAfter.atoms.get(hydrogen)!.position);
    expect(section(explainOptimisation(record, 'beginner'), 'Result')).not.toContain('Selected atom');
    const result = section(explainOptimisation(record, 'beginner', hydrogen), 'Result');
    expect(result).toContain(`**Selected atom:** H (atom ${hydrogen}) moved by ${moved.toFixed(3)} Å and was treated as the UFF type H_`);
  });

  it('says so when the search did not converge', () => {
    const cut = optimisedWater(2);
    expect(cut.converged).toBe(false);
    const explanation = explainOptimisation(cut, 'beginner');
    expect(section(explanation, 'Result')).toContain('**Not converged** after 2 steps');
    expect(section(explanation, 'Convergence')).toContain('Running the optimisation again continues');
    expect(section(explanation, 'Result')).not.toContain('Converged to a minimum');
  });

  it('cites the papers the engine itself names, and the source of the measured values', () => {
    const { references } = explainOptimisation(record, 'beginner');
    expect(references.map((r) => r.doi)).toEqual(expect.arrayContaining(['10.1021/ja00051a040', '10.18434/T47C7Z']));
    expect(references.length).toBe((record.provenance.citations ?? []).length + 1);
  });
});

describe('explanation of a Hartree-Fock calculation', () => {
  const scene = exampleScene(findExample('water')!);
  const record = hartreeFock(scene);
  const { result } = record;

  it('quotes the worked example the engine really gives', () => {
    expect(result.converged).toBe(true);
    expect(result.dipole.magnitudeDebye).toBeCloseTo(CALIBRATION.rhfWaterDipole, 2);
    // The example only teaches something if the computed and the measured value differ visibly.
    expect(Math.abs(CALIBRATION.rhfWaterDipole - CALIBRATION.measuredWater.dipole)).toBeGreaterThan(0.1);
  });

  it('covers every part the specification asks for, at both depths', () => {
    for (const level of ['beginner', 'advanced'] as const) {
      const explanation = explainQuantum(record, level, view());
      expect(explanation.sections.map((s) => s.heading)).toEqual(REQUIRED);
    }
    const advanced = explainQuantum(record, 'advanced', view());
    expect(advanced.sections.find((s) => s.heading === 'Model')!.equation).toContain('F C = S C ε');
    expect(text(advanced)).toContain('McMurchie–Davidson');
    expect(text(explainQuantum(record, 'beginner', view()))).not.toContain('McMurchie');
  });

  it('reports the numbers of this calculation', () => {
    const explanation = explainQuantum(record, 'beginner', view());
    const found = section(explanation, 'Result');
    expect(found).toContain(`**${result.energy.total.toFixed(6).replace('-', '−')} Eh**`);
    expect(found).toContain(`**${result.dipole.magnitudeDebye.toFixed(3)} D**`);
    expect(found).toContain(`Converged** in ${result.iterations.length} iterations`);
    expect(section(explanation, 'Starting point and conditions')).toContain('3 nuclei at the positions drawn, a net charge of zero, and therefore **10 electrons**, all paired in 5 orbitals');
    expect(section(explanation, 'Convergence')).toContain('less than 10⁻⁹ Eh and the density matrix by less than 10⁻⁷');
    expect(text(explanation)).not.toMatch(/undefined|NaN/);
  });

  it('follows the selected atom with its charge', () => {
    const oxygen = record.atomIds[0] as AtomId;
    const found = section(explainQuantum(record, 'beginner', view({ selectedAtom: oxygen })), 'Result');
    const charge = result.mullikenCharges[0]!;
    expect(charge).toBeLessThan(0);
    expect(found).toContain(`**Selected atom:** O (atom ${oxygen}) has a Mulliken charge of −${Math.abs(charge).toFixed(3)} e`);
    expect(found).toContain('cannot be measured');
  });

  it('describes exactly what is drawn on stage, and nothing when nothing is', () => {
    expect(explainQuantum(record, 'beginner', view()).sections.some((s) => s.heading === 'What is drawn')).toBe(false);

    const drawn = (change: Partial<QuantumView>): string => section(explainQuantum(record, 'beginner', view(change)), 'What is drawn');
    const homo = drawn({ field: { ...FIELD, kind: 'orbital', orbital: result.homoIndex } });
    expect(homo).toContain(`**HOMO** (orbital ${result.homoIndex + 1} of ${result.nBasis}`);
    expect(homo).toContain('It holds two electrons.');
    expect(homo).toContain('+0.05 and −0.05 a₀^(−3/2)');
    expect(homo).toContain('a node');
    const lumo = drawn({ field: { ...FIELD, kind: 'orbital', orbital: result.lumoIndex! } });
    expect(lumo).toContain('**LUMO**');
    expect(lumo).toContain('It is empty in this state');

    const density = drawn({ field: { ...FIELD, kind: 'density' } });
    expect(density).toContain('electron density of all 10 electrons');
    expect(density).toContain('0.02 e/a₀³');
    const cloud = drawn({ field: { ...FIELD, kind: 'density', style: 'cloud' } });
    expect(cloud).toContain('they are not electrons');

    const potential = drawn({
      field: { ...FIELD, kind: 'potential' },
      fieldInfo: { kind: 'potential', style: 'surface', orbital: null, isoValue: 0.002, parts: [], gridSpacing: 0.18, potentialMin: -0.0712, potentialMax: 0.0534, potentialRange: 0.08, dots: null, captured: null, elapsedMs: 1 },
    });
    expect(potential).toContain('**red** where it is attracted');
    expect(potential).toContain('from −0.071 to +0.053 Eh/e');

    const plane = drawn({ slice: { ...SLICE, enabled: true, field: 'potential' } });
    expect(plane).toContain('**Cutting plane:** a flat section through the electrostatic potential');
  });

  it('does not hide a calculation that failed to converge', () => {
    const unconverged = { ...record, result: { ...result, converged: false, warnings: ['The SCF did not converge in 100 iterations.'] } } as QuantumRecord;
    const explanation = explainQuantum(unconverged, 'beginner', view());
    expect(section(explanation, 'Result')).toContain('**Not converged**');
    expect(section(explanation, 'Result')).toContain('Nothing derived from this result should be relied on');
    expect(section(explanation, 'Convergence')).toContain('The SCF did not converge in 100 iterations.');
  });

  it('cites the method and basis-set papers the engine itself names', () => {
    const { references } = explainQuantum(record, 'beginner', view());
    expect(references.map((r) => r.doi)).toEqual(expect.arrayContaining(['10.1103/RevModPhys.23.69', '10.18434/T47C7Z']));
    expect(references.length).toBe((result.provenance.citations ?? []).length + 1);
  });
});
