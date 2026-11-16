import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Lab } from './lab';

let lab: Lab;

test.beforeEach(async ({ page }) => {
  lab = new Lab(page);
  await lab.open();
});

// A lookup that finds nothing answers 404, and a provoked disconnection fails: the browser logs both by itself.
test.afterEach(() => lab.expectNoProblems([/Failed to load resource/]));

/** Words that would turn "it was not found where we looked" into "it is new". */
const CLAIMS = /\b(novel|new compound|new molecule|unknown compound|undiscovered|unprecedented|first (ever|time)|you (have )?discovered|is a discovery|congratulations)\b/i;

type PubChem = 'no-record' | 'record' | 'offline';

/**
 * Answers PubChem's PUG REST requests from the test instead of the network, so that each outcome a
 * search can have is reproducible. Returns the list of requests that were made.
 */
async function pubchem(page: Page, mode: () => PubChem): Promise<string[]> {
  const requests: string[] = [];
  await page.unroute('https://pubchem.ncbi.nlm.nih.gov/**');
  await page.route('https://pubchem.ncbi.nlm.nih.gov/**', async (route) => {
    const url = decodeURIComponent(route.request().url());
    requests.push(url);
    const answer = (status: number, body: unknown) => route.fulfill({ status, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify(body) });
    if (mode() === 'offline') return route.abort('internetdisconnected');
    if (/\/compound\/inchikey\/[^/]+\/cids\/JSON/.test(url)) {
      return mode() === 'record' ? answer(200, { IdentifierList: { CID: [987654] } }) : answer(404, { Fault: { Code: 'PUGREST.NotFound', Message: 'No CID found' } });
    }
    if (/\/fastsimilarity_2d\//.test(url)) return answer(200, { IdentifierList: { CID: [702, 6351] } });
    const cids = /\/compound\/cid\/([\d,]+)\/property\//.exec(url)?.[1];
    if (cids) {
      const names: Record<string, string> = { '987654': 'Record held by the test catalogue', '702': 'Ethanol', '6351': 'Ethylene glycol' };
      return answer(200, { PropertyTable: { Properties: cids.split(',').map((cid) => ({ CID: Number(cid), Title: names[cid] ?? `CID ${cid}`, MolecularFormula: 'C2H6O', MolecularWeight: '46.07', InChIKey: 'TESTTESTTESTTE-UHFFFAOYSA-N', SMILES: 'CCO', Charge: 0 })) } });
    }
    return answer(404, { Fault: { Code: 'PUGREST.NotFound' } });
  });
  return requests;
}

async function idle(): Promise<void> {
  await lab.page.waitForFunction(() => (window as unknown as { __MATTERLAB__: { vault: { useVault: { getState(): { busy: unknown; loaded: boolean } } } } }).__MATTERLAB__.vault.useVault.getState().busy === null);
  await lab.settle(150);
}

async function enterVault(): Promise<void> {
  await lab.page.getByRole('button', { name: 'Vault' }).click();
  await expect(lab.page.getByTestId('vault-side')).toBeVisible();
  await lab.page.waitForFunction(() => (window as unknown as { __MATTERLAB__: { vault: { useVault: { getState(): { loaded: boolean } } } } }).__MATTERLAB__.vault.useVault.getState().loaded);
}

/** Adds the Architect's structure as a candidate through the form, the way a user does. */
async function addCandidate(title: string, askPubChem = false): Promise<void> {
  const page = lab.page;
  await page.getByTestId('vault-title').fill(title);
  if (askPubChem) await page.getByTestId('vault-side').getByTestId('vault-pubchem').check();
  await page.getByTestId('vault-add').click();
  await page.waitForFunction(() => (window as unknown as { __MATTERLAB__: { vault: { useVault: { getState(): { selectedId: string | null } } } } }).__MATTERLAB__.vault.useVault.getState().selectedId !== null);
  await idle();
}

interface Stored {
  id: string;
  title: string;
  status: string;
  structureValid: boolean;
  formula: string;
  smiles: string | null;
  inchiKey: string | null;
  searches: Array<{ catalogue: string; method: string; outcome: string; recordsSearched: number | null; matches: Array<{ id: string; name: string; similarity?: number }>; detail: string; searchedAt: string }>;
  evidence: Array<{ kind: string; summary: string; recordedBy: string; reference?: string; converged?: boolean; statusBefore?: string; statusAfter?: string }>;
}

const selected = (): Promise<Stored> => lab.eval('return JSON.parse(JSON.stringify(lab.vault.selectedCandidate()));');

/** Everything the Vault says on screen: both panels and the banner. */
async function vaultText(): Promise<string> {
  const parts = await Promise.all(['vault-side', 'vault-candidate', 'vault-banner'].map((id) => lab.page.getByTestId(id).innerText()));
  return parts.join('\n');
}

/** 2-fluoroethanol, made from the built-in ethanol: a valid structure that the built-in library does not hold. */
async function fluoroethanol(): Promise<void> {
  await lab.openExample('ethanol');
  const atoms = await lab.atoms();
  const bonds = await lab.bonds();
  const carbons = new Set(atoms.filter((a) => a.z === 6).map((a) => a.id));
  const hydrogens = new Set(atoms.filter((a) => a.z === 1).map((a) => a.id));
  const bond = bonds.find((b) => (carbons.has(b.a) && hydrogens.has(b.b)) || (carbons.has(b.b) && hydrogens.has(b.a)))!;
  await lab.eval(`lab.actions.changeElement([${hydrogens.has(bond.a) ? bond.a : bond.b}], 9);`);
  expect((await lab.summary()).formula).toBe('C2H5FO');
}

test.describe('Discovery Vault', () => {
  test('recognises a compound that is already catalogued and does not let it climb', async ({ page }) => {
    await lab.openExample('aspirin');
    await enterVault();
    await expect(page.getByTestId('vault-explainer')).toBeVisible();
    await expect(page.getByTestId('vault-architect-structure')).toContainText('21 atoms');
    await addCandidate('My aspirin');

    const candidate = await selected();
    expect(candidate.structureValid).toBe(true);
    expect(candidate.status).toBe('structurally-validated');
    // The InChIKey PubChem publishes for aspirin (CID 2244).
    expect(candidate.inchiKey).toBe('BSYNRYMUTXBXSQ-UHFFFAOYSA-N');
    const identity = candidate.searches.find((s) => s.method === 'exact-inchikey')!;
    expect(identity).toMatchObject({ catalogue: 'matterlab-library', outcome: 'match' });
    expect(identity.matches[0]!.name).toBe('Aspirin');
    expect(identity.recordsSearched).toBeGreaterThan(60);

    await expect(page.getByTestId('vault-status').first()).toHaveText('Structurally validated');
    await expect(page.getByTestId('vault-meaning')).toContainText('An identical structure is on record: Aspirin in MATTER LAB built-in library');
    await expect(page.getByTestId('rung-no-match-in-searched-catalogues')).toHaveAttribute('data-state', 'closed');
    await expect(page.getByTestId('vault-missing')).toContainText('this rung does not apply');
    await expect(page.getByTestId('vault-advance')).toHaveCount(0);
    // Nothing was sent anywhere: PubChem was not asked.
    expect(candidate.searches.every((s) => s.catalogue === 'matterlab-library')).toBe(true);

    await page.getByRole('button', { name: 'Searches' }).click();
    await expect(page.getByTestId('vault-found')).toContainText('On record: Aspirin');
    // The most similar library structure to aspirin is aspirin itself.
    const similarity = candidate.searches.find((s) => s.method === 'similarity')!;
    expect(similarity.matches[0]).toMatchObject({ name: 'Aspirin', similarity: 1 });
  });

  test('describes a structure found in no searched catalogue as a candidate, never as something new', async ({ page }) => {
    const requests = await pubchem(page, () => 'no-record');
    await fluoroethanol();
    const architectBefore = await lab.atoms();
    await enterVault();
    await addCandidate('Candidate A', true);

    const candidate = await selected();
    expect(candidate).toMatchObject({ title: 'Candidate A', formula: 'C2H5FO', structureValid: true, smiles: 'OCCF', status: 'no-match-in-searched-catalogues' });
    expect(candidate.inchiKey).toMatch(/^[A-Z]{14}-[A-Z]{10}-[A-Z]$/);
    expect(candidate.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // Two catalogues were asked for the identical structure, and each search is on record with what it covered.
    const identity = candidate.searches.filter((s) => s.method === 'exact-inchikey');
    expect(identity.map((s) => [s.catalogue, s.outcome])).toEqual([
      ['matterlab-library', 'no-match'],
      ['pubchem', 'no-match'],
    ]);
    expect(identity[0]!.recordsSearched).toBeGreaterThan(60);
    expect(identity[1]!.recordsSearched).toBeNull();
    expect(requests.some((url) => url.includes(`/compound/inchikey/${candidate.inchiKey}/cids/JSON`))).toBe(true);

    await expect(page.getByTestId('vault-status').first()).toHaveText('No match in searched catalogues');
    const meaning = page.getByTestId('vault-meaning');
    await expect(meaning).toContainText('No identical structure was found in the catalogues that were searched');
    await expect(meaning).toContainText('Other databases and the literature were not searched');
    await expect(page.getByTestId('vault-banner')).toContainText('A candidate for investigation');
    await expect(page.getByTestId('vault-id')).toHaveText(candidate.id);

    await page.getByRole('button', { name: 'Searches' }).click();
    const catalogues = page.getByTestId('vault-catalogues');
    await expect(catalogues).toContainText('MATTER LAB built-in library');
    await expect(catalogues).toContainText('records searched');
    await expect(catalogues).toContainText('PubChem Compound');
    await expect(catalogues).toContainText('size of the collection not reported');
    // Similar structures are listed for orientation, most similar first, each with its score. The candidate
    // itself is not in the library, so nothing scores 1.
    const similarity = candidate.searches.find((s) => s.catalogue === 'matterlab-library' && s.method === 'similarity')!;
    expect(similarity.outcome).toBe('match');
    const scores = similarity.matches.map((m) => m.similarity!);
    expect(scores.length).toBeGreaterThan(0);
    expect(scores.length).toBeLessThanOrEqual(6);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(scores[0]!).toBeLessThan(1);
    expect(scores[scores.length - 1]!).toBeGreaterThanOrEqual(0.15);
    test.info().annotations.push({ type: 'library structures most similar to 2-fluoroethanol', description: similarity.matches.map((m) => `${m.name} ${m.similarity!.toFixed(2)}`).join(', ') });
    const listed = page.getByTestId('vault-similar').first();
    for (const match of similarity.matches) await expect(listed).toContainText(match.name);
    await expect(listed).toContainText(scores[0]!.toFixed(2));
    // PubChem's own list of similar compounds is shown separately, without scores, because PubChem returns none.
    await expect(page.getByTestId('vault-similar').nth(1)).toContainText('Ethylene glycol');
    await expect(page.getByTestId('vault-similar').nth(1)).toContainText('PubChem does not return the scores');

    // Nothing the Vault says, on any tab, claims novelty.
    for (const tab of ['Status', 'Searches', /^Evidence/]) {
      await page.getByRole('button', { name: tab }).click();
      expect(await vaultText()).not.toMatch(CLAIMS);
    }
    for (const entry of candidate.evidence) expect(entry.summary).not.toMatch(CLAIMS);

    // The stage shows the candidate as recorded, and the Architect's document was not touched.
    expect((await lab.atoms()).length).toBe(9);
    await page.getByRole('button', { name: 'Architect' }).click();
    expect(await lab.atoms()).toEqual(architectBefore);
  });

  test('reports a lookup that failed as failed, and does not count it as a search', async ({ page }) => {
    await pubchem(page, () => 'offline');
    await fluoroethanol();
    await enterVault();
    await addCandidate('Offline', true);

    const candidate = await selected();
    const pubchemSearch = candidate.searches.find((s) => s.catalogue === 'pubchem' && s.method === 'exact-inchikey')!;
    expect(pubchemSearch.outcome).toBe('error');
    expect(pubchemSearch.detail).toContain('PubChem could not be reached');
    // The library search completed, so that is what the status rests on; PubChem is not listed as searched.
    expect(candidate.status).toBe('no-match-in-searched-catalogues');
    await page.getByRole('button', { name: 'Searches' }).click();
    await expect(page.getByTestId('vault-catalogues')).not.toContainText('PubChem');
    await expect(page.getByTestId('vault-search-failed')).toContainText('did not complete');
    const trail = candidate.evidence.find((e) => e.summary.startsWith('PubChem Compound: the search did not complete'))!;
    expect(trail.summary).toContain('does not count as a search');
  });

  test('is climbed one rung at a time, each rung on its own evidence', async ({ page }) => {
    await fluoroethanol();
    await enterVault();
    await addCandidate('Climber');
    const recorded = await lab.atoms();

    // "Computationally plausible" needs a converged calculation.
    await expect(page.getByTestId('vault-advance')).toHaveCount(0);
    await expect(page.getByTestId('vault-missing')).toContainText('A calculation for this structure that converged has to be attached');
    expect(await lab.eval<string | null>("return lab.vault.advanceStatus(lab.vault.selectedCandidate().id, 'because I say so');")).toContain('converged');
    expect((await selected()).status).toBe('no-match-in-searched-catalogues');

    await page.getByRole('button', { name: /^Evidence/ }).click();
    await page.getByTestId('vault-run-uff').click();
    await idle();
    let candidate = await selected();
    const calculation = candidate.evidence.find((e) => e.kind === 'calculation')!;
    expect(calculation).toMatchObject({ converged: true, recordedBy: 'matterlab' });
    expect(calculation.summary).toMatch(/Universal Force Field geometry optimisation converged to a minimum in \d+ steps: energy .+ kcal\/mol, RMS displacement \d\.\d{3} Å/);
    await expect(page.getByTestId('vault-evidence').filter({ hasText: 'Calculation · converged' })).toHaveCount(1);

    // Comparing with the optimised geometry draws an outline and leaves the record alone.
    await page.getByTestId('vault-compare').click();
    await lab.settle(200);
    expect(await lab.atoms()).toEqual(recorded);
    // The outline on stage is the candidate's own skeleton at the optimised positions: nine atoms, eight bonds,
    // displaced from the recorded positions by exactly what the calculation reported.
    const outline = await lab.eval<{ positions: number[]; bonds: number[] } | null>('const g = lab.stageContents().ghost; return g ? { positions: Array.from(g.positions), bonds: Array.from(g.bonds) } : null;');
    expect(outline).not.toBeNull();
    expect(outline!.positions.length).toBe(27);
    expect(outline!.bonds.length).toBe(16);
    const byId = [...recorded].sort((a, b) => a.id - b.id);
    let sum = 0;
    byId.forEach((atom, i) => {
      for (let k = 0; k < 3; k++) sum += (outline!.positions[3 * i + k]! - atom.position[k]!) ** 2;
    });
    const displacement = Number(/RMS displacement (\d\.\d{3}) Å/.exec(calculation.summary)![1]!);
    expect(displacement).toBeGreaterThan(0.01);
    expect(Math.abs(Math.sqrt(sum / byId.length) - displacement)).toBeLessThan(0.001);
    // The note states the calculation's own figure, rounded once from the unrounded value.
    const exact = await lab.eval<number>("return lab.vault.selectedCandidate().evidence.find((e) => e.kind === 'calculation').details.rmsDisplacementAngstrom;");
    expect(Math.abs(exact - displacement)).toBeLessThanOrEqual(0.0005);
    await expect(page.getByTestId('vault-compare-note')).toContainText(`They differ by ${exact.toFixed(2)} Å`);
    await page.getByTestId('vault-compare').click();
    await expect(page.getByTestId('vault-compare-note')).toHaveCount(0);
    expect(await lab.eval<boolean>('return lab.stageContents().ghost === null;')).toBe(true);

    await page.getByRole('button', { name: 'Status' }).click();
    await page.getByTestId('vault-justification').fill('UFF minimum found');
    await page.getByTestId('vault-advance').click();
    await expect(page.getByTestId('vault-status').first()).toHaveText('Computationally plausible');
    await expect(page.getByTestId('vault-meaning')).toContainText('A calculation is the result of a model, not an observation');
    candidate = await selected();
    expect(candidate.evidence[candidate.evidence.length - 1]).toMatchObject({ kind: 'status-change', recordedBy: 'user', statusBefore: 'no-match-in-searched-catalogues', statusAfter: 'computationally-plausible' });
    expect(candidate.evidence[candidate.evidence.length - 1]!.summary).toContain('UFF minimum found');

    // "Experimentally observed" needs an observation, and an observation needs a reference.
    await expect(page.getByTestId('vault-missing')).toContainText('An experimental observation with a reference has to be attached');
    await page.getByRole('button', { name: /^Evidence/ }).click();
    await page.getByTestId('vault-evidence-summary').fill('Observed by 19F NMR in the crude product');
    await page.getByTestId('vault-evidence-add').click();
    await expect(page.getByTestId('vault-evidence-refused')).toContainText('A reference is required');
    expect((await selected()).evidence.some((e) => e.kind === 'experimental-observation')).toBe(false);
    await page.getByTestId('vault-evidence-reference').fill('Lab notebook 12, p. 44');
    await page.getByTestId('vault-evidence-add').click();
    await expect(page.getByTestId('vault-evidence-refused')).toHaveCount(0);
    const observation = page.getByTestId('vault-evidence').filter({ hasText: 'Observed by 19F NMR' });
    await expect(observation).toContainText('Reference: Lab notebook 12, p. 44');
    await expect(observation).toContainText('stated by the user, not verified');

    await page.getByRole('button', { name: 'Status' }).click();
    await page.getByTestId('vault-advance').click();
    await expect(page.getByTestId('vault-status').first()).toHaveText('Experimentally observed');
    await expect(page.getByTestId('vault-meaning')).toContainText('MATTER LAB records it as stated and has not verified it');
    // The observation does not also serve as an independent validation.
    await expect(page.getByTestId('vault-missing')).toContainText('An independent validation with a reference has to be attached');
    await expect(page.getByTestId('vault-advance')).toHaveCount(0);

    // A rung the user climbed can be given up; the rungs below it cannot.
    await page.getByTestId('vault-step-back').click();
    await expect(page.getByTestId('vault-status').first()).toHaveText('Computationally plausible');
    await page.getByTestId('vault-step-back').click();
    await expect(page.getByTestId('vault-status').first()).toHaveText('No match in searched catalogues');
    await expect(page.getByTestId('vault-step-back')).toHaveCount(0);
    // Nothing was removed from the trail on the way down.
    const trail = (await selected()).evidence;
    expect(trail.filter((e) => e.kind === 'status-change' && e.recordedBy === 'user').length).toBe(4);
    expect(trail.some((e) => e.kind === 'experimental-observation')).toBe(true);
  });

  test('takes a candidate back down when a catalogue turns out to hold the structure', async ({ page }) => {
    let mode: PubChem = 'no-record';
    const requests = await pubchem(page, () => mode);
    await fluoroethanol();
    await enterVault();
    await addCandidate('Short-lived', true);
    await lab.eval("return lab.vault.runCalculation(lab.vault.selectedCandidate().id, 'uff');");
    await idle();
    expect(await lab.eval<string | null>("return lab.vault.advanceStatus(lab.vault.selectedCandidate().id, '');")).toBeNull();
    expect((await selected()).status).toBe('computationally-plausible');

    // The catalogue now has the compound. Searching again must really ask again, not reuse the earlier answer.
    mode = 'record';
    const before = requests.filter((url) => url.includes('/compound/inchikey/')).length;
    await page.getByRole('button', { name: 'Searches' }).click();
    await page.getByTestId('vault-candidate').getByTestId('vault-pubchem').check();
    await page.getByTestId('vault-search').click();
    await idle();
    expect(requests.filter((url) => url.includes('/compound/inchikey/')).length).toBe(before + 1);

    const candidate = await selected();
    expect(candidate.status).toBe('structurally-validated');
    await expect(page.getByTestId('vault-found')).toContainText('On record: Record held by the test catalogue');
    await expect(page.getByTestId('vault-found')).toContainText('CID 987654');
    const change = candidate.evidence[candidate.evidence.length - 1]!;
    expect(change).toMatchObject({ kind: 'status-change', recordedBy: 'matterlab', statusBefore: 'computationally-plausible', statusAfter: 'structurally-validated' });
    await page.getByRole('button', { name: 'Status' }).click();
    await expect(page.getByTestId('vault-meaning')).toContainText('already catalogued');
    await expect(page.getByTestId('vault-advance')).toHaveCount(0);
    // Both searches of PubChem stay in the record; the later one decides.
    expect(candidate.searches.filter((s) => s.catalogue === 'pubchem' && s.method === 'exact-inchikey').map((s) => s.outcome)).toEqual(['no-match', 'match']);
  });

  test('leaves a structure RDKit rejects on the first rung', async ({ page }) => {
    await lab.openExample('methane');
    const carbon = (await lab.atoms()).find((a) => a.z === 6)!;
    // A fifth hydrogen on carbon.
    await lab.eval(`lab.actions.runEdit('Over-bond', (e) => { const h = e.addAtom({ protons: 1, position: [0.6, 0.6, 0.9] }); e.addBond(${carbon.id}, h, 1); });`);
    expect((await lab.summary()).formula).toBe('CH5');
    await enterVault();
    await addCandidate('Impossible');

    const candidate = await selected();
    expect(candidate).toMatchObject({ structureValid: false, status: 'user-created', smiles: null, inchiKey: null, searches: [] });
    await expect(page.getByTestId('vault-status').first()).toHaveText('User-created');
    await expect(page.getByTestId('vault-invalid')).toBeVisible();
    await expect(page.getByTestId('vault-candidate')).toContainText(/valence/i);
    await expect(page.getByTestId('vault-meaning')).toContainText('RDKit does not accept it as chemically well-formed');
    await expect(page.getByTestId('vault-advance')).toHaveCount(0);
    await page.getByRole('button', { name: 'Searches' }).click();
    await expect(page.getByTestId('vault-candidate')).toContainText('no catalogue can be searched for it');
  });

  test('attaches nothing when an engine cannot treat the structure', async ({ page }) => {
    // The methyl radical: RDKit accepts it, closed-shell Hartree-Fock cannot treat it.
    await lab.openExample('methane');
    const hydrogen = (await lab.atoms()).find((a) => a.z === 1)!;
    await lab.eval(`lab.actions.eraseAtoms([${hydrogen.id}]);`);
    await enterVault();
    await addCandidate('Methyl');
    const before = (await selected()).evidence.length;
    expect((await selected()).structureValid).toBe(true);

    await page.getByRole('button', { name: /^Evidence/ }).click();
    await page.getByTestId('vault-run-rhf').click();
    await idle();
    await expect(page.getByTestId('vault-calculation-problem')).toContainText('cannot treat this structure, so nothing was attached');
    await expect(page.getByTestId('vault-calculation-problem')).toContainText('odd number of electrons (9)');
    const candidate = await selected();
    expect(candidate.evidence.length).toBe(before);
    expect(candidate.evidence.some((e) => e.kind === 'calculation')).toBe(false);
  });

  test('keeps candidates across a reload, exports them as a report, reopens and deletes them', async ({ page }) => {
    await fluoroethanol();
    await enterVault();
    await addCandidate('Kept');
    await lab.eval("return lab.vault.runCalculation(lab.vault.selectedCandidate().id, 'rhf');");
    await idle();
    const stored = await selected();
    const calculation = stored.evidence.find((e) => e.kind === 'calculation')!;
    expect(calculation.converged).toBe(true);
    expect(calculation.summary).toMatch(/Hartree–Fock \(RHF\/STO-3G\) at the recorded geometry converged in \d+ iterations: total energy −\d+\.\d{6} Eh/);

    await page.reload();
    await lab.ready();
    await enterVault();
    await expect(page.getByTestId('vault-item')).toHaveCount(1);
    await page.getByTestId('vault-item').click();
    const reloaded = await selected();
    expect(reloaded).toEqual(stored);
    expect((await lab.atoms()).length).toBe(9);

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('vault-export').click()]);
    expect(download.suggestedFilename()).toBe('Kept.candidate.json');
    const report = JSON.parse(await readFile((await download.path())!, 'utf8')) as Record<string, unknown> & { structure: Record<string, unknown>; evidence: unknown[]; catalogueSearches: unknown[]; statusLadder: unknown[] };
    expect(report).toMatchObject({ format: 'matterlab.candidate', version: 1, id: stored.id, title: 'Kept', status: 'no-match-in-searched-catalogues', statusLabel: 'No match in searched catalogues' });
    expect(report.notice).toContain('Nothing in this report states or implies that the compound is new');
    expect(report.statusMeaning).toContain('Other databases and the literature were not searched');
    expect(report.statusLadder).toHaveLength(6);
    expect(report.structure).toMatchObject({ formula: 'C2H5FO', atoms: 9, smiles: 'OCCF', inchiKey: stored.inchiKey });
    expect(String(report.structure.molfile)).toContain('V2000');
    expect(report.evidence).toHaveLength(stored.evidence.length);
    expect(report.catalogueSearches).toHaveLength(stored.searches.length);
    expect(JSON.stringify(report)).not.toMatch(CLAIMS);

    // A copy goes to the Architect; the candidate stays as it was.
    await page.getByTestId('vault-open').click();
    await expect(page.getByTestId('vault-side')).toHaveCount(0);
    expect((await lab.summary()).formula).toBe('C2H5FO');
    await lab.eval("lab.actions.changeElement([1], 7);");
    await enterVault();
    await page.getByTestId('vault-item').click();
    expect(await selected()).toEqual(stored);

    await page.getByTestId('vault-delete').click();
    await expect(page.getByTestId('vault-none')).toBeVisible();
    await expect(page.getByTestId('vault-explainer')).toBeVisible();
    await page.reload();
    await lab.ready();
    await enterVault();
    await expect(page.getByTestId('vault-none')).toBeVisible();
  });

  test('takes a candidate back in from its exported data, checking the structure and the status for itself', async ({ page }) => {
    await fluoroethanol();
    await enterVault();
    await addCandidate('Travelled');
    await lab.eval("return lab.vault.runCalculation(lab.vault.selectedCandidate().id, 'rhf');");
    await idle();
    expect(await lab.eval<string | null>("return lab.vault.advanceStatus(lab.vault.selectedCandidate().id, '');")).toBeNull();
    const stored = await selected();
    expect(stored.status).toBe('computationally-plausible');

    interface Report {
      id: string;
      title: string;
      status: string;
      structure: { inchiKey: string | null; scene: { atoms: Array<{ p: number; e: number }> } };
      evidence: Array<{ kind: string }>;
    }
    const report = await lab.eval<Report>('return JSON.parse(JSON.stringify(lab.vault.candidateReport(lab.vault.selectedCandidate())));');
    const importText = (text: string): Promise<string | null> => lab.eval(`return lab.vault.importCandidate(${JSON.stringify(text)});`);
    const importReport = (change: Partial<Report>): Promise<string | null> => importText(JSON.stringify({ ...report, ...change }));
    const count = (): Promise<number> => lab.eval('return lab.vault.useVault.getState().candidates.length;');

    // The readable form is offered beside the data, and says the same thing about what a candidate is.
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('vault-export-report').click()]);
    expect(download.suggestedFilename()).toBe('Travelled.candidate.md');
    const readable = await readFile((await download.path())!, 'utf8');
    expect(readable).toContain('# Candidate report: Travelled');
    expect(readable).toContain('Nothing in this report states or implies that the compound is new');
    expect(readable).toContain(`| Identifier | \`${stored.id}\` |`);
    expect(readable).toContain('| Status | **Computationally plausible** (rung 4 of 6) |');
    expect(readable).toContain(`| InChIKey | \`${stored.inchiKey}\` |`);
    expect(readable.split('\n').filter((line) => /^\d+\. \*\*20/.test(line))).toHaveLength(stored.evidence.length);
    expect(readable).not.toMatch(CLAIMS);

    // A candidate is never overwritten.
    expect(await importReport({})).toContain('already in the vault');
    expect(await count()).toBe(1);

    // Deleted, and taken back in through the file dialog: the same candidate, with one entry more that says where it came from.
    await page.getByTestId('vault-delete').click();
    await expect(page.getByTestId('vault-none')).toBeVisible();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('vault-import').click()]);
    await chooser.setFiles({ name: 'Travelled.candidate.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(report)) });
    await expect(page.getByTestId('vault-item')).toHaveCount(1);
    await idle();
    const back = await selected();
    expect(back).toMatchObject({ id: stored.id, title: 'Travelled', status: 'computationally-plausible', structureValid: true, formula: 'C2H5FO', smiles: stored.smiles, inchiKey: stored.inchiKey });
    expect(back.searches).toEqual(stored.searches);
    expect(back.evidence.slice(0, stored.evidence.length)).toEqual(stored.evidence);
    expect(back.evidence).toHaveLength(stored.evidence.length + 1);
    expect(back.evidence[back.evidence.length - 1]).toMatchObject({ kind: 'note', recordedBy: 'matterlab' });
    expect(back.evidence[back.evidence.length - 1]!.summary).toContain('Everything above this entry is as the file states it');
    expect((await lab.atoms()).length).toBe(9);
    // The status is shown twice, in the banner over the stage and in the candidate's panel; both must agree.
    for (const chip of await page.getByTestId('vault-status').all()) await expect(chip).toHaveText('Computationally plausible');

    // A file that states more than its evidence carries: the calculation takes it to the fourth rung and no further.
    expect(await importReport({ id: '11111111-2222-4333-8444-555555555555', title: 'Overstated', status: 'independently-validated' })).toBeNull();
    const overstated = await selected();
    expect(overstated.title).toBe('Overstated');
    expect(overstated.status).toBe('computationally-plausible');
    const correction = overstated.evidence[overstated.evidence.length - 1]!;
    expect(correction).toMatchObject({ kind: 'status-change', recordedBy: 'matterlab', statusBefore: 'independently-validated', statusAfter: 'computationally-plausible' });
    expect(correction.summary).toContain('which the searches and the evidence in it do not carry');
    await expect(page.getByTestId('vault-status')).toHaveCount(2);
    for (const chip of await page.getByTestId('vault-status').all()) await expect(chip).toHaveText('Computationally plausible');

    // The same claim without the calculation in the file rests on nothing but the searches.
    expect(await importReport({ id: '11111111-2222-4333-8444-666666666666', title: 'Unsupported', status: 'computationally-plausible', evidence: report.evidence.filter((e) => e.kind !== 'calculation') })).toBeNull();
    expect((await selected()).status).toBe('no-match-in-searched-catalogues');

    // A file whose identifiers belong to another structure: here the fluorine was changed to chlorine.
    const swapped = JSON.parse(JSON.stringify(report)) as Report;
    const fluorine = swapped.structure.scene.atoms.find((atom) => atom.p === 9)!;
    fluorine.p = 17;
    fluorine.e = 17;
    const refusal = await importReport({ id: '11111111-2222-4333-8444-777777777777', structure: swapped.structure });
    expect(refusal).toContain(`The identifiers in the file are not those of the structure in it: the file states the InChIKey ${stored.inchiKey}`);
    expect(refusal).toContain('The file was not imported.');

    // And what is not a report at all.
    expect(await importText('{not json')).toBe('The file is not valid JSON, so it is not a candidate report.');
    expect(await importText(JSON.stringify({ format: 'matterlab.project', version: 1 }))).toBe('This is not a MATTER LAB candidate report.');
    expect(await importReport({ id: '11111111-2222-4333-8444-888888888888', status: 'confirmed-discovery' })).toBe('The report states a status this application does not know.');
    expect(await count()).toBe(3);
    expect(await vaultText()).not.toMatch(CLAIMS);
  });

  test('has nothing to add while the Architect is empty', async ({ page }) => {
    await lab.eval('lab.actions.newDocument();');
    await enterVault();
    await expect(page.getByTestId('vault-architect-empty')).toBeVisible();
    await expect(page.getByTestId('vault-add')).toHaveCount(0);
    expect(await lab.eval<string | null>('return lab.vault.addCandidate({});')).toBeNull();
    await expect(page.getByTestId('vault-problem')).toContainText('There is no structure in the Architect');
  });

  test('finds aspirin in the real PubChem', async ({ page }) => {
    const reachable = await page.evaluate(async () => {
      try {
        const response = await fetch('https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/2244/property/MolecularFormula/JSON', { signal: AbortSignal.timeout(12_000) });
        return response.ok;
      } catch {
        return false;
      }
    });
    test.skip(!reachable, 'PubChem cannot be reached from this machine right now, so the live lookup was not exercised.');
    const search = await lab.eval<{ outcome: string; matches: Array<{ id: string; name: string }>; recordsSearched: number | null }>(
      "return lab.vaultCatalogue.searchPubChemIdentity('BSYNRYMUTXBXSQ-UHFFFAOYSA-N').then((s) => JSON.parse(JSON.stringify(s)));",
    );
    expect(search.outcome).toBe('match');
    expect(search.matches[0]).toMatchObject({ id: 'CID 2244', name: 'Aspirin' });
    expect(search.recordsSearched).toBeNull();
    // A key no compound has: fourteen and ten letters of nothing.
    const absent = await lab.eval<{ outcome: string; matches: unknown[] }>("return lab.vaultCatalogue.searchPubChemIdentity('ZZZZZZZZZZZZZZ-ZZZZZZZZZZ-N').then((s) => JSON.parse(JSON.stringify(s)));");
    expect(absent).toMatchObject({ outcome: 'no-match', matches: [] });
  });
});
