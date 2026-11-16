import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Lab, distance } from './lab';
import type { AtomRow } from './lab';

let lab: Lab;

test.beforeEach(async ({ page }) => {
  lab = new Lab(page);
  await lab.open();
});

// A lookup that is made to fail on purpose logs the failed request.
test.afterEach(() => lab.expectNoProblems([/Failed to load resource/]));

type V = readonly number[];
const sub = (a: V, b: V): number[] => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: V, b: V): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: V, b: V): number[] => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const degrees = (radians: number): number => (radians * 180) / Math.PI;

function angle(a: V, vertex: V, b: V): number {
  const u = sub(a, vertex);
  const w = sub(b, vertex);
  return degrees(Math.acos(dot(u, w) / Math.sqrt(dot(u, u) * dot(w, w))));
}

/** Dihedral angle a-b-c-d in degrees, IUPAC sign. */
function torsion(a: V, b: V, c: V, d: V): number {
  const b1 = sub(b, a);
  const b2 = sub(c, b);
  const b3 = sub(d, c);
  const n1 = cross(b1, b2);
  const n2 = cross(b2, b3);
  return degrees(Math.atan2(Math.sqrt(dot(b2, b2)) * dot(b1, n2), dot(n1, n2)));
}

interface Structure {
  atoms: AtomRow[];
  neighbours: Map<number, number[]>;
  at(id: number): AtomRow;
}

async function structure(): Promise<Structure> {
  const atoms = await lab.atoms();
  const neighbours = new Map<number, number[]>(atoms.map((atom) => [atom.id, []]));
  for (const bond of await lab.bonds()) {
    neighbours.get(bond.a)!.push(bond.b);
    neighbours.get(bond.b)!.push(bond.a);
  }
  const byId = new Map(atoms.map((atom) => [atom.id, atom]));
  return { atoms, neighbours, at: (id) => byId.get(id)! };
}

const inchiKey = (): Promise<string | null> => lab.eval('return lab.chem.analyseScene(lab.lab.get().scene).then((a) => a.inchiKey);');
const projectName = (): Promise<string> => lab.eval('return lab.lab.get().projectName;');

async function openFind(page: Page): Promise<void> {
  await lab.eval("lab.lab.set({ dialog: 'library' });");
  await page.getByRole('dialog', { name: 'Library' }).getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page.getByTestId('find')).toBeVisible();
}

/** Types a SMILES string and builds the model; resolves when the model or the refusal is on screen. */
async function build(page: Page, smiles: string): Promise<void> {
  await page.getByTestId('find-smiles').fill(smiles);
  await page.getByTestId('find-build').click();
  await expect(page.getByTestId('find-model').or(page.getByTestId('find-build-problem'))).toBeVisible({ timeout: 60_000 });
}

async function buildAndOpen(page: Page, smiles: string): Promise<void> {
  await openFind(page);
  await build(page, smiles);
  await page.getByTestId('find-model-open').click();
  await expect(page.getByRole('dialog', { name: 'Library' })).toHaveCount(0);
  await lab.settle(300);
}

/*
 * Reference identifiers: the SMILES and standard InChIKey PubChem publishes for each compound
 * (PUG REST, properties SMILES and InChIKey, retrieved 2026-11-15). The InChIKey of the model is
 * derived from its 3D coordinates, so it is the published one only if the model has the right
 * bonding and the right configuration at every stereocentre and double bond.
 */
