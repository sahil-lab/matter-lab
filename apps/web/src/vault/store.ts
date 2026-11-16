import { EMPTY_SCENE, deserializeScene, hillFormula, serializeScene, sortedAtoms, sortedBonds, toMolfile, validateScene } from '@matterlab/core';
import type { Scene, SerializedScene } from '@matterlab/core';
import { create } from 'zustand';
import { stageApi } from '../render/viewApi';
import { CHEM_ATOM_LIMIT, analyseScene } from '../science/chem';
import { UnsupportedStructureError, optimizeScene } from '../science/forcefield';
import { cancelJobsOfKind, runJob } from '../science/jobs';
import { UnsupportedSystem, quantumSupport, quantumSystem, runScf } from '../science/quantum';
import { JobCancelledError } from '../science/rpc';
import { notify, replaceDocument, showOnStage } from '../state/actions';
import { downloadText } from '../state/commands';
import { deleteOne, getAll, putOne } from '../state/db';
import { architectDocument, lab } from '../state/store';
import { describeSearch, searchLibraryIdentity, searchLibrarySimilarity, searchPubChemIdentity, searchPubChemSimilarity } from './catalogue';
import { STATUS_LABELS, STATUS_LADDER, canAdvance, canStepBack, establishedStatus, evidenceProblem, reconciledStatus, statusMeaning, supportedStatus } from './ladder';
import type { CandidateFacts, CandidateStatus, CatalogueSearch, Evidence, EvidenceKind } from './ladder';
import { CANDIDATE_FORMAT, CANDIDATE_FORMAT_VERSION, REPORT_NOTICE, candidateMarkdown, readCandidateReport } from './report';

export { CANDIDATE_FORMAT, CANDIDATE_FORMAT_VERSION };

/** A structure put forward for investigation, with everything that was checked and attached. */
export interface Candidate extends CandidateFacts {
  /** A persistent identifier (UUID); it never changes and is never reused. */
  readonly id: string;
  readonly title: string;
  /** ISO 8601, UTC. */
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The structure exactly as recorded. A candidate's structure is never edited afterwards. */
  readonly scene: SerializedScene;
  /** Hill formula, plain text. */
  readonly formula: string;
  readonly atomCount: number;
  readonly smiles: string | null;
  readonly inchi: string | null;
  readonly inchiKey: string | null;
  readonly validation: {
    readonly rdkitVersion: string | null;
    /** RDKit's own messages when it rejects the structure. */
    readonly rdkitErrors: readonly string[];
    /** What MATTER LAB's rule-based check says, errors and warnings. */
    readonly ruleMessages: readonly string[];
    readonly ruleErrors: number;
    readonly ruleWarnings: number;
  };
}

export type VaultTab = 'status' | 'searches' | 'evidence';
export type CalculationKind = 'uff' | 'rhf';

interface VaultState {
  readonly loaded: boolean;
  /** Most recently changed first. */
  readonly candidates: readonly Candidate[];
  readonly selectedId: string | null;
  readonly tab: VaultTab;
  readonly busy: 'adding' | 'searching' | 'calculating' | null;
  readonly busyText: string | null;
  /** Why the last request was refused or failed. */
  readonly problem: string | null;
  /** Draw the optimised geometry of the latest force-field calculation over the recorded structure. */
  readonly compareOptimised: boolean;
}

export const useVault = create<VaultState>()(() => ({ loaded: false, candidates: [], selectedId: null, tab: 'status', busy: null, busyText: null, problem: null, compareOptimised: false }));

const set = useVault.setState;
const get = useVault.getState;
const now = (): string => new Date().toISOString();
const newId = (): string => crypto.randomUUID();

const byRecency = (a: Candidate, b: Candidate): number => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);

export function selectedCandidate(state: VaultState = get()): Candidate | null {
  return state.candidates.find((c) => c.id === state.selectedId) ?? null;
}

const scenes = new WeakMap<SerializedScene, Scene>();

