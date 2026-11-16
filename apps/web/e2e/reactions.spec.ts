import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Lab } from './lab';

let lab: Lab;

test.beforeEach(async ({ page }) => {
  lab = new Lab(page);
  await lab.open();
});

test.afterEach(() => lab.expectNoProblems());

async function enterReactions(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Reactions', exact: true }).click();
  await expect(page.getByTestId('reaction-setup')).toBeVisible();
}

/** Waits until the result on screen belongs to the experiment as it stands and the chamber has been drawn. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const s = (window as unknown as { __MATTERLAB__: { reaction: { useReaction: { getState(): { running: boolean; structuresLoading: boolean; result: unknown; draft: unknown; ranDraft: unknown } } } } }).__MATTERLAB__.reaction.useReaction.getState();
      return !s.running && !s.structuresLoading && s.result !== null && s.draft === s.ranDraft;
    },
    undefined,
    { timeout: 60_000 },
  );
  await lab.settle();
}

async function runPreset(page: Page, id: string): Promise<void> {
  await page.getByTestId('reaction-preset').selectOption(id);
  await page.getByTestId('reaction-run').click();
  await settled(page);
}

interface ResultSummary {
  status: string;
  equation: string | null;
  deltaH: number | null;
  deltaHUncertainty: number | null;
  deltaS: number | null;
  deltaG: number | null;
  log10K: number | null;
  temperatureK: number;
  k: number | null;
  halfLife: number | null;
  frames: number;
  warnings: string[];
  limitations: string[];
  steps: Array<{ id: string; status: string; summary: string }>;
  inputHash: string;
}

function summary(): Promise<ResultSummary> {
  return lab.eval(`
    const r = lab.reaction.useReaction.getState().result;
    return {
      status: r.status,
      equation: r.equation ? r.equation.text : null,
      deltaH: r.thermo && r.thermo.deltaH ? r.thermo.deltaH.value : null,
      deltaHUncertainty: r.thermo && r.thermo.deltaH && r.thermo.deltaH.uncertainty !== undefined ? r.thermo.deltaH.uncertainty : null,
      deltaS: r.thermo && r.thermo.deltaS ? r.thermo.deltaS.value : null,
      deltaG: r.thermo && r.thermo.deltaG ? r.thermo.deltaG.value : null,
      log10K: r.thermo && r.thermo.log10K !== undefined ? r.thermo.log10K : null,
      temperatureK: r.input.conditions.temperatureK,
      k: r.rateConstant ? r.rateConstant.k.value : null,
      halfLife: r.kinetics && r.kinetics.halfLife ? r.kinetics.halfLife.seconds : null,
      frames: r.kinetics ? r.kinetics.times.length : 0,
      warnings: [...r.warnings],
      limitations: [...r.limitations],
      steps: r.steps.map((s) => ({ id: s.id, status: s.status, summary: s.summary })),
      inputHash: r.inputHash,
    };`);
}

/** Molecules of each species drawn in the chamber, read from the legend the user sees. */
async function legendCounts(page: Page): Promise<Record<string, number>> {
  const chips = await page.getByTestId('chamber-counts').locator('button.ml-legend__chip').allInnerTexts();
  const counts: Record<string, number> = {};
  for (const chip of chips) {
    const match = /^(\d+)\s*(.+)$/s.exec(chip.replace(/\s+/g, ' ').trim());
    if (match) counts[match[2]!.replace(/\s/g, '')] = Number(match[1]);
  }
  return counts;
}

