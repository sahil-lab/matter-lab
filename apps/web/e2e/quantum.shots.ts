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
  await lab.settle(900);
  await lab.page.screenshot({ path: `${OUT}${name}.png` });
}

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

async function calculate(example: string): Promise<void> {
  await lab.openExample(example);
  await lab.eval("lab.lab.set({ inspectorTab: 'compute' }); return lab.quantum.runQuantum();");
  await idle();
}

test('orbitals of water', async () => {
  await calculate('water');
  await shot('31-quantum-water-homo');

  await lab.eval('lab.quantum.setField({ orbital: 2, orbitalIso: 0.08 });');
  await idle();
  await shot('32-quantum-water-bonding-orbital');

  await lab.eval("lab.quantum.setField({ kind: 'orbital', style: 'cloud', orbital: 4, dots: 60000 });");
  await idle();
  await shot('33-quantum-water-orbital-cloud');
});

test('density, potential and cutting plane of water', async () => {
  await calculate('water');
  await lab.eval("lab.quantum.setField({ kind: 'density', style: 'surface', densityIso: 0.05 });");
  await idle();
  await shot('34-quantum-water-density');

  await lab.eval("lab.quantum.setField({ kind: 'potential' });");
  await idle();
  await shot('35-quantum-water-potential');

  await lab.eval("lab.quantum.setField({ kind: 'density', densityIso: 0.002, opacity: 0.4 }); lab.quantum.setSlice({ enabled: true, field: 'density', axis: 'z', offset: 0, cut: true });");
  await idle();
  await shot('36-quantum-water-plane-density');

  await lab.eval("lab.quantum.setField({ kind: 'off' }); lab.quantum.setSlice({ enabled: true, field: 'potential', cut: false });");
  await idle();
  await shot('37-quantum-water-plane-potential');
});

test('benzene: pi orbital, potential and molecular surface', async () => {
  await calculate('benzene');
  await lab.eval('lab.viewApi.setStandardView("iso");');
  await shot('38-quantum-benzene-homo');

  await lab.eval("lab.quantum.setField({ kind: 'potential' });");
  await idle();
  await shot('39-quantum-benzene-potential');

  await lab.eval("lab.quantum.setField({ kind: 'off' }); lab.quantum.setMolecular({ enabled: true, kind: 'vdw', coloring: 'element', opacity: 0.6 });");
  await idle();
  await shot('40-molecular-surface-benzene');
});

test('molecular surface of caffeine and an unsupported system', async () => {
  await lab.openExample('caffeine');
  await lab.eval("lab.lab.set({ inspectorTab: 'compute' }); lab.quantum.setMolecular({ enabled: true, kind: 'sas', coloring: 'element', opacity: 0.5 });");
  await idle();
  await shot('41-molecular-surface-caffeine-sas');
});
