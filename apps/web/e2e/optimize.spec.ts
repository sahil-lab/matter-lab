import { expect, test } from '@playwright/test';
import { Lab, distance } from './lab';
import type { AtomRow } from './lab';

let lab: Lab;

test.beforeEach(async ({ page }) => {
  lab = new Lab(page);
  await lab.open();
});

test.afterEach(() => lab.expectNoProblems());

function angle(a: AtomRow, vertex: AtomRow, b: AtomRow): number {
  const u = a.position.map((v, i) => v - vertex.position[i]!);
  const w = b.position.map((v, i) => v - vertex.position[i]!);
  const dot = u[0]! * w[0]! + u[1]! * w[1]! + u[2]! * w[2]!;
  return (Math.acos(dot / (Math.hypot(...u) * Math.hypot(...w))) * 180) / Math.PI;
}

interface Record {
  converged: boolean;
  steps: number;
  initialEnergy: number;
  finalEnergy: number;
  rmsDisplacement: number;
  frames: number;
  movable: number;
  warnings: string[];
}

/** Runs the optimiser the way the Optimise button does and returns what it recorded. */
async function optimise(): Promise<Record | null> {
  return lab.eval(`
    return lab.compute.optimizeGeometry().then(() => {
      const r = lab.compute.useCompute.getState().optimization;
      return r && r.sceneAfter === lab.lab.get().scene
        ? { converged: r.converged, steps: r.steps, initialEnergy: r.initialEnergy, finalEnergy: r.finalEnergy, rmsDisplacement: r.rmsDisplacement, frames: r.trajectory.length, movable: r.movable, warnings: [...r.warnings] }
        : null;
    });`);
}

function problem(): Promise<{ title: string; details: string[]; atomIds: number[] } | null> {
  return lab.eval('const p = lab.compute.useCompute.getState().problem; return p ? { title: p.title, details: [...p.details], atomIds: [...p.atomIds] } : null;');
}

/*
 * Reference values. For a molecule in which every pair of atoms is bonded or shares a neighbour,
 * UFF has no van der Waals term, so the minimum sits exactly at the force field's natural bond
 * lengths and angles. Those follow from the published parameters (Rappe et al., J. Am. Chem. Soc.
 * 114, 10024 (1992)): r0 = r_i + r_j - r_EN (single bonds have no bond-order correction).
 *   O_3-H_ : 0.658 + 0.354 - 0.0217 = 0.9903 A, angle at O_3 104.51 degrees
 *   C_3-H_ : 0.757 + 0.354 - 0.0016 = 1.1094 A, angle at C_3 109.471 degrees
 */
const UFF_OH = 0.9903;
const UFF_HOH = 104.51;
const UFF_CH = 1.1094;
const TETRAHEDRAL = 109.471;