/** The recorded structure of a candidate as a scene. */
export function candidateScene(candidate: Candidate): Scene {
  let scene = scenes.get(candidate.scene);
  if (!scene) {
    scene = deserializeScene(candidate.scene);
    scenes.set(candidate.scene, scene);
  }
  return scene;
}

function entry(kind: EvidenceKind, summary: string, recordedBy: Evidence['recordedBy'], extra: Partial<Evidence> = {}): Evidence {
  return { id: newId(), kind, summary, recordedBy, createdAt: now(), ...extra };
}

/** Brings the status in line with the facts, and writes any change of status into the trail. */
function settle(candidate: Candidate): Candidate {
  const status = reconciledStatus(candidate);
  if (status === candidate.status) return candidate;
  const lowered = STATUS_LADDER.indexOf(status) < STATUS_LADDER.indexOf(candidate.status);
  const change = entry(
    'status-change',
    lowered
      ? `Status returned to “${STATUS_LABELS[status]}”: ${statusMeaning({ ...candidate, status })}`
      : `Status set to “${STATUS_LABELS[status]}”: ${statusMeaning({ ...candidate, status })}`,
    'matterlab',
    { statusBefore: candidate.status, statusAfter: status },
  );
  return { ...candidate, status, evidence: [...candidate.evidence, change] };
}

async function store(candidate: Candidate): Promise<Candidate> {
  const saved = { ...candidate, updatedAt: now() };
  await putOne('candidates', saved);
  set((s) => ({ candidates: [saved, ...s.candidates.filter((c) => c.id !== saved.id)].sort(byRecency) }));
  return saved;
}

/** Applies a change to a stored candidate. Returns the stored result, or `null` if the candidate is gone. */
async function amend(id: string, change: (candidate: Candidate) => Candidate): Promise<Candidate | null> {
  const current = get().candidates.find((c) => c.id === id);
  if (!current) return null;
  return store(settle(change(current)));
}

export async function loadCandidates(): Promise<void> {
  const records = await getAll<Candidate>('candidates');
  set((s) => ({ loaded: true, candidates: [...records].sort(byRecency), selectedId: s.selectedId && records.some((c) => c.id === s.selectedId) ? s.selectedId : null }));
}

// ---------- what is on stage ----------

function optimisedGeometry(candidate: Candidate): Float32Array | null {
  for (let i = candidate.evidence.length - 1; i >= 0; i--) {
    const positions = candidate.evidence[i]!.details?.optimisedPositions;
    if (Array.isArray(positions)) return Float32Array.from(positions as number[]);
  }
  return null;
}

/** True when a force-field geometry is attached that can be compared with the recorded structure. */
export function hasOptimisedGeometry(candidate: Candidate): boolean {
  return optimisedGeometry(candidate) !== null;
}

/** How far the attached force-field geometry is from the recorded one: RMS over all atoms, in angstrom, without alignment. */
export function optimisedDisplacement(candidate: Candidate): number | null {
  for (let i = candidate.evidence.length - 1; i >= 0; i--) {
    const details = candidate.evidence[i]!.details;
    if (details && Array.isArray(details.optimisedPositions) && typeof details.rmsDisplacementAngstrom === 'number') return details.rmsDisplacementAngstrom;
  }
  return null;
}

/** Shows the selected candidate on the 3D stage. Only acts while the Vault is the workspace on screen. */
export function syncVaultStage(fit = false): void {
  if (lab.get().workspace !== 'vault') return;
  const candidate = selectedCandidate();
  const scene = candidate ? candidateScene(candidate) : EMPTY_SCENE;
  if (lab.get().scene !== scene) showOnStage(scene, { fit });
  const positions = candidate && get().compareOptimised ? optimisedGeometry(candidate) : null;
  if (candidate && positions) {
    const index = new Map(sortedAtoms(scene).map((atom, i) => [atom.id, i]));
    stageApi.setGhost({ positions, bonds: Uint32Array.from(sortedBonds(scene).flatMap((bond) => [index.get(bond.a)!, index.get(bond.b)!])) });
  } else {
    stageApi.setGhost(null);
  }
}

