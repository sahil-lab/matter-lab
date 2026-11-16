import { expect, test } from '@playwright/test';
import { Lab } from './lab';

let lab: Lab;

test.beforeEach(async ({ page }) => {
  lab = new Lab(page);
  await lab.open();
});

test.afterEach(() => lab.expectNoProblems());

interface Chemistry {
  status: string;
  ok: boolean | null;
  smiles: string | null;
  inchiKey: string | null;
  errors: string[];
  aromaticAtoms: number;
  radicals: number[];
  rdkitVersion: string | null;
}

/** RDKit's finished analysis of the scene that is on screen right now. */
async function chemistry(): Promise<Chemistry> {
  await lab.page.waitForFunction(
    () => {
      const api = (window as unknown as { __MATTERLAB__: { chem: { useChem: { getState(): { scene: unknown; status: string } } }; lab: { get(): { scene: unknown } } } }).__MATTERLAB__;
      const state = api.chem.useChem.getState();
      return state.scene === api.lab.get().scene && state.status !== 'pending';
    },
    undefined,
    { timeout: 30_000 },
  );
  return lab.eval(`
    const s = lab.chem.useChem.getState();
    const a = s.analysis;
    return {
      status: s.status,
      ok: a ? a.ok : null,
      smiles: a ? a.smiles : null,
      inchiKey: a ? a.inchiKey : null,
      errors: a ? [...a.errors] : [],
      aromaticAtoms: a ? a.aromaticAtomIds.size : 0,
      radicals: a ? [...a.radicalAtomIds.keys()] : [],
      rdkitVersion: a ? a.rdkitVersion : null,
    };`);
}

/**
 * Standard InChIKeys as published by PubChem (PUG REST, retrieved 2026-11-14) for the compounds in
 * the example library. They are an independent reference: the app derives its keys from the 3D
 * scene, through its own molfile writer and RDKit's perception of bonding and stereochemistry.
 */
const PUBCHEM_INCHIKEYS: Readonly<Record<string, string>> = {
  water: 'XLYOFNOQVPJJNP-UHFFFAOYSA-N',
  methane: 'VNWKTOKETHGBQD-UHFFFAOYSA-N',
  benzene: 'UHOVQNZJYSORNB-UHFFFAOYSA-N',
  ammonia: 'QGZKDVFQNNGYKY-UHFFFAOYSA-N',
  'carbon-dioxide': 'CURLTUGMZLYLDI-UHFFFAOYSA-N',
  ethene: 'VGGSQFUCUMXWEO-UHFFFAOYSA-N',
  ethyne: 'HSFWRNGVRCDJHI-UHFFFAOYSA-N',
  ethanol: 'LFQSCWFLJHTTHZ-UHFFFAOYSA-N',
  'acetic-acid': 'QTBSBXVTEAMEQO-UHFFFAOYSA-N',
  ammonium: 'QGZKDVFQNNGYKY-UHFFFAOYSA-O',
  glycine: 'DHMQDGOQFOQNFH-UHFFFAOYSA-N',
  cyclohexane: 'XDTMQSROBMDMFD-UHFFFAOYSA-N',
  adamantane: 'ORILYTVJVMAKLC-UHFFFAOYSA-N',
  glucose: 'WQZGKKKJIJFFOK-VFUOTHLCSA-N',
  aspirin: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
  caffeine: 'RYYVLZVUVIJVGH-UHFFFAOYSA-N',
};