/** Moves a slider to a value the way the browser does when it is dragged there. */
async function setSlider(page: Page, testId: string, value: number): Promise<void> {
  await page.getByTestId(testId).evaluate((element, next) => {
    const input = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(next));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await lab.settle(200);
}

interface Pose {
  position: number[];
  target: number[];
  zoom: number;
  projection: string;
}

function expectSamePose(actual: string, expected: string): void {
  const a = JSON.parse(actual) as Pose;
  const b = JSON.parse(expected) as Pose;
  expect(a.projection).toBe(b.projection);
  for (let i = 0; i < 3; i++) {
    expect(a.position[i]!).toBeCloseTo(b.position[i]!, 3);
    expect(a.target[i]!).toBeCloseTo(b.target[i]!, 3);
  }
}

const GAS_CONSTANT = 8.314462618; // J/(mol K), exact since the 2019 SI

test.describe('workspaces', () => {
  test('the molecule being built is set aside untouched and comes back exactly', async ({ page }) => {
    await lab.openExample('glycine');
    await lab.eval('lab.actions.setAtomPosition(1, [-2.4, 0.3, 0.1]); lab.actions.selectOnly([1, 2]); lab.actions.addMeasurement([1, 2]);');
    const atoms = await lab.atoms();
    const before = await lab.summary();
    const pose = await lab.pose();

    await enterReactions(page);
    expect((await lab.summary()).atoms).toBe(0);
    await runPreset(page, 'methane-combustion');
    expect((await lab.summary()).atoms).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Architect', exact: true }).click();
    await lab.settle(500);
    expect(await lab.atoms()).toEqual(atoms);
    expect(await lab.summary()).toMatchObject({ formula: before.formula, undo: before.undo, selectedAtoms: [1, 2] });
    expect(await lab.eval<number>('return lab.lab.get().measurements.length;')).toBe(1);
    expectSamePose(await lab.pose(), pose);
    // The edit made before leaving can still be undone.
    await lab.eval('lab.actions.undo();');
    expect((await lab.atom(1)).position).not.toEqual([-2.4, 0.3, 0.1]);
  });

  test('a reload while in the reaction laboratory restores the molecule, not the chamber', async ({ page }) => {
    await lab.openExample('glycine');
    const atoms = await lab.atoms();
    await enterReactions(page);
    await runPreset(page, 'methane-combustion');
    await page.reload();
    await lab.ready();
    expect(await lab.eval<string>('return lab.lab.get().workspace;')).toBe('architect');
    expect(await lab.atoms()).toEqual(atoms);
  });

  test('molecules in the chamber can be inspected but not edited', async ({ page }) => {
    await enterReactions(page);
    await runPreset(page, 'methane-combustion');
    const atoms = await lab.atoms();
    const first = atoms[0]!;
    const at = await lab.atomPoint(first.id);

    await lab.drag(at, [at[0] + 80, at[1] + 60]);
    await page.mouse.click(at[0], at[1]);
    await page.keyboard.press('Delete');
    await page.keyboard.press('h');
    await lab.eval(`lab.actions.eraseAtoms([${first.id}]); lab.actions.changeElement([${first.id}], 9); lab.actions.undo();`);
    expect(await lab.atoms()).toEqual(atoms);
    expect((await lab.summary()).undo).toBe(0);
  });
});

test.describe('reaction laboratory: kinetics', () => {
  test('integrates the NO + O3 rate law, and the curves obey the closed-form solution', async ({ page }) => {
    await enterReactions(page);
    await runPreset(page, 'no-o3-kinetics');
    await expect(page.getByTestId('reaction-status')).toContainText('Completed');
    await expect(page.getByTestId('reaction-equation')).toHaveText(/NO\(g\)\s*\+\s*O3\(g\)\s*→\s*NO2\(g\)\s*\+\s*O2\(g\)/);
    await expect(page.getByTestId('rate-constant')).toContainText('cm³ molecule⁻¹ s⁻¹');

    const data = await lab.eval<{ t: number[]; no: number[]; o3: number[]; no2: number[]; o2: number[]; k: number; halfLife: number; unit: string }>(`
      const r = lab.reaction.useReaction.getState().result;
      const c = r.kinetics.concentrations;
      return { t: Array.from(r.kinetics.times), no: Array.from(c.NO), o3: Array.from(c.O3), no2: Array.from(c.NO2), o2: Array.from(c.O2), k: r.rateConstant.k.value, halfLife: r.kinetics.halfLife.seconds, unit: r.kinetics.concentrationUnit };`);
    const { t, no, o3, no2, o2, k } = data;
    expect(t).toHaveLength(201);
    expect(t[0]).toBe(0);
    expect(t[200]).toBe(300);
    expect(no[0]).toBe(5e11);
    expect(o3[0]).toBe(1e12);

    for (let i = 0; i < t.length; i++) {
      // Nitrogen is conserved, and every NO that reacts takes one O3 with it and leaves one NO2 and one O2.
      expect(Math.abs(no[i]! + no2[i]! - 5e11) / 5e11).toBeLessThan(1e-9);
      expect(Math.abs(o3[i]! - no[i]! - 5e11) / 5e11).toBeLessThan(1e-9);
      expect(Math.abs(no2[i]! - o2[i]!) / 5e11).toBeLessThan(1e-9);
      // Second-order kinetics with unequal concentrations has a closed-form solution:
      // [NO](t) = A0 (B0 - A0) / (B0 exp(k (B0 - A0) t) - A0), with A0 = [NO]0 and B0 = [O3]0.
      const analytic = (5e11 * 5e11) / (1e12 * Math.exp(k * 5e11 * t[i]!) - 5e11);
      expect(Math.abs(no[i]! - analytic) / 5e11).toBeLessThan(1e-6);
    }
    // The same law gives the half-life of NO: the time at which [O3]/[NO] has grown from 2 to 3.
    expect(data.halfLife).toBeCloseTo(Math.log(1.5) / (k * 5e11), 4);
    await expect(page.getByTestId('half-life')).toHaveText('47 s');
    // The evaluated rate constant at 298 K lies in the range the literature gives for this reaction.
    expect(k).toBeGreaterThan(1.5e-14);
    expect(k).toBeLessThan(2.1e-14);
  });

  test('the chamber follows the timeline and never creates or destroys atoms', async ({ page }) => {
    await enterReactions(page);
    await runPreset(page, 'no-o3-kinetics');
    const start = await legendCounts(page);
    // O3 is present at twice the amount of NO: one in each reaction event, the same number again in excess.
    expect(start).toEqual({ 'NO(g)': 18, 'O3(g)': 36, 'NO2(g)': 0, 'O2(g)': 0 });
    const formula = (await lab.summary()).formula;
    expect(formula).toBe('N18O126');

    let previous = 0;
    for (const frame of [40, 90, 150, 200]) {
      await setSlider(page, 'timeline-slider', frame);
      const counts = await legendCounts(page);
      const reacted = counts['NO2(g)']!;
      expect(reacted).toBeGreaterThanOrEqual(previous);
      previous = reacted;
      expect(counts).toEqual({ 'NO(g)': 18 - reacted, 'O3(g)': 36 - reacted, 'NO2(g)': reacted, 'O2(g)': reacted });
      // Whatever the time, the chamber holds the same atoms: a balanced equation only rearranges them.
      expect((await lab.summary()).formula).toBe(formula);
      // The picture agrees with the computed conversion at that time.
      const fraction = await lab.eval<number>(`const r = lab.reaction.useReaction.getState().result; const c = r.kinetics.concentrations.NO; return (c[0] - c[${frame}]) / c[0];`);
      expect(reacted).toBe(Math.round(fraction * 18));
    }
    expect(previous).toBeGreaterThan(10);
    await expect(page.getByTestId('timeline-time')).toContainText('5 min');
    // The slider also answers the keyboard, one frame per key press.
    await page.getByTestId('timeline-slider').focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    expect(await lab.eval<number>('return lab.reaction.useReaction.getState().frame;')).toBe(198);
  });

  test('plays, pauses and steps frame by frame', async ({ page }) => {
    await enterReactions(page);
    await runPreset(page, 'no-o3-kinetics');
    const frame = () => lab.eval<number>('return lab.reaction.useReaction.getState().frame;');
    expect(await frame()).toBe(0);

    await page.getByTestId('timeline-play').click();
    await page.waitForFunction(() => (window as unknown as { __MATTERLAB__: { reaction: { useReaction: { getState(): { frame: number } } } } }).__MATTERLAB__.reaction.useReaction.getState().frame >= 15);
    await page.getByTestId('timeline-play').click();
    const paused = await frame();
    await lab.settle(500);
    expect(await frame()).toBe(paused);

    await page.getByRole('button', { name: 'One frame forward' }).click();
    expect(await frame()).toBe(paused + 1);
    await page.getByRole('button', { name: 'One frame back' }).click();
    await page.getByRole('button', { name: 'One frame back' }).click();
    expect(await frame()).toBe(paused - 1);

    // At four times the speed the same stretch of the timeline takes clearly less time.
    await page.getByLabel('Playback speed').selectOption('4');
    await lab.eval('lab.reaction.seek(0);');
    const started = Date.now();
    await page.getByTestId('timeline-play').click();
    await page.waitForFunction(() => (window as unknown as { __MATTERLAB__: { reaction: { useReaction: { getState(): { playing: boolean; frame: number } } } } }).__MATTERLAB__.reaction.useReaction.getState().frame === 200, undefined, { timeout: 10_000 });
    expect(Date.now() - started).toBeLessThan(6000);
    expect(await lab.eval<boolean>('return lab.reaction.useReaction.getState().playing;')).toBe(false);
  });

  test('draws no energy barrier when the rate constant falls with temperature', async ({ page }) => {
    await enterReactions(page);
    await runPreset(page, 'no-o2-termolecular-kinetics');
    const diagrams = await lab.eval<Array<{ quantity: string; kinds: string[]; notes: string[] }>>(
      'return lab.reaction.useReaction.getState().result.energyDiagrams.map((d) => ({ quantity: d.quantity, kinds: d.levels.map((l) => l.kind), notes: [...d.notes] }));',
    );
    expect(diagrams.length).toBeGreaterThan(0);
    for (const diagram of diagrams) expect(diagram.kinds).not.toContain('barrier');
    expect(diagrams.flatMap((d) => d.notes).join(' ')).toMatch(/barrier/i);
    // The picture is cut down, and says so, because oxygen is in 5000-fold excess.
    await expect(page.getByTestId('chamber-legend')).toContainText('cut down');
  });
});

test.describe('reaction laboratory: thermodynamics', () => {
  test('methane combustion matches the published enthalpy and is internally consistent', async ({ page }) => {
    await enterReactions(page);
    await runPreset(page, 'methane-combustion');
    const r = await summary();
    expect(r.status).toBe('completed');
    expect(r.equation).toBe('CH4(g) + 2 O2(g) -> CO2(g) + 2 H2O(l)');
    // Standard enthalpy of combustion of methane to liquid water at 298.15 K: -890.3 kJ/mol
    // (CODATA key values for CO2 and H2O(l), NIST-JANAF for CH4; textbooks quote -890.3 to -890.8).
    expect(Math.abs(r.deltaH! - -890.3)).toBeLessThan(0.6);
    // Standard Gibbs energy of the same reaction: about -818 kJ/mol.
    expect(Math.abs(r.deltaG! - -818)).toBeLessThan(1.5);
    // The numbers must satisfy the defining relations exactly.
    expect(r.deltaG!).toBeCloseTo(r.deltaH! - (r.temperatureK * r.deltaS!) / 1000, 9);
    expect(r.log10K!).toBeCloseTo((-r.deltaG! * 1000) / (GAS_CONSTANT * r.temperatureK * Math.LN10), 6);
    expect(r.k).toBeNull();
    expect(r.frames).toBe(0);
    await expect(page.getByTestId('delta-h')).toHaveText(/[−-]890\.\d/);

    // No rate law exists for a flame, and the graphs say so instead of drawing a curve.
    await page.getByRole('button', { name: 'Graphs', exact: true }).click();
    await expect(page.getByTestId('reaction-results')).toContainText('no sourced rate law exists');
    await expect(page.getByTestId('concentration-chart')).toHaveCount(0);
    await expect(page.getByTestId('energy-enthalpy')).toBeVisible();
  });

  test('the before/after view conserves atoms at every step', async ({ page }) => {
    await enterReactions(page);
    await runPreset(page, 'methane-combustion');
    expect(await legendCounts(page)).toEqual({ 'CH4(g)': 18, 'O2(g)': 36, 'CO2(g)': 0, 'H2O(l)': 0 });
    const formula = (await lab.summary()).formula;
    expect(formula).toBe('C18H72O72');
    for (const events of [5, 11, 18]) {
      await setSlider(page, 'conversion-slider', events);
      expect(await legendCounts(page)).toEqual({ 'CH4(g)': 18 - events, 'O2(g)': 2 * (18 - events), 'CO2(g)': events, 'H2O(l)': 2 * events });
      expect((await lab.summary()).formula).toBe(formula);
    }
  });

  test('far from 298 K the result is labelled an estimate, and pressure and catalyst are declared unmodelled', async ({ page }) => {
    await enterReactions(page);
    await runPreset(page, 'ammonia-synthesis-700k');
    const r = await summary();
    expect(r.equation).toBe('N2(g) + 3 H2(g) -> 2 NH3(g)');
    // 2 x the CODATA enthalpy of formation of ammonia, -45.94 +/- 0.35 kJ/mol.
    expect(r.deltaH!).toBeCloseTo(-91.88, 2);
    expect(r.deltaHUncertainty!).toBeCloseTo(0.7, 2);
    expect(r.deltaG!).toBeCloseTo(r.deltaH! - (700 * r.deltaS!) / 1000, 9);
    expect(r.deltaG!).toBeGreaterThan(0);
    await expect(page.getByTestId('reaction-status').locator('.ml-evidence')).toHaveText('Rule-based');
    const text = [...r.warnings, ...r.limitations].join(' ');
    expect(text).toMatch(/catalyst/i);
    expect(text).toMatch(/pressure/i);
    await expect(page.getByTestId('reaction-results')).toContainText('Reactants are favoured');
  });

  test('a reaction typed in by hand is balanced and evaluated', async ({ page }) => {
    await enterReactions(page);
    await page.getByRole('button', { name: 'New, empty experiment' }).click();
    const formulas = page.getByTestId('species-formula');
    await formulas.nth(0).fill('H2');
    await formulas.nth(0).press('Enter');
    await page.getByTestId('add-reactant').click();
    await formulas.nth(1).fill('O2');
    await formulas.nth(1).press('Enter');
    await formulas.nth(2).fill('H2O');
    await formulas.nth(2).press('Enter');
    for (const index of [0, 1, 2]) await page.getByLabel('Phase').nth(index).selectOption('g');
    await page.getByTestId('reaction-run').click();
    await settled(page);

    const r = await summary();
    expect(r.equation).toBe('2 H2(g) + O2(g) -> 2 H2O(g)');
    // Twice the CODATA enthalpy of formation of water vapour, -241.826 +/- 0.040 kJ/mol.
    expect(r.deltaH!).toBeCloseTo(-483.652, 2);
    expect(r.deltaHUncertainty!).toBeCloseTo(0.08, 3);
    await expect(page.getByTestId('reaction-equation')).toHaveText(/2\s*H2\(g\)\s*\+\s*O2\(g\)\s*→\s*2\s*H2O\(g\)/);
    expect(await legendCounts(page)).toMatchObject({ 'H2(g)': 36, 'O2(g)': 18, 'H2O(g)': 0 });
  });
});

test.describe('reaction laboratory: honest limits', () => {
  test('does not guess products', async ({ page }) => {
    await enterReactions(page);
    await runPreset(page, 'methane-oxygen-no-products');
    const r = await summary();
    expect(r).toMatchObject({ status: 'unsupported', equation: null, deltaH: null, k: null });
    await expect(page.getByTestId('reaction-status')).toContainText('Not supported');
    await expect(page.getByTestId('reaction-results')).toContainText(/does not predict/i);
    expect((await lab.summary()).atoms).toBe(0);
    // The catalogue can still list known reactions of these species, labelled as a look-up.
    await expect(page.getByTestId('reaction-setup')).toContainText('It does not predict that a reaction happens');
  });

  test('names the species that have no reference data instead of estimating them', async ({ page }) => {
    await enterReactions(page);
    await runPreset(page, 'iron-oxidation-missing-data');
    const r = await summary();
    expect(r).toMatchObject({ status: 'partial', equation: '4 Fe(s) + 3 O2(g) -> 2 Fe2O3(s)', deltaH: null, deltaG: null });
    const lookup = r.steps.find((s) => s.id === 'reference-data')!;
    expect(lookup.status).toBe('failed');
    expect(lookup.summary).toContain('Fe2O3(s)');
    await expect(page.getByTestId('reaction-thermo')).toHaveCount(0);
    // The oxide is an extended solid, so it is not drawn as if it were a molecule.
    await expect(page.getByTestId('chamber-counts')).toContainText('not drawn');
  });

  test('refuses kinetics when no sourced rate law exists', async ({ page }) => {
    await enterReactions(page);
    await page.getByTestId('reaction-preset').selectOption('methane-combustion');
    await page.getByRole('button', { name: 'Kinetics', exact: true }).click();
    await page.getByTestId('reaction-run').click();
    await settled(page);
    const r = await summary();
    expect(r.status).toBe('unsupported');
    expect(r.k).toBeNull();
    expect(r.frames).toBe(0);
    expect(r.steps.find((s) => s.id === 'model-selection')!.summary).toMatch(/rate law/i);
  });

  test('reports a formula it cannot read, and runs nothing', async ({ page }) => {
    await enterReactions(page);
    await page.getByTestId('reaction-preset').selectOption('methane-combustion');
    const formula = page.getByTestId('species-formula').nth(0);
    await formula.fill('CH4q');
    await formula.press('Enter');
    await expect(page.getByTestId('species-row').nth(0).locator('.ml-species__problem')).toBeVisible();
    await page.getByTestId('reaction-run').click();
    await settled(page);
    const r = await summary();
    expect(r).toMatchObject({ status: 'invalid', equation: null, deltaH: null });
    await expect(page.getByTestId('reaction-status')).toContainText('Cannot run');
  });

  test('marks a result as out of date once the experiment is changed', async ({ page }) => {
    await enterReactions(page);
    await runPreset(page, 'ammonia-synthesis-298k');
    await expect(page.getByTestId('reaction-stale')).toHaveCount(0);
    const temperature = page.getByTestId('temperature');
    await temperature.fill('350');
    await temperature.press('Enter');
    await expect(page.getByTestId('reaction-stale')).toBeVisible();
    await page.getByTestId('reaction-run').click();
    await settled(page);
    await expect(page.getByTestId('reaction-stale')).toHaveCount(0);
    expect((await summary()).temperatureK).toBe(350);
  });
});

test.describe('reaction laboratory: records', () => {
  test('saves, reopens, reproduces and compares experiments', async ({ page }) => {
    await enterReactions(page);
    await runPreset(page, 'ammonia-synthesis-298k');
    const first = await summary();
    const firstJson = await lab.eval<string>('return lab.reaction.useReaction.getState().resultJson;');
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await page.getByTestId('reaction-save').click();
    await expect(page.getByTestId('saved-experiments').locator('.ml-saved')).toHaveCount(1);

    await runPreset(page, 'ammonia-synthesis-700k');
    await page.getByTestId('reaction-save').click();
    await expect(page.getByTestId('saved-experiments').locator('.ml-saved')).toHaveCount(2);
    expect((await summary()).inputHash).not.toBe(first.inputHash);

    // Reopening brings back exactly what was saved, inputs included.
    await page.getByTestId('saved-experiments').locator('.ml-saved__main', { hasText: 'Ammonia synthesis at 298.15 K' }).click();
    await settled(page);
    expect(await lab.eval<string>('return lab.reaction.useReaction.getState().resultJson;')).toBe(firstJson);
    expect(await summary()).toEqual(first);
    await expect(page.getByTestId('temperature')).toHaveValue('298.15');

    // Running the record again gives the same result, byte for byte.
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await page.getByTestId('reaction-reproduce').click();
    await expect(page.getByTestId('reproduction')).toContainText('Reproduced exactly');

    // Both experiments side by side.
    for (const button of await page.getByRole('button', { name: 'Include in the comparison' }).all()) await button.click();
    const table = page.getByTestId('reaction-compare');
    await expect(table).toContainText('298.15');
    await expect(table).toContainText('700');
    const rows = await table.locator('tbody tr').allInnerTexts();
    const gibbs = rows.find((row) => row.startsWith('ΔG°'))!;
    // Favourable at 298 K, unfavourable at 700 K: the two columns have opposite signs.
    expect(gibbs).toMatch(/[−-]\d/);
    expect(gibbs).toMatch(/(^|\s)\d+\.\d(\s|$)/);

    // Saved experiments survive a reload.
    await page.reload();
    await lab.ready();
    await enterReactions(page);
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(page.getByTestId('saved-experiments').locator('.ml-saved')).toHaveCount(2);
  });

  test('an exported record opens again, and a damaged one is refused', async ({ page }) => {
    await enterReactions(page);
    await runPreset(page, 'no-o3-kinetics');
    const json = await lab.eval<string>('return lab.reaction.useReaction.getState().resultJson;');
    const before = await summary();
    expect(JSON.parse(json)).toMatchObject({ schema: 'matterlab.experiment-result', schemaVersion: 1, inputHash: before.inputHash });

    await runPreset(page, 'methane-combustion');
    await lab.eval(`return lab.reaction.importExperimentFile(new File([${JSON.stringify(json)}], 'no-o3.experiment.json', { type: 'application/json' }));`);
    await settled(page);
    expect(await summary()).toEqual(before);
    expect(await lab.eval<string>('return lab.reaction.useReaction.getState().resultJson;')).toBe(json);

    const damaged = json.replace('"matterlab.experiment-result"', '"something-else"');
    await lab.eval(`return lab.reaction.importExperimentFile(new File([${JSON.stringify(damaged)}], 'damaged.json'));`);
    await expect(page.getByTestId('toast').filter({ hasText: 'is not an experiment record' })).toBeVisible();
    expect(await summary()).toEqual(before);
  });
});

test.describe('reaction laboratory: the chamber', () => {
  test('a species picked in the legend is highlighted in the chamber', async ({ page }) => {
    await enterReactions(page);
    await runPreset(page, 'methane-combustion');
    expect((await lab.summary()).selectedAtoms).toHaveLength(0);
    await page.getByTestId('chamber-counts').locator('button.ml-legend__chip', { hasText: 'CH4' }).click();
    await lab.settle();
    // 18 methane molecules of five atoms each.
    expect((await lab.summary()).selectedAtoms).toHaveLength(90);
    const elements = await lab.eval<number[]>('const s = lab.lab.get(); return [...s.selectedAtoms].map((id) => s.scene.atoms.get(id).protons);');
    expect(elements.filter((z) => z === 6)).toHaveLength(18);
    expect(elements.filter((z) => z === 1)).toHaveLength(72);
    // The highlight follows the species as the reaction proceeds.
    await setSlider(page, 'conversion-slider', 9);
    expect((await lab.summary()).selectedAtoms).toHaveLength(45);
    await page.getByTestId('chamber-counts').locator('button.ml-legend__chip', { hasText: 'CH4' }).click();
    await lab.settle();
    expect((await lab.summary()).selectedAtoms).toHaveLength(0);
  });

  test('says where each 3D model comes from', async ({ page }) => {
    await enterReactions(page);
    await runPreset(page, 'no-o3-kinetics');
    const models = await lab.eval<Array<{ key: string; origin: string | null; evidence: string | null; atoms: number; note: string }>>(`
      const s = lab.reaction.useReaction.getState();
      return s.plan.species.map((sp) => ({ key: sp.key, origin: sp.structure ? sp.structure.origin : null, evidence: sp.structure ? sp.structure.evidence : null, atoms: sp.structure ? sp.structure.scene.atoms.size : 0, note: sp.structure ? sp.structure.note : '' }));`);
    expect(models.map((m) => [m.key, m.atoms])).toEqual([
      ['NO(g)', 2],
      ['O3(g)', 3],
      ['NO2(g)', 3],
      ['O2(g)', 2],
    ]);
    for (const model of models) {
      expect(model.evidence).toBe('computed');
      expect(model.note).toMatch(/not a measured structure/);
    }
    // PubChem has a conformer for ozone and oxygen but only the bonding of the two radicals.
    expect(models.find((m) => m.key === 'O3(g)')!.origin).toBe('pubchem-3d');
    expect(models.find((m) => m.key === 'NO(g)')!.origin).toBe('pubchem-bonding-uff');
    await page.getByTestId('species-models').locator('summary').click();
    await expect(page.getByTestId('species-models')).toContainText('Universal Force Field model geometry');
  });
});
