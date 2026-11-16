import { expect, test } from '@playwright/test';
import { Lab, distance } from './lab';

let lab: Lab;

test.beforeEach(async ({ page }) => {
  lab = new Lab(page);
  await lab.open();
});

test.afterEach(() => {
  lab.expectNoProblems();
});

test.describe('workspace', () => {
  test('opens into a full-window WebGL 2 view with a valid molecule', async ({ page }) => {
    const summary = await lab.summary();
    expect(summary).toMatchObject({ formula: 'C8H10N4O2', atoms: 24, bonds: 25, errors: 0, warnings: 0 });
    await expect(page.getByTestId('formula')).toHaveText('C8H10N4O2');
    await expect(page.getByTestId('validation-chip')).toContainText('Structure valid');

    const canvas = await page.locator('.ml-viewport canvas').boundingBox();
    expect(canvas).toEqual({ x: 0, y: 0, ...page.viewportSize()! });

    const device = await lab.eval<{ webgl2: boolean; renderer: string }>('return lab.device();');
    expect(device.webgl2).toBe(true);
    expect(device.renderer.length).toBeGreaterThan(0);

    // Something was actually drawn: the centre of the molecule is not the background colour.
    const [x, y] = await lab.atomPoint(1);
    expect(await lab.hitTest(x, y)).toMatchObject({ kind: 'atom', id: 1 });
  });

  test('renders only when something changes', async () => {
    const frames = () => lab.eval<number>('return lab.perf.snapshot().framesRendered;');
    await lab.settle(800);
    const idle = await frames();
    await lab.settle(800);
    expect(await frames()).toBe(idle);
    await lab.drag(await lab.emptyPoint(), [520, 520]);
    expect(await frames()).toBeGreaterThan(idle);
  });
});

test.describe('camera and editing never fight', () => {
  test('dragging an atom moves the atom and leaves the camera alone', async () => {
    await lab.openExample('methane');
    const pose = await lab.pose();
    const before = await lab.atoms();
    const start = await lab.atomPoint(2);
    await lab.drag(start, [start[0] + 90, start[1] - 60]);

    const after = await lab.atoms();
    expect(distance(after[1]!.position, before[1]!.position)).toBeGreaterThan(0.3);
    for (const atom of after.filter((a) => a.id !== 2)) {
      expect(atom.position).toEqual(before.find((b) => b.id === atom.id)!.position);
    }
    expect(await lab.pose()).toBe(pose);
    expect(await lab.summary()).toMatchObject({ undo: 1, selectedAtoms: [2] });
    // The atom followed the pointer: it is now under where the drag ended.
    expect(await lab.hitTest(start[0] + 90, start[1] - 60)).toMatchObject({ kind: 'atom', id: 2 });
  });

  test('dragging empty space orbits, scrolling zooms and right-dragging pans, without editing', async ({ page }) => {
    await lab.openExample('methane');
    const scene = JSON.stringify(await lab.atoms());
    const empty = await lab.emptyPoint();

    let pose = await lab.pose();
    await lab.drag(empty, [empty[0] + 110, empty[1] - 50]);
    await lab.settle(600);
    expect(await lab.pose()).not.toBe(pose);

    pose = await lab.pose();
    await page.mouse.move(700, 400);
    await page.mouse.wheel(0, -500);
    await lab.settle(700);
    const zoomed = JSON.parse(await lab.pose());
    const previous = JSON.parse(pose);
    expect(distance(zoomed.position, zoomed.target)).toBeLessThan(distance(previous.position, previous.target));

    pose = await lab.pose();
    await page.mouse.move(empty[0], empty[1]);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(empty[0] + 80, empty[1] + 40, { steps: 6 });
    await page.mouse.up({ button: 'right' });
    await lab.settle(600);
    expect(JSON.parse(await lab.pose()).target).not.toEqual(JSON.parse(pose).target);

    expect(JSON.stringify(await lab.atoms())).toBe(scene);
    expect((await lab.summary()).undo).toBe(0);
  });

  test('every edit can be undone and redone exactly', async ({ page }) => {
    await lab.openExample('methane');
    const original = await lab.atoms();
    const start = await lab.atomPoint(3);
    await lab.drag(start, [start[0] - 70, start[1] + 30]);
    const moved = await lab.atoms();

    await page.keyboard.press('Control+z');
    expect(await lab.atoms()).toEqual(original);
    await page.keyboard.press('Control+Shift+z');
    expect(await lab.atoms()).toEqual(moved);
    await page.getByTestId('undo').click();
    expect(await lab.atoms()).toEqual(original);
    await page.getByTestId('redo').click();
    expect(await lab.atoms()).toEqual(moved);
  });
});