const PUBLISHED: ReadonlyArray<{ name: string; cid: number; smiles: string; inchiKey: string; atoms: number }> = [
  { name: 'L-alanine', cid: 5950, smiles: 'C[C@@H](C(=O)O)N', inchiKey: 'QNAYBMKLOCPYGJ-REOHCLBHSA-N', atoms: 13 },
  { name: 'D-alanine', cid: 71080, smiles: 'C[C@H](C(=O)O)N', inchiKey: 'QNAYBMKLOCPYGJ-UWTATZPHSA-N', atoms: 13 },
  { name: 'dexibuprofen', cid: 39912, smiles: 'C[C@@H](C1=CC=C(C=C1)CC(C)C)C(=O)O', inchiKey: 'HEFNNWSXXWATRW-JTQLQIEISA-N', atoms: 33 },
  { name: 'cholesterol', cid: 5997, smiles: 'C[C@H](CCCC(C)C)[C@H]1CC[C@@H]2[C@@]1(CC[C@H]3[C@H]2CC=C4[C@@]3(CC[C@@H](C4)O)C)C', inchiKey: 'HVYWMOMLDIMFJA-DPAQBDIFSA-N', atoms: 74 },
  { name: 'beta-D-glucose', cid: 64689, smiles: 'C([C@@H]1[C@H]([C@@H]([C@H]([C@@H](O1)O)O)O)O)O', inchiKey: 'WQZGKKKJIJFFOK-VFUOTHLCSA-N', atoms: 24 },
  { name: 'trans-2-butene', cid: 62695, smiles: 'C/C=C/C', inchiKey: 'IAQRGUVFOMOMEM-ONEGZZNKSA-N', atoms: 12 },
  { name: 'cis-2-butene', cid: 5287573, smiles: 'C/C=C\\C', inchiKey: 'IAQRGUVFOMOMEM-ARJAWSKDSA-N', atoms: 12 },
  { name: 'cyclohexane', cid: 8078, smiles: 'C1CCCCC1', inchiKey: 'XDTMQSROBMDMFD-UHFFFAOYSA-N', atoms: 18 },
];