export function selectCandidate(id: string | null): void {
  set({ selectedId: id, problem: null, compareOptimised: false });
  syncVaultStage(true);
}

export function setVaultTab(tab: VaultTab): void {
  set({ tab });
}

export function setCompareOptimised(show: boolean): void {
  set({ compareOptimised: show });
  syncVaultStage();
}

export function dismissVaultProblem(): void {
  set({ problem: null });
}

// ---------- adding a candidate ----------

/** What the Architect holds right now, for the "add a candidate" form. */
export function architectStructure(): { readonly scene: Scene; readonly name: string } {
  const document = architectDocument(lab.get());
  return { scene: document.scene, name: document.projectName };
}

async function runSearches(candidate: Candidate, pubchem: boolean): Promise<Candidate | null> {
  if (!candidate.structureValid || !candidate.inchiKey || !candidate.smiles) return candidate;
  const searches: CatalogueSearch[] = [await searchLibraryIdentity(candidate.inchiKey), await searchLibrarySimilarity(candidate.smiles)];
  if (pubchem) {
    set({ busyText: 'asking PubChem…' });
    searches.push(await searchPubChemIdentity(candidate.inchiKey), await searchPubChemSimilarity(candidate.smiles));
  }
  return amend(candidate.id, (c) => ({
    ...c,
    searches: [...c.searches, ...searches],
    evidence: [...c.evidence, ...searches.map((search) => entry('catalogue-search', describeSearch(search), 'matterlab', { createdAt: search.searchedAt, details: { searchId: search.id } }))],
  }));
}

/**
 * Records the Architect's structure as a candidate: validates it, derives its identifiers and
 * searches the catalogues. Returns the new candidate's identifier, or `null` when there was
 * nothing to add.
 */
export async function addCandidate(options: { title?: string; pubchem?: boolean } = {}): Promise<string | null> {
  if (get().busy) return null;
  const { scene, name } = architectStructure();
  if (scene.atoms.size === 0) {
    set({ problem: 'There is no structure in the Architect. Build or open one there first.' });
    return null;
  }
  if (scene.atoms.size > CHEM_ATOM_LIMIT) {
    set({ problem: `Candidates are limited to ${CHEM_ATOM_LIMIT.toLocaleString('en-US')} atoms; the structure in the Architect has ${scene.atoms.size.toLocaleString('en-US')}.` });
    return null;
  }
  set({ busy: 'adding', busyText: 'validating the structure…', problem: null });
  try {
    const formula = hillFormula(scene, undefined, 'plain');
    const rules = validateScene(scene);
    const ruleMessages = rules.issues.filter((issue) => issue.severity !== 'info').map((issue) => issue.message);
    let analysis: Awaited<ReturnType<typeof analyseScene>> | null = null;
    let unavailable: string | null = null;
    try {
      analysis = await analyseScene(scene);
    } catch (error) {
      unavailable = error instanceof Error ? error.message : String(error);
    }
    const valid = analysis?.ok === true;
    const created = now();
    const ruleNote = rules.errors + rules.warnings > 0 ? ` MATTER LAB's rule-based check reports ${rules.errors} error${rules.errors === 1 ? '' : 's'} and ${rules.warnings} warning${rules.warnings === 1 ? '' : 's'}.` : '';
    const remarks = analysis && analysis.warnings.length > 0 ? ` RDKit remarked: ${analysis.warnings.join('; ')}.` : '';
    const validation = entry(
      'structure-validation',
      valid
        ? `RDKit ${analysis!.rdkitVersion} accepts the structure: ${analysis!.smiles} (${formula}), InChIKey ${analysis!.inchiKey}.${remarks}${ruleNote}`
        : analysis
          ? `RDKit ${analysis.rdkitVersion} does not accept the structure: ${analysis.errors.join(' ')}${remarks}${ruleNote}`
          : `The structure could not be validated because RDKit is not available (${unavailable}).`,
      'matterlab',
    );
    const candidate: Candidate = {
      id: newId(),
      title: (options.title ?? '').trim() || name || formula,
      createdAt: created,
      updatedAt: created,
      status: 'user-created',
      structureValid: valid,
      scene: serializeScene(scene),
      formula,
      atomCount: scene.atoms.size,
      smiles: valid ? analysis!.smiles : null,
      inchi: valid ? analysis!.inchi : null,
      inchiKey: valid ? analysis!.inchiKey : null,
      validation: { rdkitVersion: analysis?.rdkitVersion ?? null, rdkitErrors: analysis && !analysis.ok ? analysis.errors : unavailable ? [unavailable] : [], ruleMessages, ruleErrors: rules.errors, ruleWarnings: rules.warnings },
      searches: [],
      evidence: [entry('note', `Candidate recorded from the structure in the Architect (“${name}”, ${formula}, ${scene.atoms.size} atoms).`, 'user', { statusAfter: 'user-created' }), validation],
    };
    const stored = await store(settle(candidate));
    set({ selectedId: stored.id, tab: 'status', compareOptimised: false });
    syncVaultStage(true);
    set({ busyText: 'searching the catalogues…' });
    await runSearches(stored, options.pubchem ?? false);
    return stored.id;
  } catch (error) {
    set({ problem: `The candidate could not be recorded: ${error instanceof Error ? error.message : String(error)}` });
    return null;
  } finally {
    set({ busy: null, busyText: null });
  }
}