test.describe('selection', () => {
  test('click, shift-click, box, double-click and keyboard selection', async ({ page }) => {
    await lab.openExample('ethanol');
    await lab.click(await lab.atomPoint(1));
    expect((await lab.summary()).selectedAtoms).toEqual([1]);
    await lab.click(await lab.atomPoint(3), 'Shift');
    expect((await lab.summary()).selectedAtoms).toEqual([1, 3]);
    await lab.click(await lab.atomPoint(1), 'Shift');
    expect((await lab.summary()).selectedAtoms).toEqual([3]);

    await lab.click(await lab.emptyPoint());
    expect((await lab.summary()).selectedAtoms).toEqual([]);

    await lab.drag([120, 90], [1080, 760], 'Shift');
    expect((await lab.summary()).selectedAtoms).toHaveLength(9);
    await page.keyboard.press('Escape');
    expect((await lab.summary()).selectedAtoms).toEqual([]);

    const point = await lab.atomPoint(2);
    await page.mouse.click(point[0], point[1], { clickCount: 2 });
    await lab.settle();
    expect((await lab.summary()).selectedAtoms).toHaveLength(9);

    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+a');
    expect((await lab.summary()).selectedAtoms).toHaveLength(9);

    // Selecting a bond shows the bond panel.
    await lab.click(await lab.bondPoint(1));
    expect(await lab.summary()).toMatchObject({ selectedAtoms: [], selectedBonds: [1] });
    await expect(page.getByTestId('bond-panel')).toBeVisible();
  });
});

test.describe('building molecules', () => {
  test('builds ethanol from nothing with the mouse', async ({ page }) => {
    await lab.eval('lab.actions.newDocument();');
    await lab.settle();
    expect(await lab.summary()).toMatchObject({ atoms: 0, tool: 'build' });

    // Place a carbon: with hydrogens following valence it arrives as methane.
    await lab.click([620, 420]);
    expect(await lab.summary()).toMatchObject({ formula: 'CH4', atoms: 5, bonds: 4, errors: 0, warnings: 0 });

    // Click a hydrogen to turn it into carbon: ethane.
    const hydrogen = (await lab.atoms()).find((a) => a.z === 1)!;
    await lab.click(await lab.atomPoint(hydrogen.id));
    expect(await lab.summary()).toMatchObject({ formula: 'C2H6', atoms: 8, bonds: 7, errors: 0, warnings: 0 });

    // Switch to oxygen and substitute another hydrogen: ethanol.
    await page.getByTestId('element-O').click();
    const another = (await lab.atoms()).filter((a) => a.z === 1).pop()!;
    await lab.click(await lab.atomPoint(another.id));
    const ethanol = await lab.summary();
    expect(ethanol).toMatchObject({ formula: 'C2H6O', atoms: 9, bonds: 8, errors: 0, warnings: 0 });
    await expect(page.getByTestId('validation-chip')).toContainText('Structure valid');

    // The new bond has a sensible length even though nothing was optimised.
    const oxygen = (await lab.atoms()).find((a) => a.z === 8)!;
    const bond = (await lab.bonds()).find((b) => (b.a === oxygen.id || b.b === oxygen.id) && [b.a, b.b].some((id) => id !== oxygen.id));
    const carbons = (await lab.atoms()).filter((a) => a.z === 6);
    const partner = carbons.find((c) => c.id === bond!.a || c.id === bond!.b)!;
    expect(distance(oxygen.position, partner.position)).toBeCloseTo(1.42, 1);
  });

  test('pulls a new bonded atom out of an existing one without moving the camera', async () => {
    await lab.openExample('methane');
    await lab.eval("lab.lab.set({ tool: 'build', buildElement: 7 });");
    const pose = await lab.pose();
    const carbon = await lab.atomPoint(1);
    await lab.drag(carbon, [carbon[0] + 150, carbon[1] + 120]);
    // Methylamine: the carbon gave up a hydrogen for the new nitrogen, which arrived with two of its own.
    expect(await lab.summary()).toMatchObject({ formula: 'CH5N', atoms: 7, bonds: 6, errors: 0 });
    expect(await lab.pose()).toBe(pose);
  });

  test('changes bond order by clicking a bond, with hydrogens following', async ({ page }) => {
    await lab.eval('lab.actions.newDocument();');
    await lab.click([620, 420]);
    await lab.click(await lab.atomPoint((await lab.atoms()).find((a) => a.z === 1)!.id));
    expect((await lab.summary()).formula).toBe('C2H6');
    const carbonIds = (await lab.atoms()).filter((a) => a.z === 6).map((a) => a.id);
    const ccBond = (await lab.bonds()).find((b) => carbonIds.includes(b.a) && carbonIds.includes(b.b))!;
    expect(ccBond).toBeTruthy();

    await page.keyboard.press('2');
    await lab.click(await lab.bondPoint(ccBond.id));
    expect(await lab.summary()).toMatchObject({ formula: 'C2H4', errors: 0 });
    await page.keyboard.press('3');
    await lab.click(await lab.bondPoint(ccBond.id));
    expect(await lab.summary()).toMatchObject({ formula: 'C2H2', errors: 0 });
    await page.keyboard.press('1');
    await lab.click(await lab.bondPoint(ccBond.id));
    expect(await lab.summary()).toMatchObject({ formula: 'C2H6', errors: 0 });
  });

  test('picks any of the 118 elements from the periodic table', async ({ page }) => {
    await lab.eval('lab.actions.newDocument();');
    await page.getByTestId('current-element').click();
    await expect(page.getByTestId('periodic-table').locator('button[data-z]')).toHaveCount(118);
    await page.getByTestId('element-search').fill('gold');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('periodic-table')).toHaveCount(0);
    await expect(page.getByTestId('current-element')).toContainText('Au');

    await lab.click([620, 420]);
    expect(await lab.summary()).toMatchObject({ formula: 'Au', atoms: 1 });

    await page.getByTestId('current-element').click();
    await page.locator('button[data-z="118"]').click();
    await lab.click([760, 300]);
    expect((await lab.summary()).formula).toBe('AuOg');
  });

  test('erases an atom together with its hydrogens, and undo brings them back', async ({ page }) => {
    await lab.openExample('ethanol');
    await page.getByTestId('tool-erase').click();
    const oxygen = (await lab.atoms()).find((a) => a.z === 8)!;
    await lab.click(await lab.atomPoint(oxygen.id));
    // The hydroxyl hydrogen went with the oxygen and the carbon regained a hydrogen: ethane.
    expect(await lab.summary()).toMatchObject({ formula: 'C2H6', atoms: 8, errors: 0, warnings: 0 });
    await page.keyboard.press('Control+z');
    expect(await lab.summary()).toMatchObject({ formula: 'C2H6O', atoms: 9 });
  });
});

