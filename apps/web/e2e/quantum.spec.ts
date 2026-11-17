import { expect, test } from '@playwright/test';
import { Lab } from './lab';

/** Angstrom per bohr (CODATA 2018). */
const BOHR = 0.529177210903;
const DEBYE_PER_AU = 2.541746473;

let lab: Lab;

test.beforeEach(async ({ page }) => {
  lab = new Lab(page);
  await lab.open();
});

test.afterEach(() => lab.expectNoProblems());

/** Waits until every calculation and every surface, plane or cloud that was asked for is on stage. */
async function idle(): Promise<void> {
  await lab.settle(150);
  await lab.page.waitForFunction(
    () => {
      const s = (window as unknown as { __MATTERLAB__: { quantum: { useQuantum: { getState(): Record<string, unknown> } } } }).__MATTERLAB__.quantum.useQuantum.getState();
      return !s.running && !s.fieldBusy && !s.sliceBusy && !s.molecularBusy;
    },
    undefined,
    { timeout: 120_000 },
  );
}

/** Opens a structure given as element symbols and positions in angstrom. */
async function loadXyz(name: string, atoms: ReadonlyArray<readonly [string, number, number, number]>): Promise<void> {
  const text = `${atoms.length}\n${name}\n${atoms.map(([symbol, x, y, z]) => `${symbol} ${x.toFixed(12)} ${y.toFixed(12)} ${z.toFixed(12)}`).join('\n')}\n`;
  await lab.eval(`lab.commands.importText(${JSON.stringify(`${name}.xyz`)}, ${JSON.stringify(text)}, 'replace');`);
  await lab.settle(400);
  // The file must arrive exactly as written: the reference values below belong to these coordinates.
  const placed = await lab.atoms();
  expect(placed.length).toBe(atoms.length);
  placed.forEach((atom, i) => {
    const [, x, y, z] = atoms[i]!;
    [x, y, z].forEach((coordinate, k) => expect(Math.abs(atom.position[k]! - coordinate)).toBeLessThan(1e-10));
  });
}

interface Scf {
  converged: boolean;
  energy: number;
  orbitalEnergies: number[];
  homo: number;
  lumo: number | null;
  charges: number[];
  dipoleAu: number;
  dipoleDebye: number;
  nBasis: number;
  nElectrons: number;
  iterations: number;
}

/** Runs the calculation the way the button does and returns the numbers of the result on screen. */
async function calculate(): Promise<Scf | null> {
  const result = await lab.eval<Scf | null>(`
    return lab.quantum.runQuantum().then(() => {
      const record = lab.quantum.useQuantum.getState().record;
      if (!record || record.scene !== lab.lab.get().scene) return null;
      const r = record.result;
      return {
        converged: r.converged, energy: r.energy.total, orbitalEnergies: Array.from(r.orbitalEnergies), homo: r.homoIndex, lumo: r.lumoIndex,
        charges: [...r.mullikenCharges], dipoleAu: Math.hypot(...r.dipole.au), dipoleDebye: r.dipole.magnitudeDebye,
        nBasis: r.nBasis, nElectrons: r.nElectrons, iterations: r.iterations.length,
      };
    });`);
  await idle();
  return result;
}

interface Part {
  sign: number;
  area: number;
  volume: number;
  closed: boolean;
  triangles: number;
}

interface FieldInfo {
  kind: string;
  style: string;
  orbital: number | null;
  isoValue: number | null;
  parts: Part[];
  gridSpacing: number;
  potentialMin: number | null;
  potentialMax: number | null;
  potentialRange: number | null;
  dots: number | null;
  captured: number | null;
}

const fieldInfo = (): Promise<FieldInfo | null> => lab.eval('const i = lab.quantum.useQuantum.getState().fieldInfo; return i ? JSON.parse(JSON.stringify(i)) : null;');

interface Stage {
  surfaces: Array<{ id: string; vertices: number; triangles: number; color: string; colored: boolean; opacity: number; finish: string }>;
  slice: { center: number[]; u: number[]; v: number[]; width: number; height: number; columns: number; rows: number; neutral: number; contours: number } | null;
  cloud: { dots: number; signed: boolean; size: number; opacity: number } | null;
  cut: { normal: number[]; point: number[] } | null;
}

const stage = (): Promise<Stage> => lab.eval('return lab.stage();');

/*
 * The helium atom in STO-3G has a single basis function, so its Hartree-Fock orbital is that
 * function and its density is known in closed form: rho(r) = 2 phi(r)^2 with
 * phi(r) = sum_k d_k (2 a_k / pi)^(3/4) exp(-a_k r^2), r in bohr. Exponents and coefficients as
 * published (Hehre, Stewart and Pople, J. Chem. Phys. 51, 2657 (1969); Basis Set Exchange).
 */
const HE_EXPONENTS = [6.362421394, 1.158922999, 0.3136497915];
const HE_COEFFICIENTS = [0.1543289673, 0.5353281423, 0.4446345422];

function heliumDensity(rBohr: number): number {
  let phi = 0;
  for (let k = 0; k < 3; k++) phi += HE_COEFFICIENTS[k]! * (2 * HE_EXPONENTS[k]! / Math.PI) ** 0.75 * Math.exp(-HE_EXPONENTS[k]! * rBohr * rBohr);
  return 2 * phi * phi;
}

/** Radius in angstrom at which the helium density has fallen to `density` (e/bohr^3). */
function heliumRadius(density: number): number {
  let low = 0;
  let high = 12;
  for (let i = 0; i < 80; i++) {
    const middle = (low + high) / 2;
    if (heliumDensity(middle) > density) low = middle;
    else high = middle;
  }
  return ((low + high) / 2) * BOHR;
}