/** Searches the catalogues again. Earlier searches stay in the record; the newest of each catalogue decides. */
export async function searchAgain(id: string, pubchem: boolean): Promise<void> {
  const candidate = get().candidates.find((c) => c.id === id);
  if (!candidate || get().busy) return;
  if (!candidate.structureValid) {
    set({ problem: 'A structure RDKit does not accept has no identifiers, so no catalogue can be searched for it.' });
    return;
  }
  set({ busy: 'searching', busyText: 'searching the catalogues…', problem: null });
  try {
    await runSearches(candidate, pubchem);
  } finally {
    set({ busy: null, busyText: null });
  }
}

// ---------- calculations ----------

const minus = (text: string): string => text.replace(/-/g, '−');

/**
 * Runs a calculation on the candidate's structure and attaches the outcome to the trail, whether
 * it converged or not. A calculation the engine cannot do at all attaches nothing and says why.
 */
export async function runCalculation(id: string, kind: CalculationKind): Promise<void> {
  const candidate = get().candidates.find((c) => c.id === id);
  if (!candidate || get().busy) return;
  const scene = candidateScene(candidate);
  set({ busy: 'calculating', busyText: kind === 'uff' ? 'optimising with the force field…' : 'running Hartree–Fock…', problem: null });
  try {
    let evidence: Evidence;
    if (kind === 'uff') {
      const outcome = await runJob({ kind: 'optimize', title: 'Geometry optimisation', detail: `Universal Force Field · candidate “${candidate.title}”` }, ({ signal, report }) =>
        optimizeScene(scene, { signal, onProgress: (progress) => report(null, `step ${progress.step}`) }),
      );
      const { result } = outcome;
      const optimisedPositions = Array.from(result.positions, (value) => Number(value.toFixed(5)));
      evidence = entry(
        'calculation',
        `Universal Force Field geometry optimisation ${result.converged ? 'converged to a minimum' : 'did not converge'} in ${result.steps} steps: energy ${minus(result.initialEnergy.toFixed(2))} → ${minus(result.finalEnergy.toFixed(2))} kcal/mol, RMS displacement ${result.rmsDisplacement.toFixed(3)} Å.`,
        'matterlab',
        {
          converged: result.converged,
          details: {
            method: 'UFF geometry optimisation',
            engine: result.provenance.source,
            engineVersion: result.provenance.version ?? null,
            steps: result.steps,
            initialEnergyKcalPerMol: result.initialEnergy,
            finalEnergyKcalPerMol: result.finalEnergy,
            rmsGradientKcalPerMolPerAngstrom: result.rmsGradient,
            rmsDisplacementAngstrom: result.rmsDisplacement,
            warnings: [...result.warnings],
            optimisedPositions,
          },
        },
      );
    } else {
      const system = quantumSystem(scene);
      const support = quantumSupport(scene, system);
      if (!support.supported) throw new UnsupportedSystem(support.reasons);
      const result = await runJob({ kind: 'quantum', title: 'Electronic structure', detail: `RHF/STO-3G · candidate “${candidate.title}” · ${support.nBasis} basis functions` }, ({ signal, report }) =>
        runScf(system.input, { signal, onProgress: (progress) => report(progress.phase === 'integrals' ? 0.7 * progress.fraction : null, progress.phase) }),
      );
      const gap = result.lumoIndex === null ? null : result.orbitalEnergies[result.lumoIndex]! - result.orbitalEnergies[result.homoIndex]!;
      evidence = entry(
        'calculation',
        `Hartree–Fock (RHF/STO-3G) at the recorded geometry ${result.converged ? 'converged' : 'did not converge'} in ${result.iterations.length} iterations: total energy ${minus(result.energy.total.toFixed(6))} Eh${gap === null ? '' : `, gap between the highest occupied and lowest empty orbital ${gap.toFixed(4)} Eh`}.`,
        'matterlab',
        {
          converged: result.converged,
          details: {
            method: 'RHF/STO-3G single point',
            engine: result.provenance.source,
            engineVersion: result.provenance.version ?? null,
            iterations: result.iterations.length,
            totalEnergyHartree: result.energy.total,
            homoLumoGapHartree: gap,
            basisFunctions: result.nBasis,
            electrons: result.nElectrons,
            warnings: [...result.warnings],
          },
        },
      );
    }
    await amend(id, (c) => ({ ...c, evidence: [...c.evidence, evidence] }));
    syncVaultStage();
  } catch (error) {
    if (error instanceof JobCancelledError) return;
    const reasons = error instanceof UnsupportedStructureError || error instanceof UnsupportedSystem ? error.reasons : [error instanceof Error ? error.message : String(error)];
    const engine = kind === 'uff' ? 'The Universal Force Field' : 'The Hartree–Fock engine';
    set({ problem: `${engine} cannot treat this structure, so nothing was attached. ${reasons.join(' ')}` });
  } finally {
    set({ busy: null, busyText: null });
  }
}