test.describe('geometry optimisation (UFF)', () => {
  test('brings a distorted water molecule to the force field minimum', async () => {
    await lab.openExample('water');
    const hydrogens = (await lab.atoms()).filter((a) => a.z === 1);
    await lab.eval(`lab.actions.setAtomPosition(${hydrogens[0]!.id}, [1.9, 0.4, 0.6]);`);

    const record = await optimise();
    expect(record).not.toBeNull();
    expect(record!.converged).toBe(true);
    expect(record!.finalEnergy).toBeLessThan(record!.initialEnergy);
    expect(record!.finalEnergy).toBeCloseTo(0, 6);
    expect(record!.rmsDisplacement).toBeGreaterThan(0.1);

    const atoms = await lab.atoms();
    const oxygen = atoms.find((a) => a.z === 8)!;
    const [h1, h2] = atoms.filter((a) => a.z === 1) as [AtomRow, AtomRow];
    expect(distance(oxygen.position, h1.position)).toBeCloseTo(UFF_OH, 3);
    expect(distance(oxygen.position, h2.position)).toBeCloseTo(UFF_OH, 3);
    expect(angle(h1, oxygen, h2)).toBeCloseTo(UFF_HOH, 2);
  });

  test('makes a flattened methane tetrahedral', async () => {
    await lab.openExample('methane');
    const before = await lab.atoms();
    // Squash every hydrogen into the plane of the carbon: a saddle point the optimiser has to leave.
    const flat = before.filter((a) => a.z === 1).map((a, i) => `[${a.id}, [${Math.cos((i * Math.PI) / 2)}, ${Math.sin((i * Math.PI) / 2)}, 0]]`);
    await lab.eval(`lab.actions.moveAtoms(new Map([${flat.join(',')}]), 'Flatten');`);

    const record = await optimise();
    expect(record!.converged).toBe(true);
    const atoms = await lab.atoms();
    const carbon = atoms.find((a) => a.z === 6)!;
    const hydrogens = atoms.filter((a) => a.z === 1);
    for (const h of hydrogens) expect(distance(carbon.position, h.position)).toBeCloseTo(UFF_CH, 3);
    for (let i = 0; i < hydrogens.length; i++) {
      for (let j = i + 1; j < hydrogens.length; j++) expect(angle(hydrogens[i]!, carbon, hydrogens[j]!)).toBeCloseTo(TETRAHEDRAL, 1);
    }
  });

  test('is one edit that undo and redo treat as a whole', async () => {
    await lab.openExample('ethanol');
    await lab.eval('lab.actions.setAtomPosition(9, [2.4, 1.6, 1.4]);');
    const distorted = await lab.atoms();
    const undoBefore = (await lab.summary()).undo;

    expect((await optimise())!.converged).toBe(true);
    const optimised = await lab.atoms();
    expect((await lab.summary()).undo).toBe(undoBefore + 1);
    expect(optimised).not.toEqual(distorted);

    await lab.eval('lab.actions.undo();');
    expect(await lab.atoms()).toEqual(distorted);
    await lab.eval('lab.actions.redo();');
    expect(await lab.atoms()).toEqual(optimised);
  });

  test('moves only the selected atoms when there is a selection', async () => {
    await lab.openExample('ethanol');
    await lab.eval('lab.actions.setAtomPosition(9, [2.4, 1.6, 1.4]); lab.actions.selectOnly([9]);');
    const before = await lab.atoms();

    const record = await optimise();
    expect(record).toMatchObject({ converged: true, movable: 1 });
    const after = await lab.atoms();
    for (const atom of after) {
      const was = before.find((a) => a.id === atom.id)!;
      if (atom.id === 9) expect(distance(atom.position, was.position)).toBeGreaterThan(0.5);
      else expect(atom.position).toEqual(was.position);
    }
    // The hydroxyl hydrogen is back at a bonding distance from its oxygen.
    expect(distance(after.find((a) => a.id === 9)!.position, after.find((a) => a.id === 3)!.position)).toBeCloseTo(UFF_OH, 2);
  });

  test('refuses a structure that is not chemically valid, and changes nothing', async () => {
    await lab.openExample('methane');
    await lab.eval("lab.lab.set({ autoHydrogens: false, tool: 'build', buildElement: 1 });");
    const carbon = await lab.atomPoint(1);
    await lab.drag(carbon, [carbon[0] + 140, carbon[1] - 130]);
    const before = await lab.atoms();

    expect(await optimise()).toBeNull();
    const reason = await problem();
    expect(reason!.title).toContain('chemically valid');
    expect(reason!.details.join(' ')).toMatch(/valence/i);
    expect(await lab.atoms()).toEqual(before);
    expect(await lab.eval<string>("return lab.jobs.useJobs.getState().jobs[0].status;")).toBe('unsupported');
  });

  test('says which atom the force field has no parameters for', async () => {
    await lab.eval("lab.actions.newDocument(); lab.lab.set({ buildElement: 54 }); lab.actions.placeAtom([0, 0, 0]);");
    expect((await lab.summary()).formula).toBe('Xe');
    expect(await optimise()).toBeNull();
    const reason = await problem();
    expect(reason!.title).toContain('no parameters');
    expect(reason!.details.join(' ')).toContain('Xe (atom 1)');
    expect(reason!.atomIds).toEqual([1]);
    // The atom concerned is selected so it can be found.
    expect((await lab.summary()).selectedAtoms).toEqual([1]);
  });

  test('can be cancelled while it runs, leaving the structure untouched', async ({ page }) => {
    // A long hydrocarbon chain (C200H402) from a crude zigzag keeps the optimiser busy for many seconds:
    // one connected, floppy molecule, unlike a pile of small rigid ones, which converge at once.
    await lab.eval(`
      lab.actions.newDocument();
      lab.lab.set({ autoHydrogens: false, tool: 'select' });
      lab.actions.runEdit('Chain', (e) => {
        let previous = null;
        for (let i = 0; i < 200; i++) {
          const id = e.addAtom({ protons: 6, position: [i * 1.25, (i % 2) * 0.85, 0.3 * Math.sin(i)] });
          if (previous !== null) e.addBond(previous, id, 1);
          previous = id;
        }
      });
      lab.actions.hydrogenate();
      lab.viewApi.fitAll(false);`);
    await lab.settle();
    const before = await lab.atoms();
    expect(before.length).toBe(602);
    expect((await lab.summary()).formula).toBe('C200H402');

    await lab.eval('window.__pending = lab.compute.optimizeGeometry();');
    await page.waitForFunction(() => (window as unknown as { __MATTERLAB__: { compute: { useCompute: { getState(): { progress: unknown } } } } }).__MATTERLAB__.compute.useCompute.getState().progress !== null);

    // The page must keep producing frames while the optimiser works in its own thread.
    const pacing = await page.evaluate(
      () =>
        new Promise<{ frames: number; longestGapMs: number }>((resolve) => {
          const start = performance.now();
          let last = start;
          let frames = 0;
          let longestGapMs = 0;
          const tick = (now: number) => {
            frames++;
            longestGapMs = Math.max(longestGapMs, now - last);
            last = now;
            if (now - start < 800) requestAnimationFrame(tick);
            else resolve({ frames, longestGapMs });
          };
          requestAnimationFrame(tick);
        }),
    );
    test.info().annotations.push({ type: 'frame pacing during optimisation', description: JSON.stringify(pacing) });
    expect(pacing.frames).toBeGreaterThan(20);
    expect(pacing.longestGapMs).toBeLessThan(250);

    // ...and the camera must still answer the mouse.
    const poseBefore = await lab.pose();
    const empty = await lab.emptyPoint();
    await lab.drag(empty, [empty[0] + 90, empty[1] + 40]);
    expect(await lab.pose()).not.toBe(poseBefore);
    expect(await lab.eval<boolean>('return lab.compute.useCompute.getState().optimizing;'), 'the optimisation finished before it could be cancelled').toBe(true);

    await lab.eval('lab.compute.cancelOptimization(); return window.__pending;');
    expect(await lab.eval<boolean>('return lab.compute.useCompute.getState().optimizing;')).toBe(false);
    expect(await lab.eval<string>('return lab.jobs.useJobs.getState().jobs[0].status;')).toBe('cancelled');
    expect(await lab.atoms()).toEqual(before);
    expect(await problem()).toBeNull();

    // The engine is usable again straight away.
    await lab.openExample('water');
    expect((await optimise())!.converged).toBe(true);
  });

  test('comparing with the original and replaying the path never change the structure', async ({ page }) => {
    await lab.openExample('ethanol');
    await lab.eval('lab.actions.setAtomPosition(9, [2.4, 1.6, 1.4]);');
    const record = await optimise();
    expect(record!.frames).toBeGreaterThan(5);
    const optimised = await lab.atoms();
    const undo = (await lab.summary()).undo;

    await lab.eval('lab.compute.setShowOriginal(true);');
    await lab.settle();
    await lab.eval('lab.compute.playReplay();');
    await page.waitForFunction(() => (window as unknown as { __MATTERLAB__: { compute: { useCompute: { getState(): { replaying: boolean } } } } }).__MATTERLAB__.compute.useCompute.getState().replaying === false, undefined, { timeout: 15_000 });
    await lab.eval('lab.compute.seekReplay(0); lab.compute.stopReplay(); lab.compute.setShowOriginal(false);');

    expect(await lab.atoms()).toEqual(optimised);
    expect((await lab.summary()).undo).toBe(undo);
  });

  test('runs from the tool rail and reports the result in the inspector', async ({ page }) => {
    await lab.openExample('water');
    const hydrogens = (await lab.atoms()).filter((a) => a.z === 1);
    await lab.eval(`lab.actions.setAtomPosition(${hydrogens[0]!.id}, [1.9, 0.4, 0.6]);`);
    await page.getByTestId('tool-optimize').click();
    await expect(page.getByTestId('optimization-status')).toHaveText('Converged to a minimum');
    await expect(page.getByTestId('energy-after')).toContainText('kcal/mol');
    await expect(page.getByTestId('optimization-result')).toContainText('RMS displacement');
    // The result disappears as soon as the structure is edited: it no longer describes it.
    await lab.eval(`lab.actions.setAtomPosition(${hydrogens[0]!.id}, [1.2, 0.2, 0.3]);`);
    await expect(page.getByTestId('optimization-result')).toHaveCount(0);
    await expect(page.getByTestId('inspector')).toContainText('edited since the last optimisation');
  });

  test('explains the calculation with its own numbers, follows the selection, and withdraws with the result', async ({ page }) => {
    await lab.openExample('water');
    const hydrogen = (await lab.atoms()).find((a) => a.z === 1)!;
    const start = [1.9, 0.4, 0.6];
    await lab.eval(`lab.actions.setAtomPosition(${hydrogen.id}, ${JSON.stringify(start)});`);
    await page.getByTestId('tool-optimize').click();
    await expect(page.getByTestId('optimization-status')).toHaveText('Converged to a minimum');
    const record = await lab.eval<{ steps: number; initialEnergy: number; rmsDisplacement: number }>(
      'const r = lab.compute.useCompute.getState().optimization; return { steps: r.steps, initialEnergy: r.initialEnergy, rmsDisplacement: r.rmsDisplacement };',
    );
    // The energy at every step is kept for the graph: it starts at the starting energy and ends at the minimum.
    const path = await lab.eval<{ steps: number[]; energies: number[] }>('const p = lab.compute.useCompute.getState().optimization.energyPath; return { steps: [...p.steps], energies: [...p.energies] };');
    expect(path.steps[0]).toBe(0);
    expect(path.steps[path.steps.length - 1]).toBe(record.steps);
    expect(path.energies[0]).toBeCloseTo(record.initialEnergy, 9);
    expect(Math.abs(path.energies[path.energies.length - 1]!)).toBeLessThan(1e-6);

    await page.getByTestId('explain-optimisation').click();
    const explanation = page.getByTestId('explanation-optimisation');
    await expect(explanation).toBeVisible();
    for (const heading of ['Objective', 'Starting point and conditions', 'Method', 'Model', 'Assumptions', 'Result', 'Convergence', 'Confidence and uncertainty', 'Why the real molecule may differ', 'Sources']) {
      await expect(explanation.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    }
    await expect(explanation).toContainText(`Converged to a minimum after ${record.steps} steps`);
    await expect(explanation).toContainText(`The energy went from ${record.initialEnergy.toFixed(3)} to 0.000 kcal/mol`);
    await expect(explanation).toContainText(`The atoms moved by ${record.rmsDisplacement.toFixed(3)} Å on average`);
    await expect(explanation).toContainText('no electrostatic forces');
    await expect(explanation).toContainText('doi:10.1021/ja00051a040');

    // It speaks about the atom that is selected, with what happened to that atom.
    await expect(explanation).not.toContainText('Selected atom');
    await lab.eval(`lab.actions.selectOnly([${hydrogen.id}]);`);
    const moved = distance(start, (await lab.atom(hydrogen.id)).position);
    await expect(explanation).toContainText(`Selected atom: H (atom ${hydrogen.id}) moved by ${moved.toFixed(3)} Å and was treated as the UFF type H_`);

    // The detailed account adds the energy expression and the algorithm.
    await expect(explanation).not.toContainText('BFGS quasi-Newton');
    await expect(explanation.locator('.ml-eq')).toHaveCount(0);
    await page.getByRole('button', { name: 'In depth' }).click();
    await expect(explanation).toContainText('BFGS quasi-Newton');
    await expect(explanation.locator('.ml-eq')).toContainText('(x/r)¹²');

    // Once the structure is edited the calculation no longer describes it, and its explanation goes with it.
    await lab.eval(`lab.actions.setAtomPosition(${hydrogen.id}, [1.2, 0.2, 0.3]);`);
    await expect(explanation).toHaveCount(0);
    await expect(page.getByTestId('explanation')).toBeVisible();
    await expect(page.getByRole('group', { name: 'What to explain' })).toHaveCount(0);
  });
});