test.describe('Hartree-Fock in the browser', () => {
  test('compares two pinned computed states without changing the current molecule', async ({ page }) => {
    await loadXyz('hydrogen comparison', [['H', 0, 0, 0], ['H', 1.4 * BOHR, 0, 0]]);
    const first = await calculate();
    await page.getByRole('button', { name: 'Compute', exact: true }).click();
    await page.getByTestId('pin-quantum-view').click();
    await lab.eval('lab.actions.setAtomPosition(2, [1.05, 0, 0]);');
    const second = await calculate();
    expect(first?.converged).toBe(true);
    expect(second?.converged).toBe(true);
    expect(Math.abs(second!.energy - first!.energy)).toBeGreaterThan(0.001);
    const current = await lab.atoms();
    await page.getByTestId('pin-quantum-view').click();
    await page.getByTestId('open-quantum-comparison').click();
    const dialog = page.getByRole('dialog', { name: 'Compare electronic states', exact: true });
    await expect(dialog.getByTestId('quantum-comparison-view')).toHaveCount(2);
    await expect(dialog).toContainText(first!.energy.toFixed(8));
    await expect(dialog).toContainText(second!.energy.toFixed(8));
    await expect(dialog.getByTestId('quantum-energy-difference')).toContainText(((second!.energy - first!.energy) * 2625.4996394799).toFixed(3));
    const canvas = dialog.locator('canvas').first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('The comparison canvas did not render.');
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55, { steps: 8 });
    await page.mouse.up();
    expect(await lab.atoms()).toEqual(current);
    await dialog.getByRole('button', { name: /^Close/ }).click();
    expect(await lab.atoms()).toEqual(current);
  });

  test('reproduces the textbook result for H2, from the button to the read-out', async ({ page }) => {
    // Szabo and Ostlund, Modern Quantum Chemistry, section 3.5.2: STO-3G H2 at R = 1.4 bohr has
    // E = -1.1167 hartree and orbital energies -0.5782 and +0.6703 hartree.
    await loadXyz('hydrogen', [
      ['H', 0, 0, 0],
      ['H', 1.4 * BOHR, 0, 0],
    ]);
    await page.getByRole('button', { name: 'Compute' }).click();
    await expect(page.getByTestId('quantum-support')).toContainText('2 basis functions · 2 electrons');
    await page.getByTestId('quantum-run').click();
    await expect(page.getByTestId('quantum-status')).toHaveText('Converged');
    await idle();

    const energyText = (await page.getByTestId('quantum-energy').textContent())!;
    expect(energyText).toMatch(/Eh$/);
    expect(Number(energyText.replace('−', '-').replace(' Eh', ''))).toBeCloseTo(-1.1167, 4);
    await expect(page.getByTestId('quantum-homo')).toContainText('−0.5782 Eh');
    await expect(page.getByTestId('quantum-lumo')).toContainText('+0.6703 Eh');
    // 1.2485 hartree is 33.97 eV.
    await expect(page.getByTestId('quantum-gap')).toContainText('1.2485 Eh (33.97 eV)');
    // A homonuclear molecule has no dipole moment and no atomic charges.
    await expect(page.getByTestId('quantum-dipole')).toHaveText('0.000 D');

    // The bonding orbital is put on stage, with a legend that says what it is.
    await expect(page.getByTestId('legend-field')).toContainText('Orbital 1 · HOMO');
    await expect(page.getByTestId('legend-field')).toContainText('ψ = +0.05');
    let onStage = await stage();
    // It has one sign everywhere: there is no second lobe.
    expect(onStage.surfaces.map((s) => s.id)).toEqual(['field-positive']);

    // The antibonding orbital has two lobes of opposite sign that are mirror images of each other.
    await page.getByTestId('orbital-next').click();
    await idle();
    await expect(page.getByTestId('orbital-name')).toHaveText('Orbital 2 of 2 · LUMO');
    await expect(page.getByTestId('orbital-energy')).toContainText('empty');
    onStage = await stage();
    expect(onStage.surfaces.map((s) => s.id).sort()).toEqual(['field-negative', 'field-positive']);
    const info = (await fieldInfo())!;
    const [first, second] = info.parts as [Part, Part];
    expect(first.closed && second.closed).toBe(true);
    expect(Math.abs(first.volume - second.volume) / first.volume).toBeLessThan(0.002);
    expect(Math.abs(first.area - second.area) / first.area).toBeLessThan(0.002);
    // Each lobe lies entirely on its own side of the plane half-way between the nuclei.
    const sides = await lab.eval<number[][]>(`
      const middle = ${0.7 * BOHR};
      return lab.stageContents().surfaces.map((s) => {
        let below = 0, above = 0;
        for (let i = 0; i < s.positions.length; i += 3) s.positions[i] < middle ? below++ : above++;
        return [below, above];
      });`);
    expect(sides.every(([below, above]) => below === 0 || above === 0)).toBe(true);
    expect(sides[0]![0] === 0).not.toBe(sides[1]![0] === 0);
  });

  test('reproduces the published energy, dipole moment and charges of water', async () => {
    // Geometry and reference output of the Crawford group's Programming Project 3 (STO-3G water),
    // coordinates in bohr: E = -74.942079928192 hartree, dipole 0.603521296525 e a0,
    // Mulliken charges -0.253146052405 (O) and +0.126573026202 (H).
    await loadXyz('water', [
      ['O', 0, -0.143225816552 * BOHR, 0],
      ['H', 1.638036840407 * BOHR, 1.136548822547 * BOHR, 0],
      ['H', -1.638036840407 * BOHR, 1.136548822547 * BOHR, 0],
    ]);
    const scf = (await calculate())!;
    expect(scf.converged).toBe(true);
    expect(scf.nBasis).toBe(7);
    expect(scf.nElectrons).toBe(10);
    // The reference was computed with basis-set parameters rounded to 7-8 digits; 1e-6 hartree covers that.
    expect(Math.abs(scf.energy - -74.942079928192)).toBeLessThan(1e-6);
    expect(Math.abs(scf.dipoleAu - 0.603521296525)).toBeLessThan(1e-5);
    expect(Math.abs(scf.dipoleDebye - 0.603521296525 * DEBYE_PER_AU)).toBeLessThan(1e-4);
    expect(Math.abs(scf.charges[0]! - -0.253146052405)).toBeLessThan(1e-5);
    expect(Math.abs(scf.charges[1]! - 0.126573026202)).toBeLessThan(1e-5);
    expect(Math.abs(scf.charges[2]! - 0.126573026202)).toBeLessThan(1e-5);
    // Five doubly occupied orbitals out of seven.
    expect(scf.homo).toBe(4);
    expect(scf.lumo).toBe(5);
  });

  test('says why it cannot treat a radical, a heavy element or a structure that is too large', async ({ page }) => {
    await lab.openExample('water');
    await page.getByRole('button', { name: 'Compute' }).click();
    await expect(page.getByTestId('quantum-run')).toBeEnabled();

    // OH: nine electrons, an open shell.
    const hydrogen = (await lab.atoms()).find((a) => a.z === 1)!;
    await lab.eval(`lab.actions.eraseAtoms([${hydrogen.id}]);`);
    await expect(page.getByTestId('quantum-unsupported')).toBeVisible();
    await expect(page.getByTestId('inspector')).toContainText('odd number of electrons (9)');
    await expect(page.getByTestId('quantum-run')).toBeDisabled();
    expect(await calculate()).toBeNull();
    expect(await lab.eval<string>('return lab.quantum.useQuantum.getState().problem.details.join(" ");')).toContain('open-shell');

    // Iron: no basis set beyond argon. The atom concerned is named the way the interface names atoms, and selected.
    await lab.openExample('water');
    const oxygen = (await lab.atoms()).find((a) => a.z === 8)!;
    await lab.eval(`lab.actions.changeElement([${oxygen.id}], 26);`);
    await expect(page.getByTestId('inspector')).toContainText(`Unsupported element (Z = 26) at Fe${oxygen.id}`);
    expect(await calculate()).toBeNull();
    expect((await lab.summary()).selectedAtoms).toEqual([oxygen.id]);

    // Caffeine and aspirin together need 153 basis functions; the limit is 96.
    await lab.openExample('caffeine');
    await lab.eval("lab.actions.addExample('aspirin');");
    await expect(page.getByTestId('inspector')).toContainText('needs 153 basis functions, more than the limit of 96');
    await expect(page.getByTestId('quantum-run')).toBeDisabled();
    // Nothing was put on stage by any of the refusals.
    expect((await stage()).surfaces).toEqual([]);
    await expect(page.getByTestId('field-legend')).toHaveCount(0);
  });

  test('can be cancelled while it runs, and the view keeps moving meanwhile', async ({ page }) => {
    // Caffeine: 80 basis functions, several seconds of work.
    await page.getByRole('button', { name: 'Compute' }).click();
    await expect(page.getByTestId('quantum-support')).toContainText('80 basis functions · 102 electrons');
    await page.getByTestId('quantum-run').click();
    await expect(page.getByTestId('quantum-running')).toBeVisible();

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
    test.info().annotations.push({ type: 'frame pacing during the SCF calculation', description: JSON.stringify(pacing) });
    expect(pacing.frames).toBeGreaterThan(20);
    expect(pacing.longestGapMs).toBeLessThan(250);

    const poseBefore = await lab.pose();
    const empty = await lab.emptyPoint();
    await lab.drag(empty, [empty[0] + 90, empty[1] + 40]);
    expect(await lab.pose()).not.toBe(poseBefore);
    expect(await lab.eval<boolean>('return lab.quantum.useQuantum.getState().running;'), 'the calculation finished before it could be cancelled').toBe(true);

    await page.getByTestId('quantum-cancel').click();
    await expect(page.getByTestId('quantum-running')).toHaveCount(0);
    await expect(page.getByTestId('quantum-result')).toHaveCount(0);
    expect(await lab.eval<string>('return lab.jobs.useJobs.getState().jobs[0].status;')).toBe('cancelled');
    expect(await lab.eval<unknown>('return lab.quantum.useQuantum.getState().record;')).toBeNull();
    expect(await lab.eval<unknown>('return lab.quantum.useQuantum.getState().problem;')).toBeNull();

    // The engine is usable again at once.
    await lab.openExample('water');
    expect((await calculate())!.converged).toBe(true);
  });

  test('withdraws the result and everything drawn from it as soon as the structure changes', async ({ page }) => {
    await lab.openExample('water');
    await page.getByRole('button', { name: 'Compute' }).click();
    expect((await calculate())!.converged).toBe(true);
    await lab.eval("lab.quantum.setSlice({ enabled: true, field: 'density' });");
    await idle();
    let onStage = await stage();
    expect(onStage.surfaces.length).toBe(2);
    expect(onStage.slice).not.toBeNull();
    await expect(page.getByTestId('field-legend')).toBeVisible();

    const hydrogen = (await lab.atoms()).find((a) => a.z === 1)!;
    await lab.eval(`lab.actions.setAtomPosition(${hydrogen.id}, [1.1, -0.4, 0.2]);`);
    await expect(page.getByTestId('quantum-stale')).toBeVisible();
    await expect(page.getByTestId('quantum-result')).toHaveCount(0);
    await expect(page.getByTestId('field-legend')).toHaveCount(0);
    onStage = await stage();
    expect(onStage.surfaces).toEqual([]);
    expect(onStage.slice).toBeNull();
    expect(onStage.cloud).toBeNull();

    // A new calculation for the new geometry brings the same views back, now for that geometry.
    const again = (await calculate())!;
    expect(again.converged).toBe(true);
    onStage = await stage();
    expect(onStage.surfaces.length).toBe(2);
    expect(onStage.slice).not.toBeNull();
  });

  test('explains the calculation with its own numbers and says what is drawn from it', async ({ page }) => {
    await lab.openExample('water');
    await page.getByRole('button', { name: 'Compute' }).click();
    const scf = (await calculate())!;
    expect(scf.converged).toBe(true);
    await page.getByTestId('explain-electrons').click();
    const explanation = page.getByTestId('explanation-electrons');
    await expect(explanation).toBeVisible();
    for (const heading of ['Objective', 'Starting point and conditions', 'Method', 'Model', 'Assumptions', 'Result', 'What is drawn', 'Convergence', 'Confidence and uncertainty', 'Why the real molecule may differ', 'Sources']) {
      await expect(explanation.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    }
    const minus = (text: string) => text.replace('-', '−');
    await expect(explanation).toContainText(`Converged in ${scf.iterations} iterations`);
    await expect(explanation).toContainText(`Total energy ${minus(scf.energy.toFixed(6))} Eh`);
    await expect(explanation).toContainText(`Dipole moment ${scf.dipoleDebye.toFixed(3)} D`);
    await expect(explanation).toContainText('3 nuclei at the positions drawn, a net charge of zero, and therefore 10 electrons');
    await expect(explanation).toContainText('doi:10.1103/RevModPhys.23.69');

    // The first result is shown as its highest occupied orbital, and the explanation says so with that orbital's energy.
    await expect(explanation).toContainText(`On stage: HOMO (orbital ${scf.homo + 1} of ${scf.nBasis}, energy ${minus(scf.orbitalEnergies[scf.homo]!.toFixed(4))} Eh`);
    await expect(explanation).toContainText('It holds two electrons.');
    await lab.eval(`lab.quantum.setField({ orbital: ${scf.lumo} });`);
    await idle();
    await expect(explanation).toContainText(`On stage: LUMO (orbital ${scf.lumo! + 1} of ${scf.nBasis}, energy +${scf.orbitalEnergies[scf.lumo!]!.toFixed(4)} Eh`);
    await expect(explanation).toContainText('It is empty in this state');

    // A dot cloud of the density: the explanation reports how many electrons the sampled volume holds.
    await lab.eval("lab.quantum.setField({ kind: 'density', style: 'cloud', dots: 20000 });");
    await idle();
    const captured = (await fieldInfo())!.captured!;
    expect(Math.abs(captured - 10)).toBeLessThan(0.05);
    await expect(explanation).toContainText(`the density amounts to ${captured.toFixed(2)} electrons out of 10`);
    await expect(explanation).toContainText('they are not electrons');

    // The potential on the density surface, with the extremes actually found on it.
    await lab.eval("lab.quantum.setField({ kind: 'potential' });");
    await idle();
    const info = (await fieldInfo())!;
    const signed = (value: number) => (value > 0 ? '+' : '') + minus(value.toFixed(3));
    await expect(explanation).toContainText(`On this surface the potential runs from ${signed(info.potentialMin!)} to ${signed(info.potentialMax!)} Eh/e`);

    // The selected atom is reported with its own charge.
    const oxygen = (await lab.atoms()).find((a) => a.z === 8)!;
    const index = await lab.eval<number>(`return lab.quantum.useQuantum.getState().record.atomIds.indexOf(${oxygen.id});`);
    expect(index).toBeGreaterThanOrEqual(0);
    await lab.eval(`lab.actions.selectOnly([${oxygen.id}]);`);
    await expect(explanation).toContainText(`Selected atom: O (atom ${oxygen.id}) has a Mulliken charge of ${signed(scf.charges[index]!)} e`);

    // Nothing on stage, nothing claimed about it; and an edited structure has no explanation of the old result.
    await lab.eval("lab.quantum.setField({ kind: 'off' });");
    await expect(explanation.getByRole('heading', { name: 'What is drawn', exact: true })).toHaveCount(0);
    await lab.eval(`lab.actions.setAtomPosition(${oxygen.id}, [0.1, 0.1, 0.2]);`);
    await expect(explanation).toHaveCount(0);
    await expect(page.getByTestId('explanation')).toBeVisible();
  });
});

