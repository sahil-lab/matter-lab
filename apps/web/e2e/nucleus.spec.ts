import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Lab } from './lab';

let lab: Lab;

test.beforeEach(async ({ page }) => {
  lab = new Lab(page);
  await lab.open();
});

test.afterEach(() => lab.expectNoProblems());

interface Nucleon {
  index: number;
  kind: 'proton' | 'neutron';
  ordinal: number;
  position: [number, number, number];
}

interface View {
  protons: number;
  neutrons: number;
  extentFm: number;
  nucleons: Nucleon[];
  selected: number | null;
  introDone: boolean;
  scaleFm: number | null;
  scaleBarPx: number | null;
}

const view = (): Promise<View | null> =>
  lab.eval(
    'const n = lab.nucleus; return n.model ? { protons: n.model.protons, neutrons: n.model.neutrons, extentFm: n.model.extentFm, nucleons: JSON.parse(JSON.stringify(n.model.nucleons)), selected: n.selected, introDone: n.introDone, scaleFm: n.scaleFm, scaleBarPx: n.scaleBarPx } : null;',
  );

const screenPoint = (index: number): Promise<[number, number]> => lab.eval(`return lab.nucleus.screenPoint(${index});`);

/** Selects the first atom of an element and opens its nucleus from the Atomic Forge. */
async function openNucleus(page: Page, z: number, particles?: { neutrons: number | null }): Promise<number> {
  const atom = (await lab.atoms()).find((a) => a.z === z)!;
  if (particles) await lab.eval(`lab.actions.setParticles(${atom.id}, ${JSON.stringify(particles)}, 'Change isotope');`);
  await lab.eval(`lab.actions.selectOnly([${atom.id}]);`);
  await page.getByTestId('open-nucleus').click();
  await expect(page.getByTestId('nucleus')).toBeVisible();
  // The 3D view reports what it shows once it has drawn it.
  await expect.poll(async () => (await view()) !== null).toBe(true);
  return atom.id;
}

async function introDone(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as { __MATTERLAB__: { nucleus: { introDone: boolean } } }).__MATTERLAB__.nucleus.introDone, undefined, { timeout: 20_000 });
  await lab.settle(200);
}

/** Nucleons nothing stands in front of, nearest to the viewer first. The camera looks down the z axis from the front. */
function unobstructed(nucleons: readonly Nucleon[]): Nucleon[] {
  return [...nucleons]
    .sort((a, b) => b.position[2] - a.position[2])
    .filter((candidate) => nucleons.every((other) => other.position[2] <= candidate.position[2] || Math.hypot(other.position[0] - candidate.position[0], other.position[1] - candidate.position[1]) > 1.1));
}