export function cancelCalculation(): void {
  cancelJobsOfKind('optimize');
  cancelJobsOfKind('quantum');
}

// ---------- evidence and status ----------

/** Adds evidence stated by the user. Returns why it was refused, or `null` when it was recorded. */
export async function addEvidence(id: string, kind: EvidenceKind, summary: string, reference: string): Promise<string | null> {
  const problem = evidenceProblem(kind, summary, reference);
  if (problem) return problem;
  const stored = await amend(id, (c) => ({ ...c, evidence: [...c.evidence, entry(kind, summary.trim(), 'user', reference.trim() ? { reference: reference.trim() } : {})] }));
  return stored ? null : 'The candidate no longer exists.';
}

/** Asks for the next rung. Returns what is missing, or `null` when the candidate moved up. */
export async function advanceStatus(id: string, justification: string): Promise<string | null> {
  const candidate = get().candidates.find((c) => c.id === id);
  if (!candidate) return 'The candidate no longer exists.';
  const check = canAdvance(candidate);
  if (!check.allowed) return check.missing;
  const reasonGiven = justification.trim();
  await store({
    ...candidate,
    status: check.next,
    evidence: [
      ...candidate.evidence,
      entry('status-change', `Status raised to “${STATUS_LABELS[check.next]}” at the user's request${reasonGiven ? `: ${reasonGiven}` : '.'}`, 'user', { statusBefore: candidate.status, statusAfter: check.next }),
    ],
  });
  return null;
}