test.describe('atomic forge', () => {
  test('protons change the element, neutrons the isotope, electrons the charge', async ({ page }) => {
    await lab.openExample('methane');
    await lab.click(await lab.atomPoint(1));
    await expect(page.getByTestId('atom-name')).toHaveText('Carbon');
    await expect(page.getByTestId('atom-charge')).toHaveText('0');
    await expect(page.getByTestId('atom-config')).toHaveText('[He] 2s2 2p2');

    // One more proton: the same atom is now nitrogen, one electron short.
    await page.getByLabel('Increase protons').click();
    await expect(page.getByTestId('atom-name')).toHaveText('Nitrogen');
    await expect(page.getByTestId('atom-label')).toHaveText('N⁺');
    await expect(page.getByTestId('atom-charge')).toHaveText('+');
    expect(await lab.summary()).toMatchObject({ formula: 'H4N+', atoms: 5, errors: 0 });
    expect(await lab.atom(1)).toMatchObject({ z: 7, e: 6, n: null });

    // One more electron: neutral nitrogen holds three hydrogens, so ammonium becomes ammonia.
    await page.getByLabel('Increase electrons').click();
    await expect(page.getByTestId('atom-charge')).toHaveText('0');
    expect(await lab.summary()).toMatchObject({ formula: 'H3N', atoms: 4, errors: 0 });

    // Choosing an isotope changes only the neutron count.
    await page.getByRole('button', { name: /¹⁵N/ }).click();
    await expect(page.getByTestId('atom-name')).toHaveText('Nitrogen-15');
    expect(await lab.atom(1)).toMatchObject({ z: 7, e: 7, n: 8 });
    await page.getByLabel('Increase neutrons').click();
    await expect(page.getByTestId('atom-name')).toHaveText('Nitrogen-16');
    await expect(page.getByTestId('atom-panel').locator('..')).toContainText('radioactive');

    // A nuclide that does not exist is allowed in the editor but labelled as hypothetical.
    await page.getByLabel('neutrons', { exact: true }).fill('60');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('inspector')).toContainText('treated as hypothetical');

    await page.getByRole('button', { name: 'Natural mix' }).click();
    expect((await lab.atom(1)).n).toBeNull();
  });

  test('explains the selected atom at two depths', async ({ page }) => {
    await lab.openExample('water');
    const oxygen = (await lab.atoms()).find((a) => a.z === 8)!;
    await lab.click(await lab.atomPoint(oxygen.id));
    await page.getByRole('button', { name: 'Explain' }).click();
    const explanation = page.getByTestId('explanation');
    await expect(explanation).toContainText('8 protons');
    await expect(explanation).toContainText('Sources');
    await expect(explanation).not.toContainText('nuclear radius');
    await page.getByRole('button', { name: 'In depth' }).click();
    await expect(explanation).toContainText('nuclear radius');
  });
});