test.describe('fields derived from the wavefunction', () => {
  test('the density surface and the cutting plane of helium match the closed-form density', async () => {
    await loadXyz('helium', [['He', 0, 0, 0]]);
    const scf = (await calculate())!;
    expect(scf.nBasis).toBe(1);
    // Published STO-3G energy of the helium atom: -2.8077839566 hartree (also PySCF, see the engine's README).
    expect(Math.abs(scf.energy - -2.8077839566)).toBeLessThan(1e-8);

    for (const isoValue of [0.002, 0.05]) {
      await lab.eval(`lab.quantum.setField({ kind: 'density', style: 'surface', densityIso: ${isoValue} });`);
      await idle();
      const info = (await fieldInfo())!;
      expect(info.isoValue).toBe(isoValue);
      // The sphere on which the analytic density equals the isovalue.
      const radius = heliumRadius(isoValue);
      const h = info.gridSpacing;
      const [part] = info.parts as [Part];
      expect(part.closed).toBe(true);

      // Vertices are placed by linear interpolation of log(rho) along grid edges. For a Gaussian, log(rho) is
      // quadratic with the same curvature in every direction, which bounds the radial error of a vertex by
      // h^2 / (8 R). That is 0.002 to 0.004 angstrom here.
      const worst = await lab.eval<number>(`
        const p = lab.stageContents().surfaces[0].positions;
        let worst = 0;
        for (let i = 0; i < p.length; i += 3) worst = Math.max(worst, Math.abs(Math.hypot(p[i], p[i + 1], p[i + 2]) - ${radius}));
        return worst;`);
      expect(worst, `vertex distance from the sphere at ${isoValue}`).toBeLessThan((1.1 * h * h) / (8 * radius) + 5e-5);

      // A mesh of flat triangles whose corners lie on (or just inside) a sphere has less area and encloses less
      // volume than the sphere, by amounts that scale with (h / R)^2. Measured on this engine over a tenfold
      // range of (h / R)^2: 0.28 to 0.39 of it for the area and 0.54 to 0.71 for the volume.
      const scale = (h / radius) ** 2;
      const areaDeficit = 1 - part.area / (4 * Math.PI * radius ** 2);
      const volumeDeficit = 1 - part.volume / ((4 / 3) * Math.PI * radius ** 3);
      test.info().annotations.push({ type: `helium surface at ${isoValue} e/a0^3`, description: `area ${(areaDeficit * 100).toFixed(2)} % low, volume ${(volumeDeficit * 100).toFixed(2)} % low, worst vertex ${worst.toExponential(2)} A` });
      expect(areaDeficit / scale, `area at ${isoValue}`).toBeGreaterThan(0.2);
      expect(areaDeficit / scale, `area at ${isoValue}`).toBeLessThan(0.45);
      expect(volumeDeficit / scale, `volume at ${isoValue}`).toBeGreaterThan(0.45);
      expect(volumeDeficit / scale, `volume at ${isoValue}`).toBeLessThan(0.8);
    }

    // The plane: every sample equals the analytic density at its own position.
    await lab.eval("lab.quantum.setSlice({ enabled: true, field: 'density', axis: 'z', offset: 0.3 });");
    await idle();
    const plane = await lab.eval<{ center: number[]; u: number[]; v: number[]; width: number; height: number; columns: number; rows: number; values: number[] }>(`
      const s = lab.quantum.fieldSnapshot().slice;
      return { center: [...s.center], u: [...s.u], v: [...s.v], width: s.width, height: s.height, columns: s.columns, rows: s.rows, values: Array.from(s.values) };`);
    expect(plane.center[2]).toBeCloseTo(0.3, 12);
    let compared = 0;
    let worstRelative = 0;
    for (let row = 0; row < plane.rows; row += 7) {
      for (let column = 0; column < plane.columns; column += 7) {
        const a = (column / (plane.columns - 1) - 0.5) * plane.width;
        const b = (row / (plane.rows - 1) - 0.5) * plane.height;
        const point = [0, 1, 2].map((k) => plane.center[k]! + a * plane.u[k]! + b * plane.v[k]!);
        const expected = heliumDensity(Math.hypot(point[0]!, point[1]!, point[2]!) / BOHR);
        if (expected < 1e-7) continue;
        compared++;
        worstRelative = Math.max(worstRelative, Math.abs(plane.values[column + plane.columns * row]! / expected - 1));
      }
    }
    expect(compared).toBeGreaterThan(100);
    // Single-precision transport of the values; the engine's own contraction is normalised to 1e-7.
    expect(worstRelative).toBeLessThan(2e-5);
  });

  test('the highest occupied orbital of water changes sign across the molecular plane', async () => {
    // The built-in water lies in the plane z = 0. Its HOMO (1b1) is the oxygen 2p orbital perpendicular to it.
    await lab.openExample('water');
    expect((await lab.atoms()).every((a) => a.position[2] === 0)).toBe(true);
    const scf = (await calculate())!;
    expect(scf.homo).toBe(4);
    const info = (await fieldInfo())!;
    expect(info.kind).toBe('orbital');
    expect(info.orbital).toBe(4);
    const [first, second] = info.parts as [Part, Part];
    expect(first.sign * second.sign).toBe(-1);
    expect(first.closed && second.closed).toBe(true);
    expect(Math.abs(first.volume - second.volume) / first.volume).toBeLessThan(0.002);
    const sides = await lab.eval<Array<{ id: string; above: number; below: number }>>(`
      return lab.stageContents().surfaces.map((s) => {
        let above = 0, below = 0;
        for (let i = 2; i < s.positions.length; i += 3) s.positions[i] > 0 ? above++ : below++;
        return { id: s.id, above, below };
      });`);
    for (const side of sides) expect(side.above === 0 || side.below === 0, `${side.id} stays on one side`).toBe(true);
    expect(sides[0]!.above === 0).not.toBe(sides[1]!.above === 0);

    // The same orbital as a dot cloud: the dots are drawn from |psi|^2, so both signs get half of them, each on its side.
    await lab.eval("lab.quantum.setField({ style: 'cloud', dots: 20000 });");
    await idle();
    const cloud = await lab.eval<{ dots: number; positive: number; wrongSide: number; captured: number }>(`
      const c = lab.stageContents().cloud;
      const sign = Math.sign(${sides[0]!.above > 0 ? 1 : -1} * (${JSON.stringify(sides[0]!.id)} === 'field-positive' ? 1 : -1));
      let positive = 0, wrongSide = 0;
      for (let i = 0; i < c.signs.length; i++) {
        if (c.signs[i] > 0) positive++;
        // Dots are placed within the grid cell they were drawn in, so only dots clear of the plane are judged.
        const z = c.positions[3 * i + 2];
        if (Math.abs(z) > 0.15 && Math.sign(z) !== sign * c.signs[i]) wrongSide++;
      }
      return { dots: c.signs.length, positive, wrongSide, captured: lab.quantum.useQuantum.getState().fieldInfo.captured };`);
    expect(cloud.dots).toBe(20000);
    expect(cloud.wrongSide).toBe(0);
    expect(Math.abs(cloud.positive / cloud.dots - 0.5)).toBeLessThan(0.01);
    // An orbital is normalised: the sampled box holds all of it, to the accuracy of summing on the grid.
    expect(Math.abs(cloud.captured - 1)).toBeLessThan(0.01);
    expect((await stage()).surfaces).toEqual([]);
  });

  test('a dot cloud of the density accounts for every electron, sharp cores included', async () => {
    // The sum over the sampling grid must find all the electrons. That is the hard part near heavy nuclei,
    // where the core density is far narrower than a grid cell; hydrogen chloride has a chlorine 1s core
    // only a few hundredths of an angstrom wide.
    await loadXyz('hydrogen chloride', [
      ['Cl', 0, 0, 0],
      ['H', 1.2746, 0, 0],
    ]);
    const scf = (await calculate())!;
    expect(scf.nElectrons).toBe(18);
    await lab.eval("lab.quantum.setField({ kind: 'density', style: 'cloud', dots: 30000 });");
    await idle();
    const info = (await fieldInfo())!;
    expect(info.style).toBe('cloud');
    expect(info.dots).toBe(30000);
    expect(Math.abs(info.captured! / 18 - 1)).toBeLessThan(0.005);
    // The ten core electrons of chlorine (1s, 2s, 2p) sit within about 0.4 angstrom of the nucleus; the
    // dots there are that share of all dots. A minimal-basis density has 10.0 to 10.9 electrons in that sphere.
    const near = await lab.eval<number>(`
      const p = lab.stageContents().cloud.positions;
      let near = 0;
      for (let i = 0; i < p.length; i += 3) if (Math.hypot(p[i], p[i + 1], p[i + 2]) < 0.4) near++;
      return near;`);
    const electronsNear = (near / 30000) * info.captured!;
    test.info().annotations.push({ type: 'electrons within 0.4 A of the chlorine nucleus', description: electronsNear.toFixed(2) });
    expect(electronsNear).toBeGreaterThan(9.6);
    expect(electronsNear).toBeLessThan(11.2);
    await expect(lab.page.getByTestId('legend-field')).toContainText('30,000 dots');
  });

  test('the electrostatic potential has the right far-field limits, sign and units', async () => {
    // Far from an ion the potential is that of its net charge: q / r in atomic units.
    await lab.openExample('ammonium');
    const ion = (await calculate())!;
    expect(ion.nElectrons).toBe(10);
    const far = await lab.eval<number[]>(`
      const record = lab.quantum.useQuantum.getState().record;
      return lab.qm.fields.slice({ wavefunction: { id: record.id, result: record.result, input: record.input }, field: { kind: 'esp' },
        center: [30, 0, 0], u: [0, 1, 0], v: [0, 0, 1], width: 0.2, height: 0.2, columns: 2, rows: 2 }).then((r) => Array.from(r.values));`);
    const distance = Math.hypot(30, 0.1, 0.1) / BOHR;
    for (const value of far) expect(Math.abs(value * distance - 1)).toBeLessThan(1e-4);

    // Far from a neutral polar molecule it is that of its dipole: mu cos(theta) / r^2, positive towards the positive end.
    await lab.openExample('water');
    const scf = (await calculate())!;
    const dipole = await lab.eval<{ direction: number[]; magnitude: number; alongDipole: number; against: number }>(`
      const record = lab.quantum.useQuantum.getState().record;
      const mu = record.result.dipole.au;
      const magnitude = Math.hypot(...mu);
      const direction = mu.map((c) => c / magnitude);
      // Any two unit vectors that span a small square around the far point will do.
      const u = [direction[1], -direction[0], 0];
      const norm = Math.hypot(...u);
      const wavefunction = { id: record.id, result: record.result, input: record.input };
      const at = (sign) => lab.qm.fields.slice({ wavefunction, field: { kind: 'esp' }, center: direction.map((c) => sign * 60 * c),
        u: u.map((c) => c / norm), v: [0, 0, 1], width: 0.02, height: 0.02, columns: 2, rows: 2 }).then((r) => r.values[0]);
      return Promise.all([at(1), at(-1)]).then(([alongDipole, against]) => ({ direction, magnitude, alongDipole, against }));`);
    expect(dipole.magnitude).toBeCloseTo(scf.dipoleAu, 10);
    const expected = dipole.magnitude / (60 / BOHR) ** 2;
    expect(dipole.alongDipole).toBeGreaterThan(0);
    expect(dipole.against).toBeLessThan(0);
    // The next multipole (the quadrupole) contributes a few per cent at this distance.
    expect(Math.abs(dipole.alongDipole / expected - 1)).toBeLessThan(0.05);
    expect(Math.abs(-dipole.against / expected - 1)).toBeLessThan(0.05);

    // On the molecule's surface: most negative behind the oxygen (the lone pairs), most positive at the hydrogens.
    await lab.eval("lab.quantum.setField({ kind: 'potential' });");
    await idle();
    const info = (await fieldInfo())!;
    expect(info.kind).toBe('potential');
    expect(info.potentialMin!).toBeLessThan(-0.03);
    expect(info.potentialMax!).toBeGreaterThan(0.03);
    // The colour scale is symmetric about zero and wide enough for both extremes.
    expect(info.potentialRange!).toBeGreaterThanOrEqual(Math.max(-info.potentialMin!, info.potentialMax!));
    const atoms = await lab.atoms();
    const oxygen = atoms.find((a) => a.z === 8)!.position;
    const hydrogens = atoms.filter((a) => a.z === 1).map((a) => a.position);
    const extremes = await lab.eval<{ min: number[]; max: number[] }>(`
      const { positions, values } = lab.quantum.fieldSnapshot().potential;
      let lowest = 0, highest = 0;
      for (let i = 1; i < values.length; i++) { if (values[i] < values[lowest]) lowest = i; if (values[i] > values[highest]) highest = i; }
      return { min: Array.from(positions.slice(3 * lowest, 3 * lowest + 3)), max: Array.from(positions.slice(3 * highest, 3 * highest + 3)) };`);
    const middle = [0, 1, 2].map((k) => (hydrogens[0]![k]! + hydrogens[1]![k]!) / 2);
    const towardsHydrogens = middle.map((c, k) => c - oxygen[k]!);
    const fromOxygen = (point: number[]) => point.map((c, k) => c - oxygen[k]!);
    const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    expect(dot(fromOxygen(extremes.min), towardsHydrogens)).toBeLessThan(0);
    expect(dot(fromOxygen(extremes.max), towardsHydrogens)).toBeGreaterThan(0);
    const nearestHydrogen = Math.min(...hydrogens.map((h) => Math.hypot(...extremes.max.map((c, k) => c - h[k]!))));
    expect(nearestHydrogen).toBeLessThan(Math.hypot(...fromOxygen(extremes.max)));
    // The surface on stage carries one colour per vertex and is matte, so that the hue is not confused by reflections.
    const [surface] = (await stage()).surfaces;
    expect(surface).toMatchObject({ id: 'field-potential', colored: true, finish: 'matte' });
  });

  test('the legend shows the colours the cutting plane is drawn in', async ({ page }) => {
    await loadXyz('helium', [['He', 0, 0, 0]]);
    expect((await calculate())!.converged).toBe(true);
    // Only the plane, facing the camera, at full size in the middle of the view.
    await lab.eval("lab.quantum.setField({ kind: 'off' }); lab.quantum.setSlice({ enabled: true, field: 'density', axis: 'z', offset: 0 }); lab.viewApi.setStandardView('front');");
    await idle();
    await lab.settle(900);
    await expect(page.getByTestId('legend-plane-scale')).toBeVisible();

    // Points on the plane half-way between two contour lines, well away from the atom drawn in the middle.
    const samples = [0.25, 0.42].map((position) => {
      const density = 10 ** (-3 + 3 * position);
      return { position, radius: heliumRadius(density) };
    });
    const measured = await lab.eval<Array<{ position: number; drawn: number[]; legend: number[] }>>(`
      const samples = ${JSON.stringify(samples)};
      return lab.viewApi.capture(4096).then((url) => new Promise((resolve) => {
        const image = new Image();
        image.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0);
          const view = document.querySelector('.ml-viewport').getBoundingClientRect();
          resolve(samples.map(({ position, radius }) => {
            // Four points around the atom at that radius, averaged over 3 x 3 pixels each.
            const sum = [0, 0, 0];
            let count = 0;
            for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
              const [x, y] = lab.viewApi.project([dx * radius * Math.SQRT1_2, dy * radius * Math.SQRT1_2, 0]);
              const px = Math.round(x / view.width * image.width), py = Math.round(y / view.height * image.height);
              const data = context.getImageData(px - 1, py - 1, 3, 3).data;
              for (let i = 0; i < data.length; i += 4) { sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2]; count++; }
            }
            const legend = lab.colormap.displayColor(lab.colormap.SCALE_DENSITY.at(position)).map((c) => c * 255);
            return { position, drawn: sum.map((c) => c / count), legend };
          }));
        };
        image.src = url;
      }));`);
    for (const sample of measured) {
      test.info().annotations.push({ type: `plane colour at scale position ${sample.position}`, description: `drawn ${sample.drawn.map((c) => c.toFixed(0)).join(' ')} · legend ${sample.legend.map((c) => c.toFixed(0)).join(' ')}` });
      for (let channel = 0; channel < 3; channel++) expect(Math.abs(sample.drawn[channel]! - sample.legend[channel]!), `channel ${channel} at ${sample.position}`).toBeLessThan(10);
    }
    // The two samples are different colours, so the agreement is not an accident of a flat image.
    expect(Math.hypot(...measured[0]!.drawn.map((c, i) => c - measured[1]!.drawn[i]!))).toBeGreaterThan(25);
  });

  test('the cutting plane follows its controls and can cut the surfaces open', async ({ page }) => {
    await lab.openExample('water');
    await page.getByRole('button', { name: 'Compute' }).click();
    expect((await calculate())!.converged).toBe(true);
    await page.getByTestId('plane-toggle').click();
    await idle();
    let onStage = await stage();
    expect(onStage.slice).not.toBeNull();
    expect(onStage.cut).toBeNull();
    // Through the middle of the molecule, perpendicular to z, with a margin around the nuclei.
    const atoms = await lab.atoms();
    const span = (k: number) => Math.max(...atoms.map((a) => a.position[k]!)) - Math.min(...atoms.map((a) => a.position[k]!));
    expect(onStage.slice!.center[2]).toBeCloseTo(0, 12);
    expect(onStage.slice!.width).toBeCloseTo(span(0) + 5.6, 6);
    expect(onStage.slice!.height).toBeCloseTo(span(1) + 5.6, 6);
    await expect(page.getByTestId('legend-plane')).toContainText('electron density');
    await expect(page.getByTestId('plane-info')).toContainText('points');

    await lab.eval('lab.quantum.setSlice({ offset: 0.6 });');
    await idle();
    onStage = await stage();
    expect(onStage.slice!.center[2]).toBeCloseTo(0.6, 12);

    await page.getByTestId('plane-cut').click();
    onStage = await stage();
    expect(onStage.cut).toEqual({ normal: [0, 0, 1], point: onStage.slice!.center });
    await page.getByTestId('plane-flip').click();
    expect((await stage()).cut!.normal).toEqual([-0, -0, -1]);

    // Through three chosen atoms: here all three atoms, so the plane is the molecular plane again.
    await lab.eval(`lab.actions.selectOnly([${atoms.map((a) => a.id).join(', ')}]); lab.quantum.sliceThroughSelection();`);
    await idle();
    onStage = await stage();
    const normal = [0, 1, 2].map((k) => onStage.slice!.u[(k + 1) % 3]! * onStage.slice!.v[(k + 2) % 3]! - onStage.slice!.u[(k + 2) % 3]! * onStage.slice!.v[(k + 1) % 3]!);
    expect(Math.abs(normal[2]!)).toBeCloseTo(1, 10);
    for (const atom of atoms) expect(Math.abs(atom.position[2]! - onStage.slice!.center[2]!)).toBeLessThan(1e-9);

    await page.getByTestId('plane-toggle').click();
    onStage = await stage();
    expect(onStage.slice).toBeNull();
    expect(onStage.cut).toBeNull();
    await expect(page.getByTestId('legend-plane')).toHaveCount(0);
  });
});