/** Gives up the highest rung the user climbed. */
export async function stepBackStatus(id: string): Promise<void> {
  const candidate = get().candidates.find((c) => c.id === id);
  if (!candidate || !canStepBack(candidate)) return;
  const previous = STATUS_LADDER[STATUS_LADDER.indexOf(candidate.status) - 1]!;
  const floor = establishedStatus(candidate);
  const status: CandidateStatus = STATUS_LADDER.indexOf(previous) < STATUS_LADDER.indexOf(floor) ? floor : previous;
  await store({
    ...candidate,
    status,
    evidence: [...candidate.evidence, entry('status-change', `Status lowered to “${STATUS_LABELS[status]}” at the user's request.`, 'user', { statusBefore: candidate.status, statusAfter: status })],
  });
}

export async function renameCandidate(id: string, title: string): Promise<void> {
  const next = title.trim();
  if (next) await amend(id, (c) => (c.title === next ? c : { ...c, title: next }));
}

export async function deleteCandidate(id: string): Promise<void> {
  await deleteOne('candidates', id);
  set((s) => ({ candidates: s.candidates.filter((c) => c.id !== id), selectedId: s.selectedId === id ? null : s.selectedId, compareOptimised: false }));
  syncVaultStage(true);
}

/** Opens a copy of the candidate's structure as the Architect's document. The candidate itself is not changed. */
export function openInArchitect(id: string): void {
  const candidate = get().candidates.find((c) => c.id === id);
  if (!candidate) return;
  replaceDocument(candidateScene(candidate), candidate.title);
  notify('info', `Opened a copy of “${candidate.title}” in the Architect`, 'Changes made there do not alter the candidate. Add the changed structure as a new candidate.');
}

/** The candidate as a self-contained report: structure, identifiers, every search, the whole trail. */
export function candidateReport(candidate: Candidate): Record<string, unknown> {
  const scene = candidateScene(candidate);
  return {
    format: CANDIDATE_FORMAT,
    version: CANDIDATE_FORMAT_VERSION,
    exportedAt: now(),
    notice: REPORT_NOTICE,
    id: candidate.id,
    title: candidate.title,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    status: candidate.status,
    statusLabel: STATUS_LABELS[candidate.status],
    statusMeaning: statusMeaning(candidate),
    statusLadder: STATUS_LADDER.map((status) => ({ status, label: STATUS_LABELS[status] })),
    structure: {
      formula: candidate.formula,
      atoms: candidate.atomCount,
      smiles: candidate.smiles,
      inchi: candidate.inchi,
      inchiKey: candidate.inchiKey,
      molfile: toMolfile(scene),
      scene: candidate.scene,
    },
    validation: { accepted: candidate.structureValid, ...candidate.validation },
    catalogueSearches: candidate.searches,
    evidence: candidate.evidence,
  };
}

const fileName = (candidate: Candidate): string => candidate.title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'candidate';

/** Downloads the machine-readable report, which holds everything and can be imported again. */
export function exportCandidate(id: string): void {
  const candidate = get().candidates.find((c) => c.id === id);
  if (!candidate) return;
  downloadText(`${fileName(candidate)}.candidate.json`, JSON.stringify(candidateReport(candidate), null, 2), 'application/json');
}

/** Downloads the report in a form meant for reading. */
export function exportCandidateMarkdown(id: string): void {
  const candidate = get().candidates.find((c) => c.id === id);
  if (!candidate) return;
  downloadText(`${fileName(candidate)}.candidate.md`, candidateMarkdown(candidate, now()), 'text/markdown');
}

/**
 * Takes a candidate in from a report file. What the file states is kept as stated, with two
 * exceptions that the application checks for itself: the identifiers are derived again from the
 * structure in the file and must be the ones the file gives, and the status is honoured only as
 * far as the searches and the evidence in the file carry it. Returns why the file was refused, or
 * `null` when the candidate is now in the vault.
 */
