import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { Lab } from './lab';

const OUT = fileURLToPath(new URL('../../../docs/screenshots/', import.meta.url));

let lab: Lab;

test.beforeEach(async ({ page }) => {
  lab = new Lab(page);
  await lab.open();
});

async function shot(name: string): Promise<void> {
  await lab.settle(800);
  await lab.page.screenshot({ path: `${OUT}${name}.png` });
}

/** Opens the Reaction Laboratory, runs a preset and waits until the chamber has been drawn. */
async function runPreset(id: string): Promise<void> {
  await lab.eval(`lab.actions.enterWorkspace('reactions'); lab.reaction.loadPreset(${JSON.stringify(id)}); return lab.reaction.runDraft();`);
  await lab.page.waitForFunction(
    () => {
      const state = (window as unknown as { __MATTERLAB__: { reaction: { useReaction: { getState(): { running: boolean; structuresLoading: boolean; result: unknown } } } } }).__MATTERLAB__.reaction.useReaction.getState();
      return !state.running && !state.structuresLoading && state.result !== null;
    },
    undefined,
    { timeout: 60_000 },
  );
}

test('geometry optimisation', async () => {
  await lab.openExample('aspirin');
  // Pull the acid hydrogen and a ring hydrogen out of place, so there is something to optimise and compare.
  await lab.eval(`
    lab.actions.moveAtoms(new Map([[21, [-1.4, 4.6, 1.4]], [19, [-5.1, -0.2, 1.6]], [14, [4.6, 0.9, -1.9]]]), 'Distort');
    lab.lab.set({ inspectorTab: 'compute' });
    return lab.compute.optimizeGeometry();`);
  await lab.eval('lab.compute.setShowOriginal(true);');
  await shot('20-optimisation-compare');
});

test('reaction laboratory: kinetics', async () => {
  await lab.eval("lab.actions.enterWorkspace('reactions');");
  await shot('21-reaction-lab-empty');

  await runPreset('no-o3-kinetics');
  await shot('22-reaction-kinetics-result');

  await lab.eval("lab.reaction.setTab('graphs'); lab.reaction.seek(60);");
  await shot('23-reaction-kinetics-graphs');

  await lab.eval("lab.reaction.setTab('explain');");
  await shot('24-reaction-explanation');

  await lab.eval("lab.reaction.setTab('record'); return lab.reaction.saveExperiment();");
  await lab.eval('return lab.reaction.reproduce();');
  await shot('25-reaction-record');
});

test('reaction laboratory: thermodynamics and refusals', async () => {
  await runPreset('methane-combustion');
  await lab.eval('lab.reaction.setConversion(0.5);');
  await shot('26-reaction-thermo-result');
  await lab.eval("lab.reaction.setTab('graphs');");
  await shot('27-reaction-thermo-graphs');

  await runPreset('ammonia-synthesis-700k');
  await lab.eval("lab.reaction.setTab('result');");
  await shot('28-reaction-outside-validated-range');

  await runPreset('iron-oxidation-missing-data');
  await shot('29-reaction-missing-data');

  await runPreset('methane-oxygen-no-products');
  await shot('30-reaction-no-products');
});