test.describe('precision', () => {
  test('measures distances and angles from the scene geometry', async ({ page }) => {
    await lab.openExample('methane');
    await page.getByTestId('tool-measure').click();
    await lab.click(await lab.atomPoint(1));
    await lab.click(await lab.atomPoint(2));
    const row = page.getByTestId('measurements').locator('.ml-row');
    await expect(row).toHaveCount(1);
    const value = Number((await row.first().locator('b').innerText()).replace(' Å', ''));
    expect(value).toBeGreaterThan(1.05);
    expect(value).toBeLessThan(1.13);

    await page.getByRole('button', { name: 'Angle' }).click();
    for (const id of [2, 1, 3]) await lab.click(await lab.atomPoint(id));
    await expect(row).toHaveCount(2);
    const angle = Number((await row.nth(1).locator('b').innerText()).replace('°', ''));
    expect(angle).toBeGreaterThan(108);
    expect(angle).toBeLessThan(111);
  });

  test('moves a selection by an exact typed distance along an axis', async ({ page }) => {
    await lab.openExample('water');
    const before = await lab.atom(2);
    await lab.click(await lab.atomPoint(2));
    await page.keyboard.press('g');
    await page.keyboard.press('x');
    await page.keyboard.type('1.5');
    await expect(page.locator('.ml-transform-hud')).toContainText('1.500 Å');
    await page.keyboard.press('Enter');
    const after = await lab.atom(2);
    expect(after.position[0] - before.position[0]).toBeCloseTo(1.5, 9);
    expect(after.position[1]).toBe(before.position[1]);
    expect(after.position[2]).toBe(before.position[2]);
    expect((await lab.summary()).undo).toBe(1);

    // Escape cancels a transform and leaves the scene untouched.
    await page.keyboard.press('r');
    await page.keyboard.type('45');
    await page.keyboard.press('Escape');
    expect(await lab.atom(2)).toEqual(after);
    expect((await lab.summary()).undo).toBe(1);
  });

  test('sets an exact bond length from the inspector', async ({ page }) => {
    await lab.openExample('water');
    await lab.click(await lab.bondPoint(1));
    await page.getByLabel('Bond length in angstrom').fill('1.2');
    await page.keyboard.press('Enter');
    const bond = (await lab.bonds())[0]!;
    expect(distance((await lab.atom(bond.a)).position, (await lab.atom(bond.b)).position)).toBeCloseTo(1.2, 9);
  });
});

