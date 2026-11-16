import { hillFormula } from '@matterlab/core';
import { ExternalLink, FlaskConical, Plus, Search, Square } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { BUILD_ATOM_LIMIT, BuildError, buildFromSmiles, pubchemModel } from '../science/build3d';
import type { BuiltModel } from '../science/build3d';
import { chemistryOf, searchStructures, useChem } from '../science/chem';
import { cancelJobsOfKind, runJob } from '../science/jobs';
import { libraryModel, localLibrary } from '../science/library';
import type { LibraryEntry, StructureModel } from '../science/library';
import { PubChemError, compoundsByName, pubchemUrl } from '../science/pubchem';
import type { PubChemCompound } from '../science/pubchem';
import { JobCancelledError } from '../science/rpc';
import { notify } from '../state/actions';
import { placeStructure } from '../state/commands';
import { architectDocument, useLab } from '../state/store';
import { ChemText } from './chem';
import { Button, EvidenceBadge, Note, Segmented } from './kit';

/** Library structures are listed down to this Tanimoto similarity; below it fingerprints share almost nothing. */
const SIMILARITY_FLOOR = 0.15;
const LISTED = 12;

interface Problem {
  readonly message: string;
  readonly details: readonly string[];
}

function problemOf(error: unknown): Problem | null {
  if (error instanceof JobCancelledError) return null;
  if (error instanceof BuildError) return { message: error.message, details: error.details };
  if (error instanceof PubChemError) return { message: error.message, details: [] };
  return { message: 'That did not work.', details: [error instanceof Error ? error.message : String(error)] };
}

function ProblemNote({ problem, testId }: { problem: Problem; testId: string }) {
  return (
    <Note severity="error">
      <span data-testid={testId}>{problem.message}</span>
      {problem.details.map((detail, i) => (
        <span key={i} style={{ display: 'block', marginTop: 3 }}>
          {detail}
        </span>
      ))}
    </Note>
  );
}

function Working({ text, onCancel }: { text: string; onCancel?: () => void }) {
  return (
    <div className="ml-running" role="status">
      <div className="ml-progress" data-indeterminate="true" style={{ margin: 0 }}>
        <i />
      </div>
      <span className="ml-mono">{text}</span>
      {onCancel && (
        <Button size="sm" variant="outline" onClick={onCancel}>
          <Square /> Cancel
        </Button>
      )}
    </div>
  );
}

/** One structure that can be opened or added, whatever it was found by. */
function ResultRow({ id, title, meta, link, busy, disabled, onPlace }: { id: string; title: ReactNode; meta: ReactNode; link?: string; busy: boolean; disabled: boolean; onPlace: (mode: 'replace' | 'insert') => void }) {
  return (
    <div className="ml-row ml-find__row" data-find-row={id}>
      <div className="ml-row__grow">
        <span className="ml-find__title">{title}</span>
        <span className="ml-find__meta">{meta}</span>
      </div>
      {link && (
        <a className="ml-find__link" href={link} target="_blank" rel="noreferrer" aria-label="Open the record on PubChem">
          <ExternalLink />
        </a>
      )}
      {busy ? (
        <span className="ml-mono ml-find__meta">fetching…</span>
      ) : (
        <>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => onPlace('replace')}>
            Open
          </Button>
          <Button size="sm" disabled={disabled} tip="Add beside what is in the workspace" tipPos="top-end" aria-label="Add" onClick={() => onPlace('insert')}>
            <Plus /> Add
          </Button>
        </>
      )}
    </div>
  );
}

type LibraryMode = 'substructure' | 'similarity';

interface LibraryHit {
  readonly entry: LibraryEntry;
  readonly similarity?: number;
  readonly matchedAtoms?: number;
}

interface LibraryOutcome {
  readonly mode: LibraryMode;
  readonly query: string;
  readonly searched: number;
  readonly notSearched: number;
  readonly found: number;
  readonly hits: readonly LibraryHit[];
}

/**
 * The "Find" section of the library: look a compound up on PubChem by name, build a 3D model from a
 * SMILES string, or search the structures that ship with the application.
 */
