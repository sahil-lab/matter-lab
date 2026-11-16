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

async function idle(): Promise<void> {
  await lab.page.waitForFunction(() => (window as unknown as { __MATTERLAB__: { vault: { useVault: { getState(): { busy: unknown } } } } }).__MATTERLAB__.vault.useVault.getState().busy === null);
  await lab.settle(200);
}

/** 2-fluoroethanol, made from the built-in ethanol: valid, and not one of the built-in library's structures. */
async function fluoroethanol(): Promise<void> {
  await lab.openExample('ethanol');
  const atoms = await lab.atoms();
  const bonds = await lab.bonds();
  const carbons = new Set(atoms.filter((a) => a.z === 6).map((a) => a.id));
  const hydrogens = new Set(atoms.filter((a) => a.z === 1).map((a) => a.id));
  const bond = bonds.find((b) => (carbons.has(b.a) && hydrogens.has(b.b)) || (carbons.has(b.b) && hydrogens.has(b.a)))!;
  await lab.eval(`lab.actions.changeElement([${hydrogens.has(bond.a) ? bond.a : bond.b}], 9);`);
}

test('discovery vault', async () => {
  await fluoroethanol();
  await lab.eval("lab.actions.enterWorkspace('vault');");
  await lab.page.getByTestId('vault-side').waitFor();
  await shot('50-vault-empty');

  // Only the built-in library is searched: the status says exactly that and no more.
  await lab.eval("return lab.vault.addCandidate({ title: '2-Fluoroethanol (library only)' });");
  await idle();
  await shot('51-vault-no-match-in-searched-catalogues');

  await lab.eval("lab.vault.setVaultTab('searches');");
  await shot('52-vault-searches-library-only');

  // The same structure with PubChem asked as well. PubChem holds this compound, so the candidate is recognised
  // as catalogued; if PubChem cannot be reached, the screenshot shows the failed search instead.
  await lab.eval("return lab.vault.searchAgain(lab.vault.selectedCandidate().id, true);");
  await idle();
  await shot('53-vault-searches-with-pubchem');
  await lab.eval("lab.vault.setVaultTab('status');");
  await shot('54-vault-recognised-as-catalogued');

  // A second candidate, taken up the ladder with a calculation and compared with its optimised geometry.
  await lab.eval("return lab.vault.addCandidate({ title: 'Candidate B' });");
  await idle();
  await lab.eval("return lab.vault.runCalculation(lab.vault.selectedCandidate().id, 'uff');");
  await idle();
  await lab.eval("return lab.vault.runCalculation(lab.vault.selectedCandidate().id, 'rhf');");
  await idle();
  await lab.eval("return lab.vault.advanceStatus(lab.vault.selectedCandidate().id, 'Force-field minimum and converged SCF');");
  await lab.eval("lab.vault.setVaultTab('evidence'); lab.vault.setCompareOptimised(true);");
  await shot('55-vault-evidence-and-comparison');
  await lab.eval("lab.vault.setVaultTab('status'); lab.vault.setCompareOptimised(false);");
  await shot('56-vault-computationally-plausible');
});