test.describe('a 3D model from SMILES', () => {
  test('has the identity PubChem publishes for the compound, stereochemistry included', async ({ page }) => {
    test.setTimeout(240_000);
    for (const reference of PUBLISHED) {
      await buildAndOpen(page, reference.smiles);
      const summary = await lab.summary();
      expect(summary.atoms, reference.name).toBe(reference.atoms);
      expect(await inchiKey(), reference.name).toBe(reference.inchiKey);
      // A relaxed model: no overlapping atoms, no stretched or squeezed bonds, every valence complete.
      expect(summary.errors, reference.name).toBe(0);
      expect(summary.warnings, reference.name).toBe(0);
      // Opened as a document of its own, named by its formula, with nothing to undo.
      expect(summary.undo).toBe(0);
    }
    expect(await projectName()).toBe('C6H12');
  });

  test('gives alanine the handedness asked for, measured on the model itself', async ({ page }) => {
    // Independent of RDKit: with the hydrogen pointing away from the viewer, N -> C(OOH) -> CH3 runs
    // anticlockwise in L-alanine (S) and clockwise in D-alanine (R). For three bond vectors that is
    // the sign of their triple product: positive for anticlockwise.
    const handedness = async (): Promise<number> => {
      const s = await structure();
      const nitrogen = s.atoms.find((a) => a.z === 7)!;
      const alpha = s.at(s.neighbours.get(nitrogen.id)!.find((id) => s.at(id).z === 6)!);
      const carbons = s.neighbours.get(alpha.id)!.filter((id) => s.at(id).z === 6).map(s.at);
      const carboxyl = carbons.find((c) => s.neighbours.get(c.id)!.some((id) => s.at(id).z === 8))!;
      const methyl = carbons.find((c) => c.id !== carboxyl.id)!;
      const hydrogen = s.at(s.neighbours.get(alpha.id)!.find((id) => s.at(id).z === 1)!);
      const [n, c, m, h] = [nitrogen, carboxyl, methyl, hydrogen].map((atom) => sub(atom.position, alpha.position)) as [number[], number[], number[], number[]];
      // The hydrogen is on the far side of the other three, as the rule assumes.
      expect(dot(h, [n[0]! + c[0]! + m[0]!, n[1]! + c[1]! + m[1]!, n[2]! + c[2]! + m[2]!])).toBeLessThan(0);
      return Math.sign(dot(n, cross(c, m)));
    };
    await buildAndOpen(page, 'C[C@@H](C(=O)O)N');
    expect(await handedness()).toBe(1);
    await buildAndOpen(page, 'C[C@H](C(=O)O)N');
    expect(await handedness()).toBe(-1);
  });

  test('puts the methyl groups of but-2-ene on the side the SMILES says, and lifts a flat ring into a chair', async ({ page }) => {
    const skeleton = async (): Promise<AtomRow[]> => {
      const s = await structure();
      const carbons = s.atoms.filter((a) => a.z === 6);
      const end = carbons.find((c) => s.neighbours.get(c.id)!.filter((id) => s.at(id).z === 6).length === 1)!;
      const chain = [end];
      while (chain.length < carbons.length) {
        const last = chain[chain.length - 1]!;
        chain.push(s.at(s.neighbours.get(last.id)!.find((id) => s.at(id).z === 6 && !chain.some((c) => c.id === id))!));
      }
      return chain;
    };
    const chainTorsion = async (): Promise<number> => {
      const [a, b, c, d] = (await skeleton()) as [AtomRow, AtomRow, AtomRow, AtomRow];
      return Math.abs(torsion(a.position, b.position, c.position, d.position));
    };
    await buildAndOpen(page, 'C/C=C/C');
    expect(await chainTorsion()).toBeGreaterThan(179);
    await buildAndOpen(page, 'C/C=C\\C');
    expect(await chainTorsion()).toBeLessThan(1);

    // Cyclohexane starts as a flat hexagon. A chair has ring torsions of alternating sign, near 55 degrees.
    await buildAndOpen(page, 'C1CCCCC1');
    const s = await structure();
    const ring = [s.atoms.find((a) => a.z === 6)!];
    while (ring.length < 6) {
      const last = ring[ring.length - 1]!;
      ring.push(s.at(s.neighbours.get(last.id)!.find((id) => s.at(id).z === 6 && !ring.some((c) => c.id === id))!));
    }
    const torsions = ring.map((_, i) => torsion(ring[i]!.position, ring[(i + 1) % 6]!.position, ring[(i + 2) % 6]!.position, ring[(i + 3) % 6]!.position));
    for (const [i, value] of torsions.entries()) {
      expect(Math.abs(value)).toBeGreaterThan(48);
      expect(Math.abs(value)).toBeLessThan(62);
      expect(Math.sign(value)).toBe(-Math.sign(torsions[(i + 1) % 6]!));
    }
  });

  test('says what the model was checked for and what the SMILES leaves open', async ({ page }) => {
    await openFind(page);
    await build(page, 'C[C@H](CCCC(C)C)[C@H]1CC[C@@H]2[C@@]1(CC[C@H]3[C@H]2CC=C4[C@@]3(CC[C@@H](C4)O)C)C');
    const model = page.getByTestId('find-model');
    await expect(model).toContainText('C27H46O');
    await expect(model).toContainText('74 atoms');
    await expect(model).toContainText('The SMILES states 8 stereocentres; the model was checked to have all of them as stated.');
    await expect(model).toContainText('not a measured structure');
    await expect(model).not.toContainText('open;');

    await build(page, 'CCC(C)O');
    await expect(model).toContainText('The SMILES leaves 1 possible stereocentre open; the model shows one of the possible arrangements');
    await expect(model).not.toContainText('The SMILES states');

    await build(page, 'CC=CC');
    await expect(model).toContainText('The SMILES leaves 1 double bond open');
    // Nothing was placed by building alone.
    expect((await lab.summary()).formula).toBe('C8H10N4O2');
  });

  test('offers no model when it cannot read the string, when it is too large, or when the configuration cannot be had', async ({ page }) => {
    const before = await lab.atoms();
    await openFind(page);
    const problem = page.getByTestId('find-build-problem');

    await build(page, 'C1CC');
    await expect(problem).toHaveText('RDKit cannot read this as a SMILES string.');
    await expect(page.getByTestId('find')).toContainText('unclosed ring');
    await expect(page.getByTestId('find-model')).toHaveCount(0);

    // 140 carbons carry 282 hydrogens: 422 atoms, above the limit of 400.
    await build(page, 'C'.repeat(140));
    await expect(problem).toContainText('the structure has 422 atoms; models are built from SMILES for up to 400');
    await expect(page.getByTestId('find-model')).toHaveCount(0);

    // A sulfoxide is a stereocentre the force field does not hold in shape. The model would have
    // the other configuration, so it is withheld rather than shown with a warning.
    await build(page, 'C[S@](=O)c1ccccc1');
    await expect(problem).toContainText('A model with the configuration this SMILES asks for could not be built, so none is offered.');
    await expect(page.getByTestId('find')).toContainText('S (atom 2 of the structure)');
    await expect(page.getByTestId('find-model')).toHaveCount(0);
    // Without the stereo mark the same compound is built, with its configuration declared open.
    await build(page, 'CS(=O)c1ccccc1');
    await expect(page.getByTestId('find-model')).toContainText('leaves 1 possible stereocentre open');

    await page.keyboard.press('Escape');
    expect(await lab.atoms()).toEqual(before);
    expect((await lab.summary()).undo).toBe(0);
  });

  test('keeps its controls where they are when results appear and when the library section changes', async ({ page }) => {
    await openFind(page);
    await lab.settle(500);
    const tabs = page.getByRole('group', { name: 'Library section' });
    const place = async (locator: ReturnType<Page['getByTestId']>): Promise<number[]> => {
      const box = (await locator.boundingBox())!;
      return [Math.round(box.x), Math.round(box.y)];
    };
    const tabsAt = await place(tabs);
    const buildAt = await place(page.getByTestId('find-build'));

    // A result with several lines of notes appears below the button; nothing above it may move.
    await build(page, 'C[C@H](CCCC(C)C)[C@H]1CC[C@@H]2[C@@]1(CC[C@H]3[C@H]2CC=C4[C@@]3(CC[C@@H](C4)O)C)C');
    await expect(page.getByTestId('find-model')).toBeVisible();
    expect(await place(tabs)).toEqual(tabsAt);
    expect(await place(page.getByTestId('find-build'))).toEqual(buildAt);

    // The sections differ in length; the switch between them stays under the pointer.
    for (const section of ['Examples', 'Saved', 'Files', 'Find']) {
      await tabs.getByRole('button', { name: section, exact: true }).click();
      await lab.settle(150);
      expect(await place(tabs), section).toEqual(tabsAt);
    }
  });

  test('is added beside the structure in the workspace as one edit that can be undone', async ({ page }) => {
    const caffeine = await lab.atoms();
    await openFind(page);
    await build(page, 'CCO');
    await page.getByTestId('find-model-add').click();
    await expect(page.getByRole('dialog', { name: 'Library' })).toHaveCount(0);
    await expect(page.getByTestId('toast').filter({ hasText: 'Added C2H6O' })).toBeVisible();

    const summary = await lab.summary();
    expect(summary.atoms).toBe(caffeine.length + 9);
    expect(summary.formula).toBe('C10H16N4O3');
    expect(summary.undo).toBe(1);
    expect(summary.selectedAtoms.length).toBe(9);
    // The caffeine did not move, and the ethanol is clear of it.
    const atoms = await lab.atoms();
    expect(atoms.slice(0, caffeine.length)).toEqual(caffeine);
    const added = atoms.filter((a) => summary.selectedAtoms.includes(a.id));
    for (const a of added) for (const c of caffeine) expect(distance(a.position, c.position)).toBeGreaterThan(2.5);

    await page.getByTestId('undo').click();
    expect(await lab.atoms()).toEqual(caffeine);
  });
});