test.describe('the nucleus of an atom', () => {
  test('is drawn with exactly the protons and neutrons the atom has, and says that it is a picture', async ({ page }) => {
    await lab.openExample('water');
    await openNucleus(page, 8);
    const dialog = page.getByRole('dialog', { name: 'Nucleus of oxygen-16' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('8 protons and 8 neutrons, drawn as spheres');
    await expect(page.getByTestId('nucleus-legend')).toHaveText(/8 protons\s*8 neutrons/);
    // The water molecule states no isotope for its oxygen: the most abundant one stands in, and that is said.
    await expect(page.getByTestId('nucleus-natural')).toContainText('This atom states no isotope, so it stands for natural oxygen. Shown is oxygen-16, its most abundant isotope.');
    await expect(page.getByTestId('nucleus-caveat')).toContainText('This is a picture, not a simulation.');
    await expect(page.getByTestId('nucleus-caveat')).toContainText('have no positions of their own and are not hard spheres');
    await expect(dialog.locator('.ml-evidence').first()).toHaveText('Illustrative');

    const shown = (await view())!;
    expect(shown.protons).toBe(8);
    expect(shown.neutrons).toBe(8);
    expect(shown.nucleons.filter((n) => n.kind === 'proton').length).toBe(8);
    expect(shown.nucleons.filter((n) => n.kind === 'neutron').length).toBe(8);
    // Oxygen-16 is bound by 127.62 MeV, 7.98 MeV per nucleon (Atomic Mass Evaluation 2020).
    await expect(page.getByTestId('nucleus-binding')).toHaveText('127.62 MeV');
    await expect(page.getByTestId('nucleus-binding-per-nucleon')).toHaveText('7.98 MeV');
    await expect(page.getByTestId('nucleus-facts')).toContainText('Stable');
    await expect(page.getByTestId('nucleus-decay')).toHaveCount(0);
    await expect(page.getByTestId('nucleus-facts')).toContainText('8 + 8 = 16');
    // Opening the view edits nothing.
    expect((await lab.summary()).undo).toBe(0);
  });

  test('zooms in from the size of the atom, with a scale bar that tells the truth at every step', async ({ page }) => {
    await lab.openExample('water');
    await openNucleus(page, 8);
    // Sampled through the zoom: the length the bar stands for only ever shrinks, from picometres to femtometres.
    const lengths: number[] = [];
    const labels: string[] = [];
    const captions: string[] = [];
    for (let i = 0; i < 400; i++) {
      const now = await lab.eval<{ fm: number | null; done: boolean }>('return { fm: lab.nucleus.scaleFm, done: lab.nucleus.introDone };');
      if (now.fm !== null) {
        lengths.push(now.fm);
        labels.push((await page.getByTestId('nucleus-scale').innerText()).trim());
        captions.push((await page.getByTestId('nucleus-caption').textContent()) ?? '');
      }
      if (now.done) break;
      await page.waitForTimeout(40);
    }
    expect(lengths.length).toBeGreaterThan(8);
    for (let i = 1; i < lengths.length; i++) expect(lengths[i]!).toBeLessThanOrEqual(lengths[i - 1]!);
    // It starts at the scale of the atom, tens of picometres, and says that this is the atom ...
    expect(lengths[0]!).toBeGreaterThanOrEqual(10_000);
    expect(labels[0]).toMatch(/ pm$/);
    expect(captions[0]).toMatch(/^The whole atom, out to its van der Waals radius of \d\.\d\d Å\.$/);
    expect(captions).toContain('The speck marks the nucleus, still far too small to be seen at this scale.');
    // ... and ends at the scale of a nucleon, with nothing left to explain about the zoom.
    await introDone(page);
    await expect(page.getByTestId('nucleus-caption')).toHaveText('');
    const shown = (await view())!;
    expect(shown.scaleFm).toBe(1);
    await expect(page.getByTestId('nucleus-scale')).toHaveText('1 fm');

    // The bar is as long on screen as that length really is. Measured on the picture itself: a
    // nucleon at distance r from the axis of view and at depth z appears at rho = k r D / (D - z)
    // pixels from the centre, so r / rho falls on a straight line in z whose value at z = 0 is 1 / k,
    // the femtometres per pixel in the plane through the centre, which is where the bar applies.
    const stage = (await page.locator('.ml-nucleus__stage').boundingBox())!;
    const centre = [stage.x + stage.width / 2, stage.y + stage.height / 2];
    const samples: Array<[number, number]> = [];
    for (const nucleon of shown.nucleons) {
      const r = Math.hypot(nucleon.position[0], nucleon.position[1]);
      if (r < 0.6) continue;
      const point = await screenPoint(nucleon.index);
      samples.push([nucleon.position[2], r / Math.hypot(point[0] - centre[0], point[1] - centre[1])]);
    }
    expect(samples.length).toBeGreaterThan(8);
    const mean = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;
    const zBar = mean(samples.map(([z]) => z));
    const yBar = mean(samples.map(([, y]) => y));
    const slope = samples.reduce((sum, [z, y]) => sum + (z - zBar) * (y - yBar), 0) / samples.reduce((sum, [z]) => sum + (z - zBar) ** 2, 0);
    const femtometrePerPixel = yBar - slope * zBar;
    // Nearer nucleons look larger: the line falls with z, as perspective requires.
    expect(slope).toBeLessThan(0);
    expect(shown.scaleBarPx! * femtometrePerPixel).toBeGreaterThan(0.98 * shown.scaleFm!);
    expect(shown.scaleBarPx! * femtometrePerPixel).toBeLessThan(1.02 * shown.scaleFm!);
    const drawn = await page.getByTestId('nucleus-scale').locator('i').boundingBox();
    expect(Math.abs(drawn!.width - shown.scaleBarPx!)).toBeLessThan(3);

    // The ratio that is stated is the ratio of the two radii shown beside it.
    const atomRadiusFm = Number(/= ([\d,]+) fm/.exec(await page.getByTestId('nucleus-atom-radius').innerText())![1]!.replace(/,/g, ''));
    expect(atomRadiusFm).toBeGreaterThan(100_000);
    await expect(page.getByTestId('nucleus-ratio')).toContainText(`The atom is about ${Number((atomRadiusFm / shown.extentFm).toPrecision(2)).toLocaleString('en-US')} times wider than its nucleus.`);

    // The zoom can be played again.
    await page.getByTestId('nucleus-replay').click();
    await page.waitForFunction(() => !(window as unknown as { __MATTERLAB__: { nucleus: { introDone: boolean } } }).__MATTERLAB__.nucleus.introDone);
    expect((await view())!.scaleFm!).toBeGreaterThan(1000);
    await introDone(page);
    expect((await view())!.scaleFm).toBe(1);
  });

  test('lets every proton and neutron be picked, and says what is known about that particle', async ({ page }) => {
    await lab.openExample('water');
    await openNucleus(page, 8);
    await introDone(page);
    await expect(page.getByTestId('nucleon-hint')).toBeVisible();
    const shown = (await view())!;
    const front = unobstructed(shown.nucleons);
    const proton = front.find((n) => n.kind === 'proton')!;
    const neutron = front.find((n) => n.kind === 'neutron')!;
    expect(proton).toBeDefined();
    expect(neutron).toBeDefined();
    const side = page.locator('.ml-nucleus__side');

    await page.mouse.click(...(await screenPoint(proton.index)));
    await expect(side).toContainText(`Proton ${proton.ordinal} of 8`);
    expect((await view())!.selected).toBe(proton.index);
    const facts = page.getByTestId('nucleon-facts');
    // CODATA 2018: m_p = 1.007 276 466 621 u = 938.272 088 16 MeV/c^2.
    await expect(facts).toContainText('+1 e');
    await expect(facts).toContainText('1.007276 u');
    await expect(facts).toContainText('938.272 MeV/c²');
    await expect(facts).toContainText('two up quarks and one down quark (uud)');
    await expect(side).toContainText('no proton decay has ever been observed');
    await expect(side).toContainText('“proton ' + proton.ordinal + '” is a label of this picture only');

    await page.mouse.click(...(await screenPoint(neutron.index)));
    await expect(side).toContainText(`Neutron ${neutron.ordinal} of 8`);
    expect((await view())!.selected).toBe(neutron.index);
    // CODATA 2018: m_n = 1.008 664 915 95 u = 939.565 420 52 MeV/c^2; mean lifetime 878.4(5) s (Particle Data Group 2022).
    await expect(facts).toContainText('1.008665 u');
    await expect(facts).toContainText('939.565 MeV/c²');
    await expect(facts).toContainText('one up quark and two down quarks (udd)');
    await expect(side).toContainText('mean lifetime of 878.4 ± 0.5 s');
    await expect(side).toContainText('doi:10.1103/RevModPhys.93.025010');

    // A click on nothing lets go of the particle.
    const stage = (await page.locator('.ml-nucleus__stage').boundingBox())!;
    await page.mouse.click(stage.x + stage.width - 40, stage.y + 40);
    await expect(page.getByTestId('nucleon-hint')).toBeVisible();
    expect((await view())!.selected).toBeNull();

    // Turning the nucleus is a drag in the view; the particles keep their places relative to each other.
    const before = await screenPoint(proton.index);
    await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
    await page.mouse.down();
    await page.mouse.move(stage.x + stage.width / 2 + 160, stage.y + stage.height / 2 + 30, { steps: 8 });
    await page.mouse.up();
    await lab.settle(600);
    const after = await screenPoint(proton.index);
    expect(Math.hypot(after[0] - before[0], after[1] - before[1])).toBeGreaterThan(20);
    expect((await view())!.nucleons).toEqual(shown.nucleons);
  });

  test('follows the isotope set in the Atomic Forge, real or not', async ({ page }) => {
    await lab.openExample('water');
    const oxygen = await openNucleus(page, 8, { neutrons: 10 });
    await expect(page.getByRole('dialog', { name: 'Nucleus of oxygen-18' })).toBeVisible();
    await expect(page.getByTestId('nucleus-natural')).toHaveCount(0);
    expect(await view()).toMatchObject({ protons: 8, neutrons: 10 });
    // Oxygen-18: 139.81 MeV (Atomic Mass Evaluation 2020), stable.
    await expect(page.getByTestId('nucleus-binding')).toHaveText('139.81 MeV');
    await expect(page.getByTestId('nucleus-binding-per-nucleon')).toHaveText('7.77 MeV');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('nucleus')).toHaveCount(0);
    expect(await view()).toBeNull();

    // Oxygen-15, the isotope used in medical imaging: half-life 122 s, decaying to nitrogen-15 (NUBASE2020).
    await lab.eval(`lab.actions.setParticles(${oxygen}, { neutrons: 7 }, 'Change isotope');`);
    await page.getByTestId('open-nucleus').click();
    await expect(page.getByRole('dialog', { name: 'Nucleus of oxygen-15' })).toBeVisible();
    await expect(page.getByTestId('nucleus-facts')).toContainText('Half-life 2.04 min');
    await expect(page.getByTestId('nucleus-decay')).toHaveText('electron capture or beta-plus decay');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('nucleus')).toHaveCount(0);

    // An oxygen nucleus with forty neutrons has never been seen: it is drawn, and nothing is claimed about it.
    await lab.eval(`lab.actions.setParticles(${oxygen}, { neutrons: 40 }, 'Change isotope');`);
    await page.getByTestId('open-nucleus').click();
    await expect(page.getByRole('dialog', { name: 'Nucleus of oxygen-48' })).toBeVisible();
    await expect.poll(async () => (await view())?.neutrons ?? null).toBe(40);
    expect(await view()).toMatchObject({ protons: 8, neutrons: 40 });
    await expect(page.getByTestId('nucleus-facts')).toContainText('Not in the evaluated nuclear data');
    await expect(page.getByTestId('nucleus-binding')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // The nucleus of ordinary hydrogen is one proton.
    await lab.eval(`lab.actions.selectOnly([${(await lab.atoms()).find((a) => a.z === 1)!.id}]);`);
    await page.getByTestId('open-nucleus').click();
    await expect(page.getByRole('dialog', { name: 'Nucleus of hydrogen-1' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Nucleus of hydrogen-1' })).toContainText('1 proton and 0 neutrons');
    await expect.poll(async () => (await view())?.nucleons.length ?? null).toBe(1);
    const single = (await view())!;
    expect(single.nucleons).toEqual([{ index: 0, kind: 'proton', ordinal: 1, position: [0, 0, 0] }]);
    await expect(page.getByTestId('nucleus-binding')).toHaveCount(0);
  });

  test('fits a laptop screen without its parts overlapping', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await lab.openExample('caffeine');
    await openNucleus(page, 6);
    await introDone(page);
    const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
    const [dialog, stage, side] = [await box('.ml-dialog'), await box('.ml-nucleus__stage'), await box('.ml-nucleus__side')];
    expect(dialog.x).toBeGreaterThanOrEqual(0);
    expect(dialog.y).toBeGreaterThanOrEqual(0);
    expect(dialog.x + dialog.width).toBeLessThanOrEqual(1280);
    expect(dialog.y + dialog.height).toBeLessThanOrEqual(720);
    expect(stage.x + stage.width).toBeLessThanOrEqual(side.x);
    expect(stage.width).toBeGreaterThan(500);
    expect(stage.height).toBeGreaterThan(400);
    // The overlays of the view stay inside it and clear of each other.
    const [legend, scale, replay] = [await box('.ml-nucleus__legend'), await box('.ml-nucleus__scale'), await box('.ml-nucleus__replay')];
    for (const part of [legend, scale, replay]) {
      expect(part.x).toBeGreaterThanOrEqual(stage.x);
      expect(part.x + part.width).toBeLessThanOrEqual(stage.x + stage.width);
      expect(part.y + part.height).toBeLessThanOrEqual(stage.y + stage.height);
    }
    expect(scale.x + scale.width).toBeLessThan(replay.x);
    expect(legend.y + legend.height).toBeLessThan(scale.y);
  });
});