test.describe('molecular surfaces', () => {
  /** Area and volume of the union of two spheres of radius r whose centres are d apart (d < 2r). */
  function twoSpheres(r: number, d: number): { area: number; volume: number } {
    const cap = r - d / 2;
    return { area: 2 * (4 * Math.PI * r * r - 2 * Math.PI * r * cap), volume: 2 * ((4 / 3) * Math.PI * r ** 3 - (Math.PI * cap * cap * (3 * r - cap)) / 3) };
  }

  const surfaceInfo = (): Promise<{ kind: string; probe: number; area: number; volume: number; closed: boolean; gridSpacing: number; atoms: number } | null> =>
    lab.eval('const i = lab.quantum.useQuantum.getState().molecularInfo; return i ? { ...i } : null;');

  test('are the spheres they are defined as, in area and volume', async ({ page }) => {
    // Van der Waals radii as tabulated (Bondi 1964, as listed by PubChem): H 1.20, He 1.40 angstrom.
    await loadXyz('helium', [['He', 0, 0, 0]]);
    await page.getByRole('button', { name: 'Compute' }).click();
    await page.getByTestId('surface-toggle').click();
    await idle();
    let info = (await surfaceInfo())!;
    expect(info.closed).toBe(true);
    expect(Math.abs(info.area / (4 * Math.PI * 1.4 ** 2) - 1)).toBeLessThan(0.004);
    expect(Math.abs(info.volume / ((4 / 3) * Math.PI * 1.4 ** 3) - 1)).toBeLessThan(0.006);
    await expect(page.getByTestId('legend-molecular')).toContainText('Van der Waals surface');
    // Shown to three significant figures: a measurement on a triangle mesh supports no more.
    await expect(page.getByTestId('surface-area')).toHaveText(`${Number(info.area.toPrecision(3))} Å²`);

    // Rolling a 1.4 angstrom probe over it gives a sphere of twice the radius.
    await lab.eval("lab.quantum.setMolecular({ kind: 'sas' });");
    await idle();
    info = (await surfaceInfo())!;
    expect(info.probe).toBe(1.4);
    expect(Math.abs(info.area / (4 * Math.PI * 2.8 ** 2) - 1)).toBeLessThan(0.004);
    expect(Math.abs(info.volume / ((4 / 3) * Math.PI * 2.8 ** 3) - 1)).toBeLessThan(0.006);
    await expect(page.getByTestId('legend-molecular')).toContainText('Solvent-accessible surface');

    // Two overlapping spheres: H2 at 0.74 angstrom.
    await loadXyz('hydrogen', [
      ['H', 0, 0, 0],
      ['H', 0.74, 0, 0],
    ]);
    await lab.eval("lab.quantum.setMolecular({ kind: 'vdw' });");
    await idle();
    info = (await surfaceInfo())!;
    const expected = twoSpheres(1.2, 0.74);
    expect(info.atoms).toBe(2);
    expect(Math.abs(info.area / expected.area - 1)).toBeLessThan(0.006);
    expect(Math.abs(info.volume / expected.volume - 1)).toBeLessThan(0.008);
  });

  test('ray-marches computed volume samples, preserves their units, and removes the volume after an edit', async ({ page }) => {
    await loadXyz('helium-volume', [['He', 0, 0, 0]]);
    expect((await calculate())?.converged).toBe(true);
    await lab.eval("lab.lab.set({ ambientMotion: false, quality: 'efficient', inspectorOpen: true, inspectorTab: 'compute' }); lab.quantum.setField({ kind: 'off' });");
    await lab.ready();
    await lab.eval("lab.viewApi.setStandardView('front');");
    await lab.settle(700);
    const sampledPixel = () => lab.eval<number[]>(`
      return lab.viewApi.capture(4096).then(async (url) => {
        if (!url) throw new Error('No rendered frame was captured.');
        const image = await createImageBitmap(await (await fetch(url)).blob());
        const canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('No image reader is available.');
        context.drawImage(image, 0, 0);
        const rect = document.querySelector('.ml-viewport canvas').getBoundingClientRect();
        const p = lab.viewApi.project([0.7, 0, 0]);
        const x = Math.round(p[0] * image.width / rect.width);
        const y = Math.round(p[1] * image.height / rect.height);
        const color = Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3);
        image.close();
        return color;
      });`);
    const background = await sampledPixel();
    await page.getByRole('group', { name: 'Field on stage', exact: true }).getByRole('button', { name: 'Density', exact: true }).click();
    await page.getByRole('group', { name: 'How the field is drawn' }).getByRole('button', { name: 'Volume', exact: true }).click();
    await idle();
    expect(await fieldInfo()).toMatchObject({ style: 'volume', kind: 'density', parts: [] });
    expect(await lab.eval('return lab.quantum.useQuantum.getState().fieldError;')).toBeNull();
    const uploaded = await lab.eval<{ samples: number; dimensions: number[] }>('return lab.stage().volume;');
    expect(uploaded.samples).toBe(uploaded.dimensions.reduce((a, b) => a * b, 1));
    const pixels = await sampledPixel();
    expect(pixels.reduce((sum, value, i) => sum + Math.abs(value - background[i]!), 0)).toBeGreaterThan(15);
    const grid = await lab.eval<Array<{ r: number; value: number }>>(`
      const record = lab.quantum.currentRecord();
      return lab.qm.fields.volume({ wavefunction: { id: record.id, input: record.input, result: record.result }, field: { kind: 'density' },
        grid: { spacing: 0.18, padding: 3, maxPoints: 500000 } }).then(({values, grid}) => {
          const [nx, ny, nz] = grid.dims;
          const y = Math.floor(ny/2), z = Math.floor(nz/2);
          return [Math.floor(nx/2), Math.floor(nx/2)+2, Math.floor(nx/2)+5].map((x) => ({
            r: Math.hypot(grid.origin[0]+x*grid.spacing[0],grid.origin[1]+y*grid.spacing[1],grid.origin[2]+z*grid.spacing[2]),
            value: values[x+nx*(y+ny*z)]
          }));
        });`);
    for (const point of grid) {
      const expected = heliumDensity(point.r / BOHR);
      expect(Math.abs(point.value - expected)).toBeLessThan(Math.max(1e-7, expected * 1e-5));
    }
    await lab.eval("lab.actions.setAtomPosition(1, [0.2, 0, 0]);");
    await idle();
    expect(await lab.eval('return lab.stage().volume;')).toBeNull();
  });

  test('are rebuilt when the structure is edited and coloured by the atom underneath', async () => {
    await lab.openExample('water');
    await lab.eval("lab.quantum.setMolecular({ enabled: true, kind: 'vdw', coloring: 'element' });");
    await idle();
    const before = (await surfaceInfo())!;
    let [surface] = (await stage()).surfaces;
    expect(surface).toMatchObject({ id: 'molecular', colored: true, finish: 'matte' });

    // Each vertex takes the colour of the atom whose sphere it lies on: the nearest atom, measured from its sphere.
    const mismatches = await lab.eval<number>(`
      const s = lab.stageContents().surfaces[0];
      const atoms = lab.atoms();
      const radius = { 1: 1.2, 8: 1.52 };
      // Oxygen is red in the CPK scheme; hydrogen is white. In linear light red has almost no green.
      let wrong = 0;
      for (let i = 0; i < s.positions.length / 3; i++) {
        let best = null, bestValue = -Infinity;
        for (const a of atoms) {
          const value = radius[a.z] - Math.hypot(s.positions[3 * i] - a.position[0], s.positions[3 * i + 1] - a.position[1], s.positions[3 * i + 2] - a.position[2]);
          if (value > bestValue) { bestValue = value; best = a; }
        }
        const isRed = s.colors[3 * i + 1] < 0.2;
        if (isRed !== (best.z === 8)) wrong++;
      }
      return wrong;`);
    expect(mismatches).toBe(0);

    // Pull one hydrogen 3 angstrom away: its sphere separates, so the area grows towards that of separate spheres.
    const hydrogen = (await lab.atoms()).find((a) => a.z === 1)!;
    await lab.eval(`lab.actions.setAtomPosition(${hydrogen.id}, [4.5, 0, 0]);`);
    expect((await stage()).surfaces, 'the old surface leaves at once').toEqual([]);
    await lab.settle(400);
    await idle();
    const after = (await surfaceInfo())!;
    [surface] = (await stage()).surfaces;
    expect(surface!.id).toBe('molecular');
    expect(after.area).toBeGreaterThan(before.area + 5);

    // One colour instead: no per-vertex colours, and the glassy finish.
    await lab.eval("lab.quantum.setMolecular({ coloring: 'plain' });");
    [surface] = (await stage()).surfaces;
    expect(surface).toMatchObject({ colored: false, finish: 'glass' });

    await lab.eval('lab.quantum.setMolecular({ enabled: false });');
    expect((await stage()).surfaces).toEqual([]);
  });
});