export async function importCandidate(text: string): Promise<string | null> {
  if (get().busy) return 'Wait until the current task has finished.';
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return 'The file is not valid JSON, so it is not a candidate report.';
  }
  const reading = readCandidateReport(json);
  if (!reading.ok) return reading.problem;
  const stated = reading.candidate;
  if (get().candidates.some((c) => c.id === stated.id)) return 'A candidate with this identifier is already in the vault. Candidates are never overwritten; delete the one in the vault first if the file is to replace it.';

  set({ busy: 'adding', busyText: 'checking the report…', problem: null });
  try {
    const scene = deserializeScene(stated.scene);
    if (scene.atoms.size > CHEM_ATOM_LIMIT) return `Candidates are limited to ${CHEM_ATOM_LIMIT.toLocaleString('en-US')} atoms; the structure in the file has ${scene.atoms.size.toLocaleString('en-US')}.`;
    let analysis: Awaited<ReturnType<typeof analyseScene>>;
    try {
      analysis = await analyseScene(scene);
    } catch (error) {
      return `The structure in the file could not be checked because RDKit is not available (${error instanceof Error ? error.message : String(error)}), so the file was not imported.`;
    }
    const valid = analysis.ok;
    const key = valid ? analysis.inchiKey : null;
    if (key !== stated.inchiKey) {
      return stated.inchiKey === null
        ? 'The file gives no identifiers for its structure, although RDKit accepts the structure. The file was not imported.'
        : `The identifiers in the file are not those of the structure in it: the file states the InChIKey ${stated.inchiKey}, and the structure ${key ? `has ${key}` : 'is not one RDKit accepts'}. The file was not imported.`;
    }
    const rules = validateScene(scene);
    const facts: CandidateFacts = { status: stated.status, structureValid: valid, searches: stated.searches, evidence: stated.evidence };
    const status = supportedStatus(facts);
    const trail: Evidence[] = [
      ...stated.evidence,
      entry(
        'note',
        `Imported from a report file${stated.exportedAt ? ` exported on ${stated.exportedAt.slice(0, 16).replace('T', ' ')} UTC` : ''}. Everything above this entry is as the file states it. MATTER LAB derived the identifiers again from the structure in the file, and they are the ones the file gives.`,
        'matterlab',
      ),
    ];
    if (status !== stated.status) {
      trail.push(
        entry('status-change', `The file states the status “${STATUS_LABELS[stated.status]}”, which the searches and the evidence in it do not carry. The status was set to “${STATUS_LABELS[status]}”: ${statusMeaning({ ...facts, status })}`, 'matterlab', {
          statusBefore: stated.status,
          statusAfter: status,
        }),
      );
    }
    const candidate: Candidate = {
      id: stated.id,
      title: stated.title,
      createdAt: stated.createdAt,
      updatedAt: stated.updatedAt,
      status,
      structureValid: valid,
      scene: stated.scene,
      formula: hillFormula(scene, undefined, 'plain'),
      atomCount: scene.atoms.size,
      smiles: valid ? analysis.smiles : null,
      inchi: valid ? analysis.inchi : null,
      inchiKey: key,
      validation: {
        rdkitVersion: analysis.rdkitVersion,
        rdkitErrors: valid ? [] : analysis.errors,
        ruleMessages: rules.issues.filter((issue) => issue.severity !== 'info').map((issue) => issue.message),
        ruleErrors: rules.errors,
        ruleWarnings: rules.warnings,
      },
      searches: stated.searches,
      evidence: trail,
    };
    const stored = await store(candidate);
    set({ selectedId: stored.id, tab: 'status', compareOptimised: false });
    syncVaultStage(true);
    return null;
  } catch (error) {
    return `The file could not be imported: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    set({ busy: null, busyText: null });
  }
}

/** Asks for a report file and imports it; what went wrong is shown where the other problems of the vault are. */
export function pickCandidateFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    void file.text().then(async (text) => {
      const problem = await importCandidate(text);
      if (problem) set({ problem });
      else notify('success', 'Candidate imported', 'Its status was checked against the searches and the evidence in the file.');
    });
  };
  input.click();
}