test.describe('RDKit cross-check', () => {
  test('every library example is accepted and matches its published InChIKey', async () => {
    const examples = await lab.eval<Array<{ id: string; smiles: string }>>('return lab.examples();');
    expect(examples.map((e) => e.id).sort()).toEqual(Object.keys(PUBCHEM_INCHIKEYS).sort());

    for (const example of examples) {
      await lab.openExample(example.id);
      const result = await chemistry();
      expect(result, example.id).toMatchObject({ status: 'ready', ok: true, errors: [] });
      expect(result.inchiKey, example.id).toBe(PUBCHEM_INCHIKEYS[example.id]);

      // The scene read back from 3D must be the same molecule, stereochemistry included, as the SMILES it was built from.
      const source = await lab.eval<{ ok: boolean; smiles: string | null }>(`return lab.chem.smilesToMolblock(${JSON.stringify(example.smiles)});`);
      expect(source.ok, example.id).toBe(true);
      expect(result.smiles, example.id).toBe(source.smiles);
    }
  });

  test('shows identifiers and the verdict in the inspector', async ({ page }) => {
    await chemistry();
    await expect(page.getByTestId('smiles')).toHaveText('Cn1c(=O)c2c(ncn2C)n(C)c1=O');
    await expect(page.getByTestId('inchikey')).toHaveText('RYYVLZVUVIJVGH-UHFFFAOYSA-N');
    await expect(page.getByTestId('inchi')).toHaveText('InChI=1S/C8H10N4O2/c1-10-4-9-6-5(10)7(13)12(3)8(14)11(6)2/h4H,1-3H3');
    await expect(page.getByTestId('rdkit-verdict')).toContainText('Accepted by RDKit');
    expect((await chemistry()).aromaticAtoms).toBe(9);
  });

  test('follows edits: element, charge and isotope changes reach the identifiers', async () => {
    await lab.openExample('water');
    expect((await chemistry()).smiles).toBe('O');

    await lab.eval('lab.actions.changeElement([1], 16);');
    expect((await chemistry()).smiles).toBe('S');

    await lab.eval('lab.actions.undo();');
    const hydrogens = (await lab.atoms()).filter((a) => a.z === 1);
    for (const h of hydrogens) {
      await lab.eval(`lab.actions.setParticles(${h.id}, { neutrons: 1 }, 'Set isotope');`);
    }
    expect((await chemistry()).smiles).toBe('[2H]O[2H]');
  });

  test('reports a structure RDKit rejects, in the scene\'s own atom numbers', async ({ page }) => {
    await lab.openExample('methane');
    await lab.eval("lab.lab.set({ autoHydrogens: false, tool: 'build', buildElement: 1 });");
    const carbon = await lab.atomPoint(1);
    await lab.drag(carbon, [carbon[0] + 140, carbon[1] - 130]);
    const result = await chemistry();
    expect(result).toMatchObject({ status: 'ready', ok: false, smiles: null, inchiKey: null });
    expect(result.errors.join(' ')).toMatch(/valence/i);
    await expect(page.getByTestId('rdkit-verdict')).toContainText('does not accept');
    // RDKit says "atom # 0"; the interface must name the atom as the user knows it.
    await expect(page.getByTestId('inspector')).toContainText(/atom 1\b/);
    await expect(page.getByTestId('inspector')).not.toContainText('atom # 0');
  });

  test('recognises an unfilled valence as a radical centre', async () => {
    await lab.openExample('methane');
    await lab.eval('lab.lab.set({ autoHydrogens: false }); lab.actions.eraseAtoms([2]);');
    const result = await chemistry();
    expect(result).toMatchObject({ ok: true, smiles: '[CH3]', radicals: [1] });
  });
});

test.describe('structure search', () => {
  test('finds every example that contains a carboxylic acid group', async () => {
    const result = await lab.eval<{ ok: boolean; hits: Array<{ id: string; matchedAtoms: number[] }>; skipped: string[] }>(
      "return lab.chem.searchStructures('substructure', 'C(=O)[OH]', lab.examples());",
    );
    expect(result.ok).toBe(true);
    expect(result.skipped).toEqual([]);
    expect(result.hits.map((h) => h.id).sort()).toEqual(['acetic-acid', 'aspirin', 'glycine']);
    for (const hit of result.hits) expect(hit.matchedAtoms).toHaveLength(3);
  });

  test('ranks by fingerprint similarity, with identical structures at 1', async () => {
    const result = await lab.eval<{ ok: boolean; hits: Array<{ id: string; similarity: number }> }>(
      "return lab.chem.searchStructures('similarity', 'c1ccccc1', lab.examples());",
    );
    expect(result.ok).toBe(true);
    expect(result.hits).toHaveLength(16);
    expect(result.hits[0]).toMatchObject({ id: 'benzene', similarity: 1 });
    const scores = result.hits.map((h) => h.similarity);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    for (const score of scores) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
    // Water shares no fragment with benzene.
    expect(result.hits.find((h) => h.id === 'water')!.similarity).toBe(0);
  });

  test('rejects a query that is not a structure', async () => {
    const result = await lab.eval<{ ok: boolean; errors: string[]; hits: unknown[] }>(
      "return lab.chem.searchStructures('substructure', 'this is not smarts((', lab.examples());",
    );
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.hits).toEqual([]);
  });
});