test.describe('view', () => {
  test('every representation and both projections keep atoms where the pointer finds them', async ({ page }) => {
    await lab.openExample('benzene');
    for (const mode of ['space-fill', 'sticks', 'wire', 'ball-stick']) {
      await lab.eval(`lab.lab.set({ renderMode: '${mode}' });`);
      await lab.settle(600);
      const point = await lab.atomPoint(1);
      expect(await lab.hitTest(point[0], point[1]), mode).toMatchObject({ kind: 'atom' });
      // Bonds are pickable mid-way between atoms whenever the representation draws them.
      const middle = await lab.bondPoint(1);
      const hit = await lab.hitTest(middle[0], middle[1]);
      if (mode !== 'space-fill') expect(hit, `${mode} bond`).toMatchObject({ kind: 'bond', id: 1 });
      else expect(hit?.kind, 'space-fill hides bonds').not.toBe('bond');
    }
    await page.getByTestId('projection').click();
    await lab.settle(600);
    let point = await lab.atomPoint(1);
    expect(await lab.hitTest(point[0], point[1])).toMatchObject({ kind: 'atom', id: 1 });
    expect(JSON.parse(await lab.pose()).projection).toBe('orthographic');

    // Dragging still moves atoms in the orthographic view.
    const before = await lab.atom(7);
    point = await lab.atomPoint(7);
    await lab.drag(point, [point[0] + 60, point[1] + 40]);
    expect(distance((await lab.atom(7)).position, before.position)).toBeGreaterThan(0.2);

    await page.getByTestId('projection').click();
    await page.getByTestId('labels').click();
    await page.getByTestId('labels').click();
    await lab.settle(400);
    point = await lab.atomPoint(1);
    expect(await lab.hitTest(point[0], point[1])).toMatchObject({ kind: 'atom', id: 1 });
  });

  test('reset view returns to the opening view by the short way, however far the camera was turned', async ({ page }) => {
    await lab.openExample('methane');
    const azimuth = () => lab.eval<number>('const p = lab.viewApi.getPose(); return Math.atan2(p.position[0] - p.target[0], p.position[2] - p.target[2]);');
    const unwrapped = (angle: number) => angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
    await lab.eval('lab.viewApi.resetView(false);');
    await lab.settle(400);
    const opening = JSON.parse(await lab.pose());
    expect(await azimuth()).toBeCloseTo(0.42, 3);

    // Orbit by more than a full turn in one direction, then zoom and pan.
    const empty = await lab.emptyPoint();
    let turned = 0;
    let last = await azimuth();
    for (let i = 0; i < 16 && Math.abs(turned) < 2 * Math.PI + 1; i++) {
      await lab.drag(empty, [empty[0] + 150, empty[1]]);
      await lab.settle(500);
      const now = await azimuth();
      turned += unwrapped(now - last);
      last = now;
    }
    expect(Math.abs(turned)).toBeGreaterThan(2 * Math.PI);
    await page.mouse.move(700, 400);
    await page.mouse.wheel(0, -400);
    await lab.settle(600);
    await page.mouse.move(empty[0], empty[1]);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(empty[0] + 70, empty[1] + 40, { steps: 6 });
    await page.mouse.up({ button: 'right' });
    await lab.settle(600);
    expect(distance(JSON.parse(await lab.pose()).target, opening.target)).toBeGreaterThan(0.2);

    // Turn to a standard view and then reset, adding up how far the camera really turns each time.
    // The pose reports where the camera is heading, so the path is read from the camera's own
    // orientation, frame by frame.
    const sweepDuring = (action: string) =>
      lab.eval<number>(`
      return new Promise((resolve) => {
        const angle = () => { const f = lab.viewApi.getBasis().forward; return Math.atan2(-f[0], -f[2]); };
        let last = angle(), total = 0, frames = 0;
        ${action}
        const tick = () => {
          const now = angle();
          const step = now - last;
          total += Math.abs(step - 2 * Math.PI * Math.round(step / (2 * Math.PI)));
          last = now;
          if (++frames < 180) requestAnimationFrame(tick); else resolve(total);
        };
        requestAnimationFrame(tick);
      });`);
    expect(await sweepDuring("lab.viewApi.setStandardView('front');"), 'to the front view by at most half a turn').toBeLessThan(Math.PI + 0.05);
    expect(await azimuth()).toBeCloseTo(0, 2);
    const swept = await sweepDuring('lab.viewApi.resetView(true);');
    expect(swept, 'the camera turned on its way back').toBeGreaterThan(0.2);
    expect(swept, 'the camera goes back by at most half a turn').toBeLessThan(Math.PI + 0.05);
    const back = JSON.parse(await lab.pose());
    for (const axis of [0, 1, 2]) {
      expect(back.position[axis]).toBeCloseTo(opening.position[axis], 2);
      expect(back.target[axis]).toBeCloseTo(opening.target[axis], 2);
    }

    // The same from the views menu and from the keyboard.
    for (const reset of [
      async () => {
        await page.getByRole('button', { name: 'Standard views and bookmarks' }).click();
        await page.getByRole('menuitem', { name: /Reset view/ }).click();
      },
      async () => {
        await page.mouse.move(empty[0], empty[1]);
        await page.keyboard.press('Shift+Home');
      },
    ]) {
      await lab.drag(empty, [empty[0] + 120, empty[1] - 60]);
      await lab.settle(500);
      expect(distance(JSON.parse(await lab.pose()).position, opening.position)).toBeGreaterThan(0.5);
      await reset();
      await lab.settle(1800);
      expect(distance(JSON.parse(await lab.pose()).position, opening.position)).toBeLessThan(0.02);
    }
    expect((await lab.summary()).undo, 'moving the camera edits nothing').toBe(0);
  });

  test('all three quality presets render', async () => {
    for (const quality of ['efficient', 'quality', 'balanced']) {
      await lab.eval(`lab.lab.set({ quality: '${quality}' });`);
      await lab.ready();
      const point = await lab.atomPoint(1);
      expect(await lab.hitTest(point[0], point[1]), quality).toMatchObject({ kind: 'atom', id: 1 });
      expect(await lab.eval<number>('return lab.perf.snapshot().drawCalls;'), quality).toBeGreaterThan(0);
    }
  });
});