const ASPIRIN = { CID: 2244, Title: 'Aspirin', MolecularFormula: 'C9H8O4', MolecularWeight: '180.16', InChIKey: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N', SMILES: 'CC(=O)OC1=CC=CC=C1C(=O)O', IUPACName: '2-acetyloxybenzoic acid', Charge: 0 };
const ACETATE = { CID: 175, Title: 'Acetate', MolecularFormula: 'C2H3O2-', MolecularWeight: '59.04', InChIKey: 'QTBSBXVTEAMEQO-UHFFFAOYSA-M', SMILES: 'CC(=O)[O-]', IUPACName: 'acetate', Charge: -1 };

/**
 * Stands in for PubChem: "aspirin" is a compound with a 3D model, "acetate" one without, anything
 * else is not listed. Returns the requests that were made.
 */
async function pubchem(page: Page, sdf: string, online: () => boolean = () => true): Promise<string[]> {
  const requests: string[] = [];
  await page.route('https://pubchem.ncbi.nlm.nih.gov/**', async (route) => {
    const url = decodeURIComponent(route.request().url());
    requests.push(url);
    if (!online()) return route.abort('internetdisconnected');
    const headers = { 'access-control-allow-origin': '*' };
    const json = (status: number, body: unknown) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
    const notFound = () => json(404, { Fault: { Code: 'PUGREST.NotFound', Message: 'No CID found' } });
    const name = /\/compound\/name\/([^/]+)\/cids\/JSON/.exec(url)?.[1]?.toLowerCase();
    if (name !== undefined) return name === 'aspirin' ? json(200, { IdentifierList: { CID: [2244] } }) : name === 'acetate' ? json(200, { IdentifierList: { CID: [175] } }) : notFound();
    const listed = /\/compound\/cid\/([\d,]+)\/property\//.exec(url)?.[1];
    if (listed !== undefined) return json(200, { PropertyTable: { Properties: listed.split(',').map((cid) => (cid === '2244' ? ASPIRIN : ACETATE)) } });
    if (/\/compound\/cid\/2244\/SDF\?record_type=3d/.test(url)) return route.fulfill({ status: 200, headers, contentType: 'chemical/x-mdl-sdfile', body: sdf });
    return notFound();
  });
  return requests;
}

test.describe('looking a compound up by name', () => {
  /** A 3D structure file of aspirin, as PubChem would send one: the example library's own model. */
  async function aspirinFile(): Promise<{ sdf: string; atoms: AtomRow[] }> {
    await lab.openExample('aspirin');
    const sdf = await lab.eval<string>("return lab.exportText('sdf');");
    const atoms = await lab.atoms();
    await lab.openExample('water');
    return { sdf, atoms };
  }

  test('lists what PubChem holds and opens its 3D model, saying what that model is', async ({ page }) => {
    const file = await aspirinFile();
    const requests = await pubchem(page, file.sdf);
    await openFind(page);
    await page.getByTestId('find-name').fill('aspirin');
    await page.getByTestId('find-name').press('Enter');
    const row = page.locator('[data-find-row="lookup:2244"]');
    await expect(row).toContainText('Aspirin');
    await expect(row).toContainText('CID 2244');
    await expect(row).toContainText('180.16 g/mol');
    await expect(row.getByRole('link')).toHaveAttribute('href', 'https://pubchem.ncbi.nlm.nih.gov/compound/2244');
    // Listing a compound fetches no structure and changes nothing.
    expect(requests.some((url) => url.includes('/SDF'))).toBe(false);
    expect((await lab.summary()).formula).toBe('H2O');

    await row.getByRole('button', { name: 'Open' }).click();
    await expect(page.getByRole('dialog', { name: 'Library' })).toHaveCount(0);
    await expect(page.getByTestId('toast').filter({ hasText: 'PubChem3D conformer of Aspirin (CID 2244): a computed model geometry (MMFF94s force field), not a measured structure.' })).toBeVisible();
    expect(await projectName()).toBe('Aspirin');
    expect(await inchiKey()).toBe(ASPIRIN.InChIKey);
    // The geometry is the one that was sent, moved as a whole so that it is centred.
    const atoms = await lab.atoms();
    expect(atoms.length).toBe(file.atoms.length);
    for (let i = 1; i < atoms.length; i++) {
      expect(atoms[i]!.z).toBe(file.atoms[i]!.z);
      expect(distance(atoms[i]!.position, atoms[0]!.position)).toBeCloseTo(distance(file.atoms[i]!.position, file.atoms[0]!.position), 3);
    }
    const centre = [0, 1, 2].map((k) => atoms.reduce((sum, a) => sum + a.position[k]!, 0) / atoms.length);
    expect(Math.hypot(...centre)).toBeLessThan(1e-6);
  });

  test('builds the model itself when PubChem has none, and says so', async ({ page }) => {
    const file = await aspirinFile();
    await pubchem(page, file.sdf);
    await openFind(page);
    await page.getByTestId('find-name').fill('acetate');
    await page.getByTestId('find-lookup').click();
    const row = page.locator('[data-find-row="lookup:175"]');
    await expect(row).toContainText('Acetate');
    await row.getByRole('button', { name: 'Open' }).click();
    await expect(page.getByRole('dialog', { name: 'Library' })).toHaveCount(0);
    const toast = page.getByTestId('toast').filter({ hasText: 'Opened Acetate' });
    await expect(toast).toContainText('PubChem holds no 3D model of Acetate (CID 175); this one was built here from the SMILES PubChem gives for it.');
    await expect(toast).toContainText('the Universal Force Field the shape');
    expect(await projectName()).toBe('Acetate');
    expect(await inchiKey()).toBe(ACETATE.InChIKey);
    expect((await lab.summary()).formula).toBe('C2H3O2-');
  });

  test('does not mistake "not listed" or "not reachable" for anything else, and changes nothing', async ({ page }) => {
    const file = await aspirinFile();
    let online = true;
    await pubchem(page, file.sdf, () => online);
    const before = await lab.atoms();
    await openFind(page);

    await page.getByTestId('find-name').fill('zzzunobtainium');
    await page.getByTestId('find-lookup').click();
    await expect(page.getByTestId('find-no-compound')).toContainText('PubChem lists no compound under “zzzunobtainium”. That says nothing about whether such a compound exists');
    await expect(page.getByTestId('find-compounds')).toHaveCount(0);

    online = false;
    await page.getByTestId('find-name').fill('aspirin');
    await page.getByTestId('find-lookup').click();
    await expect(page.getByTestId('find-lookup-problem')).toHaveText('PubChem could not be reached. Check the network connection.');
    await expect(page.getByTestId('find-no-compound')).toHaveCount(0);
    await expect(page.getByTestId('find-compounds')).toHaveCount(0);

    // Back online the compound is listed; if the connection then drops while its model is fetched, nothing is opened.
    online = true;
    await page.getByTestId('find-lookup').click();
    const row = page.locator('[data-find-row="lookup:2244"]');
    await expect(row).toBeVisible();
    online = false;
    await row.getByRole('button', { name: 'Open' }).click();
    await expect(page.getByTestId('find-place-problem')).toHaveText('PubChem could not be reached. Check the network connection.');
    await expect(page.getByRole('dialog', { name: 'Library' })).toBeVisible();
    expect(await lab.atoms()).toEqual(before);
  });

  test('finds caffeine in the real PubChem and opens its conformer', async ({ page }) => {
    const reachable = await page.evaluate(async () => {
      try {
        const response = await fetch('https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/2519/property/MolecularFormula/JSON', { signal: AbortSignal.timeout(12_000) });
        return response.ok;
      } catch {
        return false;
      }
    });
    test.skip(!reachable, 'PubChem cannot be reached from this machine right now, so the live lookup was not exercised.');
    await lab.openExample('water');
    await openFind(page);
    await page.getByTestId('find-name').fill('caffeine');
    await page.getByTestId('find-lookup').click();
    const row = page.locator('[data-find-row="lookup:2519"]');
    await expect(row).toContainText('Caffeine', { timeout: 30_000 });
    await row.getByRole('button', { name: 'Open' }).click();
    await expect(page.getByRole('dialog', { name: 'Library' })).toHaveCount(0, { timeout: 30_000 });
    expect((await lab.summary()).formula).toBe('C8H10N4O2');
    expect(await inchiKey()).toBe('RYYVLZVUVIJVGH-UHFFFAOYSA-N');
  });
});

test.describe('searching the built-in library by structure', () => {
  test('finds exactly the structures that contain a carboxylic acid group', async ({ page }) => {
    await openFind(page);
    await page.getByTestId('find-pattern').fill('C(=O)[OH]');
    await page.getByTestId('find-search').click();
    // Of the 63 structures, these four have a carbon that carries both =O and -OH; carbonate, the
    // peroxy compounds and the esters do not.
    await expect(page.getByTestId('find-search-summary')).toHaveText('4 of the 63 library structures searched contain the pattern.');
    const rows = page.getByTestId('find-hits').locator('[data-find-row]');
    await expect(rows).toHaveCount(4);
    const names = await rows.locator('.ml-find__title').allTextContents();
    expect([...names].sort()).toEqual(['Acetic acid', 'Aspirin', 'Bicarbonate Ion', 'Glycine']);

    await page.getByTestId('find-pattern').fill('C(=O)([OH');
    await page.getByTestId('find-search').click();
    await expect(page.getByTestId('find-search-problem')).toHaveText('RDKit cannot read the query as a SMARTS or SMILES pattern.');
    await expect(page.getByTestId('find-hits')).toHaveCount(0);
  });

  test('ranks by similarity to a structure, the one in the workspace included', async ({ page }) => {
    await openFind(page);
    await page.getByRole('button', { name: 'Similar to' }).click();
    await page.getByTestId('find-pattern').fill('CCO');
    await page.getByTestId('find-search').click();
    const rows = page.getByTestId('find-hits').locator('[data-find-row]');
    await expect(rows.first()).toContainText('Ethanol');
    await expect(rows.first()).toContainText('similarity 1.00');
    const scores = (await rows.locator('.ml-find__meta').allTextContents()).map((text) => Number(/similarity (\d\.\d\d)/.exec(text)![1]));
    expect(scores.length).toBeGreaterThan(1);
    for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
    expect(Math.min(...scores)).toBeGreaterThanOrEqual(0.15);
    await expect(page.getByTestId('find-search-summary')).toContainText('Tanimoto similarity of at least 0.15 (Morgan fingerprints, radius 2)');

    // The workspace holds caffeine; its own SMILES finds the library's caffeine as identical.
    await page.getByTestId('find-use-current').click();
    await expect(page.getByTestId('find-pattern')).toHaveValue('Cn1c(=O)c2c(ncn2C)n(C)c1=O');
    await page.getByTestId('find-search').click();
    await expect(rows.first()).toContainText('Caffeine');
    await expect(rows.first()).toContainText('similarity 1.00');
  });

  test('reads no stereochemistry from the flat drawings of species without a 3D model', async () => {
    // Where PubChem has no conformer the library holds a flat drawing. Read as a geometry, the four
    // fluorines of germanium tetrafluoride would be "square planar" and its SMILES would say so.
    const entries = await lab.eval<Array<{ name: string; smiles: string | null }>>('return lab.library.localLibrary().then((list) => list.map((e) => ({ name: e.name, smiles: e.smiles })));');
    expect(entries.length).toBe(63);
    expect(entries.filter((e) => e.smiles === null)).toEqual([]);
    // Glucose, whose model is a real geometry, is the only library structure with stereocentres.
    expect(entries.filter((e) => e.smiles!.includes('@')).map((e) => e.name)).toEqual(['Glucose']);
    expect(entries.find((e) => e.name === 'Germanium tetrafluoride')!.smiles).toBe('[F][Ge]([F])([F])[F]');
  });

  test('opens a library structure, computing a shape where the library has only a drawing', async ({ page }) => {
    await openFind(page);
    await page.getByTestId('find-pattern').fill('[Ge]');
    await page.getByTestId('find-search').click();
    const row = page.locator('[data-find-row="library:pubchem:82215"]');
    await expect(row).toContainText('Germanium tetrafluoride');
    await row.getByRole('button', { name: 'Open' }).click();
    await expect(page.getByRole('dialog', { name: 'Library' })).toHaveCount(0);
    await expect(page.getByTestId('toast').filter({ hasText: 'the shape is a Universal Force Field model geometry, not a measured structure' })).toBeVisible();
    expect(await projectName()).toBe('Germanium tetrafluoride');
    const s = await structure();
    const germanium = s.atoms.find((a) => a.z === 32)!;
    const fluorines = s.atoms.filter((a) => a.z === 9);
    expect(fluorines.length).toBe(4);
    // Tetrahedral, not the right angles of the drawing.
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(angle(fluorines[i]!.position, germanium.position, fluorines[j]!.position)).toBeCloseTo(109.47, 1);

    // A structure with a model of its own is opened as it is: methanol, the only one with a methyl group on a hydroxyl.
    await openFind(page);
    await page.getByTestId('find-pattern').fill('[CH3][OH]');
    await page.getByTestId('find-search').click();
    await expect(page.getByTestId('find-hits').locator('[data-find-row]')).toHaveCount(1);
    const methanol = page.locator('[data-find-row="library:pubchem:887"]');
    await methanol.getByRole('button', { name: 'Open' }).click();
    await expect(page.getByTestId('toast').filter({ hasText: 'PubChem3D conformer of Methanol (CID 887): a computed model geometry (MMFF94s), not a measured structure.' })).toBeVisible();
    expect((await lab.summary()).formula).toBe('CH4O');
    expect(await inchiKey()).toBe('OKKJLVBELUTLKV-UHFFFAOYSA-N');
  });
});