export function FindPanel({ onPlaced }: { onPlaced: () => void }) {
  const [name, setName] = useState('');
  const [lookingUp, setLookingUp] = useState(false);
  const [compounds, setCompounds] = useState<{ query: string; found: readonly PubChemCompound[] } | null>(null);
  const [lookupProblem, setLookupProblem] = useState<Problem | null>(null);

  const [smiles, setSmiles] = useState('');
  const [stage, setStage] = useState<string | null>(null);
  const [model, setModel] = useState<BuiltModel | null>(null);
  const [buildProblem, setBuildProblem] = useState<Problem | null>(null);

  const [mode, setMode] = useState<LibraryMode>('substructure');
  const [pattern, setPattern] = useState('');
  const [searching, setSearching] = useState(false);
  const [outcome, setOutcome] = useState<LibraryOutcome | null>(null);
  const [searchProblem, setSearchProblem] = useState<Problem | null>(null);

  /** The row whose model is being fetched, and what went wrong with the last one. */
  const [fetching, setFetching] = useState<string | null>(null);
  const [placeProblem, setPlaceProblem] = useState<{ row: string; problem: Problem } | null>(null);

  // The SMILES of what is in the Architect, for searching by the structure being worked on.
  const workspaceScene = useLab((s) => {
    const scene = architectDocument(s).scene;
    return scene.atoms.size > 0 ? scene : null;
  });
  const chem = useChem();
  const workspaceSmiles = workspaceScene ? (chemistryOf(chem, workspaceScene)?.smiles ?? null) : null;

  const place = (structure: StructureModel, how: 'replace' | 'insert', said: readonly string[]) => {
    placeStructure(structure.scene, structure.name, how);
    notify('success', how === 'replace' ? `Opened ${structure.name}` : `Added ${structure.name}`, said.join(' '));
    onPlaced();
  };

  const lookUp = async () => {
    const query = name.trim();
    if (query.length === 0 || lookingUp) return;
    setLookingUp(true);
    setLookupProblem(null);
    setPlaceProblem(null);
    try {
      setCompounds({ query, found: await compoundsByName(query, 6) });
    } catch (error) {
      setCompounds(null);
      setLookupProblem(problemOf(error));
    } finally {
      setLookingUp(false);
    }
  };

  const build = async () => {
    const text = smiles.trim();
    if (text.length === 0 || stage !== null) return;
    setStage('starting');
    setBuildProblem(null);
    setModel(null);
    try {
      const built = await runJob({ kind: 'chemistry', title: 'Build a 3D model', detail: `from the SMILES ${text.length > 60 ? `${text.slice(0, 57)}…` : text}` }, ({ signal, report }) =>
        buildFromSmiles(text, {
          signal,
          onStage: (what) => {
            report(null, what);
            setStage(what);
          },
        }),
      );
      setModel(built);
    } catch (error) {
      setBuildProblem(problemOf(error));
    } finally {
      setStage(null);
    }
  };

  /** Fetches or prepares the model behind a row, then places it. */
  const fetchAndPlace = async (row: string, how: 'replace' | 'insert', get: () => Promise<StructureModel>) => {
    if (fetching) return;
    setFetching(row);
    setPlaceProblem(null);
    try {
      const structure = await runJob({ kind: 'chemistry', title: 'Fetch a 3D model' }, () => get());
      place(structure, how, structure.notes);
    } catch (error) {
      const problem = problemOf(error);
      if (problem) setPlaceProblem({ row, problem });
    } finally {
      setFetching(null);
    }
  };

  const search = async () => {
    const query = pattern.trim();
    if (query.length === 0 || searching) return;
    setSearching(true);
    setSearchProblem(null);
    setPlaceProblem(null);
    try {
      const entries = await localLibrary();
      const searchable = entries.filter((entry) => entry.smiles !== null);
      const byId = new Map(searchable.map((entry) => [entry.id, entry]));
      const result = await searchStructures(
        mode,
        query,
        searchable.map((entry) => ({ id: entry.id, smiles: entry.smiles! })),
        mode === 'similarity' ? SIMILARITY_FLOOR : undefined,
      );
      if (!result.ok) {
        setOutcome(null);
        setSearchProblem({ message: mode === 'similarity' ? 'RDKit cannot read the query as a SMILES string.' : 'RDKit cannot read the query as a SMARTS or SMILES pattern.', details: result.errors });
        return;
      }
      const hits = result.hits.map((hit) => ({ entry: byId.get(hit.id)!, ...(hit.similarity !== undefined ? { similarity: hit.similarity } : {}), ...(hit.matchedAtoms ? { matchedAtoms: hit.matchedAtoms.length } : {}) }));
      setOutcome({ mode, query, searched: searchable.length - result.skipped.length, notSearched: entries.length - searchable.length + result.skipped.length, found: hits.length, hits: hits.slice(0, mode === 'similarity' ? LISTED : hits.length) });
    } catch (error) {
      setOutcome(null);
      setSearchProblem(problemOf(error));
    } finally {
      setSearching(false);
    }
  };

  const onEnter = (action: () => void) => (event: { key: string }) => {
    if (event.key === 'Enter') action();
  };

  return (
    <div className="ml-find" data-testid="find">
      <section className="ml-find__section">
        <div className="ml-find__head">
          <span className="ml-label">Look up a compound by name</span>
          <EvidenceBadge level="reference" tipPos="top-end" />
        </div>
        <div className="ml-find__bar">
          <input
            className="ml-input"
            placeholder="A name or registry number, e.g. ibuprofen"
            aria-label="Compound name"
            value={name}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onEnter(() => void lookUp())}
            data-testid="find-name"
          />
          <Button variant="primary" disabled={name.trim().length === 0 || lookingUp} onClick={() => void lookUp()} data-testid="find-lookup">
            <Search /> Look up on PubChem
          </Button>
        </div>
        <p className="ml-empty">The name is sent to PubChem, the open compound database of the U.S. National Library of Medicine. Nothing else leaves this device.</p>
        {lookingUp && <Working text="asking PubChem…" />}
        {lookupProblem && <ProblemNote problem={lookupProblem} testId="find-lookup-problem" />}
        {compounds &&
          (compounds.found.length === 0 ? (
            <p className="ml-empty" data-testid="find-no-compound">
              PubChem lists no compound under “{compounds.query}”. That says nothing about whether such a compound exists: try another spelling or a systematic name.
            </p>
          ) : (
            <div className="ml-list" data-testid="find-compounds">
              {compounds.found.map((compound) => {
                const row = `lookup:${compound.cid}`;
                return (
                  <ResultRow
                    key={row}
                    id={row}
                    title={compound.title}
                    meta={
                      <>
                        <ChemText text={compound.formula} /> · CID {compound.cid}
                        {compound.molecularWeight !== null && <> · {compound.molecularWeight.toFixed(2)} g/mol</>}
                      </>
                    }
                    link={pubchemUrl(compound.cid)}
                    busy={fetching === row}
                    disabled={fetching !== null}
                    onPlace={(how) => void fetchAndPlace(row, how, () => pubchemModel(compound))}
                  />
                );
              })}
            </div>
          ))}
        {placeProblem && placeProblem.row.startsWith('lookup:') && compounds && <ProblemNote problem={placeProblem.problem} testId="find-place-problem" />}
      </section>

      <section className="ml-find__section">
        <div className="ml-find__head">
          <span className="ml-label">Build a 3D model from SMILES</span>
          <EvidenceBadge level="computed" tipPos="top-end" />
        </div>
        <div className="ml-find__bar">
          <input
            className="ml-input ml-mono"
            placeholder="A SMILES string, e.g. C[C@@H](C(=O)O)N"
            aria-label="SMILES string"
            value={smiles}
            spellCheck={false}
            onChange={(e) => setSmiles(e.target.value)}
            onKeyDown={onEnter(() => void build())}
            data-testid="find-smiles"
          />
          <Button variant="primary" disabled={smiles.trim().length === 0 || stage !== null} onClick={() => void build()} data-testid="find-build">
            <FlaskConical /> Build model
          </Button>
        </div>
        <p className="ml-empty">
          Done on this device: RDKit reads the bonding from the string, the Universal Force Field gives it a shape, and the result is checked against the stereochemistry the string
          states. Up to {BUILD_ATOM_LIMIT} atoms, hydrogens included.
        </p>
        {stage !== null && <Working text={`${stage}…`} onCancel={() => cancelJobsOfKind('chemistry')} />}
        {buildProblem && <ProblemNote problem={buildProblem} testId="find-build-problem" />}
        {model && (
          <div className="ml-find__model" data-testid="find-model">
            <div className="ml-find__model-head">
              <span className="ml-find__title">
                <ChemText text={hillFormula(model.scene, undefined, 'plain')} />
              </span>
              <span className="ml-find__meta">
                {model.atomCount} atoms · read as <span className="ml-mono">{model.smiles}</span>
              </span>
            </div>
            {model.notes.map((note, i) => (
              <p key={i} className="ml-empty">
                {note}
              </p>
            ))}
            <div className="ml-actions">
              <Button size="sm" variant="outline" onClick={() => place(model, 'replace', model.notes.slice(0, 1))} data-testid="find-model-open">
                Open
              </Button>
              <Button size="sm" onClick={() => place(model, 'insert', model.notes.slice(0, 1))} data-testid="find-model-add">
                <Plus /> Add to the workspace
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className="ml-find__section">
        <div className="ml-find__head">
          <span className="ml-label">Search the built-in library by structure</span>
          <Segmented<LibraryMode>
            label="Kind of search"
            value={mode}
            onChange={(value) => {
              setMode(value);
              setOutcome(null);
              setSearchProblem(null);
            }}
            options={[
              { value: 'substructure', label: 'Contains', tip: 'Structures that contain a pattern' },
              { value: 'similarity', label: 'Similar to', tip: 'Structures ranked by fingerprint similarity' },
            ]}
          />
        </div>
        <div className="ml-find__bar">
          <input
            className="ml-input ml-mono"
            placeholder={mode === 'substructure' ? 'A SMARTS or SMILES pattern, e.g. C(=O)[OH]' : 'A SMILES string, e.g. CCO'}
            aria-label={mode === 'substructure' ? 'Substructure pattern' : 'Structure to compare with'}
            value={pattern}
            spellCheck={false}
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={onEnter(() => void search())}
            data-testid="find-pattern"
          />
          <Button
            variant="outline"
            disabled={workspaceSmiles === null}
            tip={workspaceSmiles === null ? 'There is no structure in the workspace that RDKit accepts' : 'Use the SMILES of the structure in the workspace'}
            tipPos="top-end"
            aria-label="Use the workspace structure"
            onClick={() => workspaceSmiles && setPattern(workspaceSmiles)}
            data-testid="find-use-current"
          >
            From workspace
          </Button>
          <Button variant="primary" disabled={pattern.trim().length === 0 || searching} onClick={() => void search()} data-testid="find-search">
            <Search /> Search
          </Button>
        </div>
        {searching && <Working text="searching…" />}
        {searchProblem && <ProblemNote problem={searchProblem} testId="find-search-problem" />}
        {outcome && (
          <>
            <p className="ml-empty" data-testid="find-search-summary">
              {outcome.mode === 'substructure'
                ? `${outcome.found} of the ${outcome.searched} library structures searched ${outcome.found === 1 ? 'contains' : 'contain'} the pattern.`
                : `${outcome.found} of the ${outcome.searched} library structures searched ${outcome.found === 1 ? 'has' : 'have'} a Tanimoto similarity of at least ${SIMILARITY_FLOOR} (Morgan fingerprints, radius 2)${outcome.found > outcome.hits.length ? `; the ${outcome.hits.length} most similar are listed` : ''}. 1 means the same fingerprint.`}
              {outcome.notSearched > 0 && ` ${outcome.notSearched} structure${outcome.notSearched === 1 ? ' was' : 's were'} not searched because RDKit cannot read ${outcome.notSearched === 1 ? 'it' : 'them'}.`}
            </p>
            {outcome.hits.length > 0 && (
              <div className="ml-list" data-testid="find-hits">
                {outcome.hits.map((hit) => {
                  const row = `library:${hit.entry.id}`;
                  return (
                    <ResultRow
                      key={row}
                      id={row}
                      title={hit.entry.name}
                      meta={
                        <>
                          {hit.similarity !== undefined && <span className="ml-mono">similarity {hit.similarity.toFixed(2)} · </span>}
                          <span className="ml-mono">{hit.entry.smiles}</span>
                        </>
                      }
                      {...(hit.entry.url ? { link: hit.entry.url } : {})}
                      busy={fetching === row}
                      disabled={fetching !== null}
                      onPlace={(how) => void fetchAndPlace(row, how, () => libraryModel(hit.entry.id))}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}
        {placeProblem && placeProblem.row.startsWith('library:') && outcome && <ProblemNote problem={placeProblem.problem} testId="find-place-problem" />}
      </section>
    </div>
  );
}