test.describe('persistence and files', () => {
  test('a reload restores the session exactly', async ({ page }) => {
    await lab.openExample('water');
    const start = await lab.atomPoint(2);
    await lab.drag(start, [start[0] + 50, start[1] + 50]);
    const saved = await lab.atoms();
    await lab.settle(1200);
    await page.reload();
    await lab.ready();
    expect(await lab.atoms()).toEqual(saved);
    expect((await lab.summary()).formula).toBe('H2O');
  });

  test('saves to and reopens from the project library', async ({ page }) => {
    await lab.openExample('glycine');
    await lab.eval('return lab.persistence.saveCurrentProject();');
    const projects = await lab.eval<Array<{ id: string; name: string; atomCount: number; thumbnail: string | null }>>('return lab.persistence.listProjects();');
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ name: 'Glycine', atomCount: 10 });
    expect(projects[0]!.thumbnail).toMatch(/^data:image\/png;base64,/);

    const scene = await lab.atoms();
    await lab.openExample('water');
    await page.keyboard.press('Control+o');
    await page.getByRole('button', { name: 'Saved', exact: true }).click();
    await page.locator('.ml-dialog .ml-card__title', { hasText: 'Glycine' }).click();
    await lab.settle(500);
    expect(await lab.atoms()).toEqual(scene);
  });

  test('exports and re-imports every file format', async () => {
    await lab.openExample('acetic-acid');
    const original = await lab.summary();
    for (const format of ['matterlab', 'mol', 'sdf', 'xyz', 'pdb']) {
      await lab.openExample('acetic-acid');
      const text = await lab.eval<string>(`return lab.exportText('${format}');`);
      await lab.eval(`lab.commands.importText('molecule.${format === 'matterlab' ? 'json' : format}', ${JSON.stringify(text)}, 'replace');`);
      await lab.settle(300);
      expect(await lab.summary(), format).toMatchObject({ formula: original.formula, atoms: original.atoms, bonds: original.bonds });
    }
  });

  test('reports unreadable files instead of loading them', async ({ page }) => {
    const before = await lab.summary();
    await lab.eval("lab.commands.importText('broken.xyz', 'this is not a molecule', 'replace');");
    await expect(page.getByTestId('toast').filter({ hasText: 'could not be read' })).toBeVisible();
    expect(await lab.summary()).toEqual(before);
  });
});

test.describe('honest validation', () => {
  test('flags an over-bonded atom and points to it', async ({ page }) => {
    await lab.openExample('methane');
    await lab.eval("lab.lab.set({ autoHydrogens: false, tool: 'build', buildElement: 1 });");
    const carbon = await lab.atomPoint(1);
    await lab.drag(carbon, [carbon[0] + 140, carbon[1] - 130]);
    expect(await lab.summary()).toMatchObject({ formula: 'CH5', errors: 1 });
    await expect(page.getByTestId('validation-chip')).toContainText('1 error');
    await page.getByTestId('validation-chip').click();
    await expect(page.getByTestId('issues')).toContainText('supports at most 4');

    // Physics mode marks the problem in the view; the app keeps working.
    await page.getByRole('button', { name: 'Physics', exact: true }).click();
    await lab.settle();
    expect((await lab.summary()).errors).toBe(1);
  });

  test('offers to complete open valences', async ({ page }) => {
    await lab.eval("lab.actions.newDocument(); lab.lab.set({ autoHydrogens: false });");
    await lab.click([620, 420]);
    expect(await lab.summary()).toMatchObject({ formula: 'C', warnings: 1, errors: 0 });
    await page.getByTestId('tool-select').click();
    await page.getByTestId('fix-hydrogens').click();
    expect(await lab.summary()).toMatchObject({ formula: 'CH4', warnings: 0, errors: 0 });
  });
});
