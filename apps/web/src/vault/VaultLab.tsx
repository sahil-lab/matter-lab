import { hillFormula } from '@matterlab/core';
import { Atom, Calculator, Check, ChevronLeft, ChevronRight, Download, ExternalLink, Eye, EyeOff, Hexagon, Plus, ScrollText, Search, ShieldCheck, Sparkles, Square, StickyNote, Trash2, Undo2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { TextField } from '../reaction/fields';
import { enterWorkspace } from '../state/actions';
import { architectDocument, lab, useLab } from '../state/store';
import { ChemText } from '../ui/chem';
import { Button, EvidenceBadge, IconButton, Note, Section, Segmented } from '../ui/kit';
import { LOCAL_CATALOGUE_TITLE, PUBCHEM_TITLE } from './catalogue';
import { STATUS_LABELS, STATUS_LADDER, STATUS_REQUIREMENTS, USER_EVIDENCE, canAdvance, canStepBack, identicalStructure, latestIdentitySearches, statusMeaning } from './ladder';
import type { CatalogueSearch, Evidence, EvidenceKind } from './ladder';
import {
  addCandidate,
  addEvidence,
  advanceStatus,
  cancelCalculation,
  deleteCandidate,
  dismissVaultProblem,
  exportCandidate,
  exportCandidateMarkdown,
  hasOptimisedGeometry,
  loadCandidates,
  openInArchitect,
  optimisedDisplacement,
  pickCandidateFile,
  renameCandidate,
  runCalculation,
  searchAgain,
  selectCandidate,
  selectedCandidate,
  setCompareOptimised,
  setVaultTab,
  stepBackStatus,
  syncVaultStage,
  useVault,
} from './store';
import type { Candidate, VaultTab } from './store';

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function StatusChip({ candidate }: { candidate: Candidate }) {
  return (
    <span className="ml-rung-chip" data-rung={STATUS_LADDER.indexOf(candidate.status) + 1} data-testid="vault-status">
      {STATUS_LABELS[candidate.status]}
    </span>
  );
}

function Working({ text, onCancel }: { text: string; onCancel?: () => void }) {
  return (
    <div className="ml-running" data-testid="vault-busy">
      <div className="ml-progress" data-indeterminate="true" style={{ margin: 0 }}>
        <i />
      </div>
      <span className="ml-mono">{text}</span>
      {onCancel && (
        <Button size="sm" variant="outline" onClick={onCancel} data-testid="vault-cancel">
          <Square /> Cancel
        </Button>
      )}
    </div>
  );
}

function PubChemChoice({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="ml-checkline">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid="vault-pubchem" />
      <span>
        Also ask PubChem
        <small>Sends the InChIKey and SMILES of the structure to pubchem.ncbi.nlm.nih.gov.</small>
      </span>
    </label>
  );
}

/** Says what the stage shows while the Vault is on screen. Sits between the top bars. */
export function VaultBanner() {
  const candidate = useVault(selectedCandidate);
  if (!candidate) return null;
  return (
    <div className="ml-panel ml-legend ml-legend--fields" data-testid="vault-banner">
      <div className="ml-legend__row">
        <EvidenceBadge level="user-input" tipPos="bottom" />
        <span className="ml-legend__name">{candidate.title}</span>
        <span className="ml-legend__key">
          <ChemText text={candidate.formula} />
        </span>
        <StatusChip candidate={candidate} />
      </div>
      <div className="ml-legend__note">A candidate for investigation, shown as it was drawn. The geometry is the user’s, not a measurement.</div>
    </div>
  );
}

function SidePanel() {
  const candidates = useVault((s) => s.candidates);
  const loaded = useVault((s) => s.loaded);
  const selectedId = useVault((s) => s.selectedId);
  const busy = useVault((s) => s.busy);
  const busyText = useVault((s) => s.busyText);
  const problem = useVault((s) => s.problem);
  const architectScene = useLab((s) => architectDocument(s).scene);
  const architectName = useLab((s) => architectDocument(s).projectName);
  const [title, setTitle] = useState('');
  const [pubchem, setPubchem] = useState(false);
  const atoms = architectScene.atoms.size;

  return (
    <aside className="ml-panel ml-sidepanel" aria-label="Discovery Vault" data-testid="vault-side">
      <div className="ml-sidepanel__head">
        <span className="ml-hero__title">Discovery Vault</span>
        <IconButton size="sm" tip="Hide this panel" tipPos="bottom" onClick={() => lab.set({ sidePanelOpen: false })}>
          <ChevronLeft />
        </IconButton>
      </div>
      <div className="ml-sidepanel__body ml-scroll">
        <p className="ml-empty" style={{ margin: 0 }}>
          A candidate is a structure put forward for investigation. The Vault records what was checked, where the structure was looked for and what evidence is attached. A
          search that finds nothing says only where it looked.
        </p>

        <Section title="Add a candidate">
          {atoms === 0 ? (
            <>
              <p className="ml-empty" style={{ margin: 0 }} data-testid="vault-architect-empty">
                The Architect is empty. Build or open a structure there, then come back to add it.
              </p>
              <Button size="sm" variant="outline" style={{ alignSelf: 'flex-start' }} onClick={() => enterWorkspace('architect')}>
                <Hexagon /> Go to the Architect
              </Button>
            </>
          ) : (
            <>
              <div className="ml-source" data-testid="vault-architect-structure">
                <b style={{ color: 'var(--text)' }}>{architectName}</b>
                <span style={{ color: 'var(--text-2)' }}>
                  <ChemText text={hillFormula(architectScene, undefined, 'plain')} /> · {atoms} atom{atoms === 1 ? '' : 's'} · the structure now in the Architect
                </span>
              </div>
              <TextField value={title} onCommit={setTitle} label="Title of the candidate" placeholder={`Title (default: ${architectName})`} testId="vault-title" />
              <PubChemChoice checked={pubchem} onChange={setPubchem} />
              <Button
                variant="primary"
                disabled={busy !== null}
                style={{ alignSelf: 'flex-start' }}
                data-testid="vault-add"
                onClick={() => {
                  void addCandidate({ title, pubchem }).then((id) => {
                    if (id) setTitle('');
                  });
                }}
              >
                <Plus /> Add as candidate
              </Button>
            </>
          )}
          {busy === 'adding' && <Working text={busyText ?? 'working…'} />}
          {problem && (
            <Note severity="error">
              <span data-testid="vault-problem">{problem}</span>
              <button type="button" className="ml-link" style={{ display: 'block', marginTop: 5 }} onClick={dismissVaultProblem}>
                Dismiss
              </button>
            </Note>
          )}
        </Section>

        <Section
          title={`Candidates${candidates.length > 0 ? ` · ${candidates.length}` : ''}`}
          right={
            <Button size="sm" disabled={busy !== null} tip="Take a candidate in from an exported data file (.candidate.json)" tipPos="top-end" aria-label="Import a candidate" onClick={pickCandidateFile} data-testid="vault-import">
              <Upload /> Import
            </Button>
          }
        >
          {!loaded ? (
            <p className="ml-empty" style={{ margin: 0 }}>
              Loading…
            </p>
          ) : candidates.length === 0 ? (
            <p className="ml-empty" style={{ margin: 0 }} data-testid="vault-none">
              No candidates yet. They are kept in this browser’s storage on this device and stay until you delete them.
            </p>
          ) : (
            <div className="ml-list" data-testid="vault-list">
              {candidates.map((candidate) => (
                <div key={candidate.id} className="ml-saved" data-current={candidate.id === selectedId}>
                  <button type="button" className="ml-saved__main" onClick={() => selectCandidate(candidate.id)} data-testid="vault-item">
                    <b>{candidate.title}</b>
                    <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>
                      <ChemText text={candidate.formula} /> · {STATUS_LABELS[candidate.status]}
                    </span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </aside>
  );
}

function Ladder({ candidate }: { candidate: Candidate }) {
  const current = STATUS_LADDER.indexOf(candidate.status);
  // A structure that is already catalogued cannot climb past "structurally validated".
  const catalogued = identicalStructure(candidate.searches) !== null;
  return (
    <ol className="ml-ladder" data-testid="vault-ladder">
      {STATUS_LADDER.map((status, i) => {
        const state = i < current ? 'reached' : i === current ? 'current' : catalogued ? 'closed' : 'ahead';
        return (
          <li key={status} className="ml-ladder__rung" data-state={state} data-testid={`rung-${status}`}>
            <i>{i < current ? <Check /> : i + 1}</i>
            <div>
              <b>{STATUS_LABELS[status]}</b>
              <span>{state === 'closed' ? 'Does not apply: an identical structure is already catalogued.' : STATUS_REQUIREMENTS[status]}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StatusTab({ candidate }: { candidate: Candidate }) {
  const check = canAdvance(candidate);
  const [justification, setJustification] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => {
    setJustification('');
    setRefusal(null);
  }, [candidate.id, candidate.status]);

  return (
    <>
      <div data-testid="vault-header">
        <TextField value={candidate.title} onCommit={(value) => void renameCandidate(candidate.id, value)} label="Title of the candidate" testId="vault-rename" />
        <div className="ml-hero__sub" style={{ marginTop: 5 }}>
          <ChemText text={candidate.formula} /> · {candidate.atomCount} atoms · recorded {when(candidate.createdAt)}
        </div>
        <div className="ml-hero__sub ml-mono" style={{ fontSize: 10.5, userSelect: 'text' }} data-testid="vault-id">
          {candidate.id}
        </div>
      </div>

      <Section title="Status" right={<StatusChip candidate={candidate} />}>
        <p className="ml-vault-meaning" data-testid="vault-meaning">
          {statusMeaning(candidate)}
        </p>
        <Ladder candidate={candidate} />
        {check.next &&
          (check.allowed ? (
            <div className="ml-vault-advance">
              <TextField value={justification} onCommit={setJustification} label="Why the next rung applies" placeholder="Why this rung applies (kept in the record)" testId="vault-justification" />
              <Button
                variant="primary"
                style={{ alignSelf: 'flex-start' }}
                data-testid="vault-advance"
                onClick={() => void advanceStatus(candidate.id, justification).then(setRefusal)}
              >
                Raise to “{STATUS_LABELS[check.next]}”
              </Button>
            </div>
          ) : (
            <p className="ml-empty" style={{ margin: 0 }} data-testid="vault-missing">
              Next rung, “{STATUS_LABELS[check.next]}”: {check.missing}
            </p>
          ))}
        {refusal && <Note severity="warning">{refusal}</Note>}
        {canStepBack(candidate) && (
          <Button size="sm" variant="outline" style={{ alignSelf: 'flex-start' }} onClick={() => void stepBackStatus(candidate.id)} data-testid="vault-step-back">
            <Undo2 /> Step back one rung
          </Button>
        )}
      </Section>

      <Section title="Structure" right={<EvidenceBadge level={candidate.structureValid ? 'computed' : 'user-input'} />}>
        {candidate.structureValid ? (
          <dl className="ml-kv" data-testid="vault-identity">
            <dt>SMILES</dt>
            <dd className="ml-mono">{candidate.smiles}</dd>
            <dt>InChIKey</dt>
            <dd className="ml-mono" data-testid="vault-inchikey">
              {candidate.inchiKey}
            </dd>
            <dt>Checked by</dt>
            <dd>RDKit {candidate.validation.rdkitVersion}</dd>
          </dl>
        ) : (
          <Note severity="error">
            <span data-testid="vault-invalid">RDKit does not accept this structure.</span>
            {candidate.validation.rdkitErrors.map((message, i) => (
              <span key={i} style={{ display: 'block', marginTop: 3 }}>
                {message}
              </span>
            ))}
          </Note>
        )}
        {candidate.validation.ruleMessages.length > 0 && (
          <Note severity="warning">
            MATTER LAB’s rule-based check: {candidate.validation.ruleErrors} error{candidate.validation.ruleErrors === 1 ? '' : 's'}, {candidate.validation.ruleWarnings} warning
            {candidate.validation.ruleWarnings === 1 ? '' : 's'}.
            {candidate.validation.ruleMessages.slice(0, 4).map((message, i) => (
              <span key={i} style={{ display: 'block', marginTop: 3 }}>
                {message}
              </span>
            ))}
          </Note>
        )}
        <p className="ml-empty" style={{ margin: 0 }}>
          The structure of a candidate is never edited. To change it, open a copy in the Architect and add the result as a new candidate.
        </p>
      </Section>

      <div className="ml-actions">
        <Button size="sm" variant="outline" onClick={() => openInArchitect(candidate.id)} data-testid="vault-open">
          <Hexagon /> Open a copy in the Architect
        </Button>
        <Button size="sm" variant="outline" tip="A report for reading, in Markdown" tipPos="top" aria-label="Export report" onClick={() => exportCandidateMarkdown(candidate.id)} data-testid="vault-export-report">
          <ScrollText /> Export report
        </Button>
        <Button
          size="sm"
          variant="outline"
          tip="Everything on record, with the coordinates; can be imported again"
          tipPos="top"
          aria-label="Export data"
          onClick={() => exportCandidate(candidate.id)}
          data-testid="vault-export"
        >
          <Download /> Export data
        </Button>
        <Button size="sm" variant="danger" onClick={() => void deleteCandidate(candidate.id)} data-testid="vault-delete">
          <Trash2 /> Delete
        </Button>
      </div>
    </>
  );
}

function outcomeText(search: CatalogueSearch): string {
  if (search.outcome === 'error') return 'did not complete';
  if (search.method === 'exact-inchikey') return search.outcome === 'match' ? 'identical structure on record' : 'no record with this InChIKey';
  return search.outcome === 'match' ? `${search.matches.length} similar` : 'none above the threshold';
}

function MatchLink({ name, id, url }: { name: string; id: string; url?: string }): ReactNode {
  return url ? (
    <a className="ml-link" href={url} target="_blank" rel="noreferrer">
      {name} <ExternalLink style={{ width: 11, height: 11, verticalAlign: '-1px' }} />
    </a>
  ) : (
    <span title={id}>{name}</span>
  );
}

function SearchesTab({ candidate }: { candidate: Candidate }) {
  const busy = useVault((s) => s.busy);
  const busyText = useVault((s) => s.busyText);
  const [pubchem, setPubchem] = useState(false);
  const identity = latestIdentitySearches(candidate.searches);
  const found = identicalStructure(candidate.searches);
  const failed = candidate.searches.filter((s) => s.method === 'exact-inchikey' && s.outcome === 'error');
  const similar = [LOCAL_CATALOGUE_TITLE, PUBCHEM_TITLE].flatMap((title) => {
    const searches = candidate.searches.filter((s) => s.method === 'similarity' && s.catalogueTitle === title && s.outcome !== 'error');
    return searches.length > 0 ? [searches[searches.length - 1]!] : [];
  });

  if (!candidate.structureValid) {
    return <p className="ml-empty">A structure RDKit does not accept has no identifiers, so no catalogue can be searched for it.</p>;
  }
  return (
    <>
      <Section title="Identical structure" right={<EvidenceBadge level="reference" />}>
        {found ? (
          <Note severity="info">
            <span data-testid="vault-found">
              On record: <MatchLink {...found.match} /> ({found.match.id}) in {found.search.catalogueTitle}.
            </span>
          </Note>
        ) : identity.length === 0 ? (
          <p className="ml-empty" style={{ margin: 0 }} data-testid="vault-unsearched">
            No search for the identical structure has been completed.
          </p>
        ) : (
          <p className="ml-vault-meaning" data-testid="vault-not-found">
            None of the catalogues searched holds a record with this InChIKey.
          </p>
        )}
        {identity.length > 0 && (
          <div className="ml-list" data-testid="vault-catalogues">
            {identity.map((search) => (
              <div key={search.id} className="ml-source" data-outcome={search.outcome}>
                <b style={{ color: 'var(--text)' }}>{search.catalogueTitle}</b>
                <span style={{ color: 'var(--text-2)' }}>
                  {outcomeText(search)} · {search.recordsSearched !== null ? `${search.recordsSearched} records searched` : 'size of the collection not reported'} · {when(search.searchedAt)}
                </span>
              </div>
            ))}
          </div>
        )}
        {failed.length > 0 && (
          <Note severity="warning">
            <span data-testid="vault-search-failed">
              {failed.length} search{failed.length === 1 ? '' : 'es'} did not complete and count{failed.length === 1 ? 's' : ''} for nothing: {failed[failed.length - 1]!.catalogueTitle},{' '}
              {failed[failed.length - 1]!.detail}
            </span>
          </Note>
        )}
        <p className="ml-empty" style={{ margin: 0 }}>
          Identity is equality of the standard InChIKey. Catalogues not listed here were not searched, and neither was the literature.
        </p>
      </Section>

      <Section title="Similar structures" right={<EvidenceBadge level="computed" />}>
        {similar.length === 0 ? (
          <p className="ml-empty" style={{ margin: 0 }}>
            No similarity search has been completed.
          </p>
        ) : (
          similar.map((search) => (
            <div key={search.id} className="ml-similar" data-testid="vault-similar">
              <span className="ml-label">{search.catalogueTitle}</span>
              {search.matches.length === 0 ? (
                <span className="ml-empty">No structure reaches the threshold.</span>
              ) : (
                <dl className="ml-kv">
                  {search.matches.map((match) => (
                    <div key={match.id} style={{ display: 'contents' }}>
                      <dt>
                        <MatchLink {...match} />
                      </dt>
                      <dd className="ml-mono">{match.similarity !== undefined ? match.similarity.toFixed(2) : (match.formula ?? match.id)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <span className="ml-empty">{search.detail}</span>
            </div>
          ))
        )}
        <p className="ml-empty" style={{ margin: 0 }}>
          Resemblance is not identity: similar structures are listed for orientation and do not change the status.
        </p>
      </Section>

      <Section title="Search again">
        <PubChemChoice checked={pubchem} onChange={setPubchem} />
        {busy === 'searching' ? (
          <Working text={busyText ?? 'searching…'} />
        ) : (
          <Button size="sm" variant="outline" style={{ alignSelf: 'flex-start' }} disabled={busy !== null} onClick={() => void searchAgain(candidate.id, pubchem)} data-testid="vault-search">
            <Search /> Search the catalogues
          </Button>
        )}
        <p className="ml-empty" style={{ margin: 0 }}>
          Earlier searches stay in the record. For each catalogue the most recent completed search decides.
        </p>
      </Section>

      <details className="ml-details">
        <summary>Every search as it happened · {candidate.searches.length}</summary>
        <div className="ml-list" style={{ marginTop: 6 }} data-testid="vault-search-log">
          {candidate.searches.map((search) => (
            <div key={search.id} className="ml-source">
              <b style={{ color: 'var(--text)' }}>
                {search.catalogueTitle} · {search.method === 'exact-inchikey' ? 'identical structure' : 'similarity'}
              </b>
              <span style={{ color: 'var(--text-2)' }}>
                {when(search.searchedAt)} · {outcomeText(search)}
              </span>
              <span style={{ color: 'var(--text-3)' }}>{search.detail}</span>
            </div>
          ))}
        </div>
      </details>
    </>
  );
}

const EVIDENCE_ICON: Readonly<Record<EvidenceKind, typeof Check>> = {
  note: StickyNote,
  'structure-validation': ShieldCheck,
  'catalogue-search': Search,
  calculation: Calculator,
  'experimental-observation': Eye,
  'independent-validation': Check,
  'status-change': ScrollText,
};

const EVIDENCE_NAME: Readonly<Record<EvidenceKind, string>> = {
  note: 'Note',
  'structure-validation': 'Validation',
  'catalogue-search': 'Search',
  calculation: 'Calculation',
  'experimental-observation': 'Experimental observation',
  'independent-validation': 'Independent validation',
  'status-change': 'Status',
};

function TrailEntry({ evidence }: { evidence: Evidence }) {
  const Icon = EVIDENCE_ICON[evidence.kind];
  const unverified = evidence.recordedBy === 'user' && (evidence.kind === 'experimental-observation' || evidence.kind === 'independent-validation');
  return (
    <li className="ml-trail__entry" data-kind={evidence.kind} data-converged={evidence.converged} data-testid="vault-evidence">
      <Icon />
      <div>
        <b>
          {EVIDENCE_NAME[evidence.kind]}
          {evidence.kind === 'calculation' && (evidence.converged ? ' · converged' : ' · not converged')}
        </b>
        <span>{evidence.summary}</span>
        {evidence.reference && <span className="ml-trail__reference">Reference: {evidence.reference}</span>}
        <small>
          {when(evidence.createdAt)} · {evidence.recordedBy === 'user' ? (unverified ? 'stated by the user, not verified' : 'recorded by the user') : 'recorded by MATTER LAB'}
        </small>
      </div>
    </li>
  );
}

function EvidenceTab({ candidate }: { candidate: Candidate }) {
  const busy = useVault((s) => s.busy);
  const busyText = useVault((s) => s.busyText);
  const problem = useVault((s) => s.problem);
  const compare = useVault((s) => s.compareOptimised);
  const [kind, setKind] = useState<EvidenceKind>('experimental-observation');
  const [summary, setSummary] = useState('');
  const [reference, setReference] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const rule = USER_EVIDENCE.find((entry) => entry.kind === kind)!;

  return (
    <>
      <Section title="Calculations" right={<EvidenceBadge level="computed" />}>
        {busy === 'calculating' ? (
          <Working text={busyText ?? 'calculating…'} onCancel={cancelCalculation} />
        ) : (
          <div className="ml-actions">
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void runCalculation(candidate.id, 'uff')} data-testid="vault-run-uff">
              <Sparkles /> Optimise with the force field
            </Button>
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void runCalculation(candidate.id, 'rhf')} data-testid="vault-run-rhf">
              <Atom /> Run Hartree–Fock
            </Button>
          </div>
        )}
        {problem && (
          <Note severity="warning">
            <span data-testid="vault-calculation-problem">{problem}</span>
            <button type="button" className="ml-link" style={{ display: 'block', marginTop: 5 }} onClick={dismissVaultProblem}>
              Dismiss
            </button>
          </Note>
        )}
        {hasOptimisedGeometry(candidate) && (
          <Button size="sm" variant="outline" active={compare} style={{ alignSelf: 'flex-start' }} onClick={() => setCompareOptimised(!compare)} data-testid="vault-compare">
            {compare ? <EyeOff /> : <Eye />} {compare ? 'Hide the optimised geometry' : 'Compare with the optimised geometry'}
          </Button>
        )}
        {compare && (
          <p className="ml-empty" style={{ margin: 0 }} data-testid="vault-compare-note">
            The orange outline is the force-field geometry, drawn over the model; the solid model is the structure as recorded. They differ by{' '}
            {(optimisedDisplacement(candidate) ?? 0).toFixed(2)} Å (RMS over all atoms, without alignment). Neither is a measurement.
          </p>
        )}
        <p className="ml-empty" style={{ margin: 0 }}>
          Every outcome is attached, converged or not. A converged force-field optimisation shows that the drawn bonding has an energy minimum in a classical model; a
          converged Hartree–Fock run shows that a closed-shell electronic state exists at this geometry in a minimal basis. Neither shows that the compound can be made or is
          stable against rearranging into something else.
        </p>
      </Section>

      <Section title="Add evidence">
        <Segmented<EvidenceKind> label="Kind of evidence" fill value={kind} onChange={setKind} options={USER_EVIDENCE.map((entry) => ({ value: entry.kind, label: entry.label.replace('Experimental ', '').replace('Independent ', '') }))} />
        <textarea
          className="ml-input ml-textarea"
          aria-label="What the evidence shows"
          placeholder={kind === 'note' ? 'Note' : 'What was observed, by which method'}
          value={summary}
          rows={3}
          data-testid="vault-evidence-summary"
          onChange={(e) => setSummary(e.target.value)}
        />
        <input
          className="ml-input"
          aria-label="Reference"
          placeholder={rule.needsReference ? 'Reference (required): citation, DOI, URL or lab-notebook entry' : 'Reference (optional)'}
          value={reference}
          data-testid="vault-evidence-reference"
          onChange={(e) => setReference(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          style={{ alignSelf: 'flex-start' }}
          data-testid="vault-evidence-add"
          onClick={() =>
            void addEvidence(candidate.id, kind, summary, reference).then((refused) => {
              setRefusal(refused);
              if (!refused) {
                setSummary('');
                setReference('');
              }
            })
          }
        >
          <Plus /> Add to the record
        </Button>
        {refusal && (
          <Note severity="warning">
            <span data-testid="vault-evidence-refused">{refusal}</span>
          </Note>
        )}
        <p className="ml-empty" style={{ margin: 0 }}>
          Observations and validations are recorded as you state them. MATTER LAB does not verify them and says so wherever they are shown. Entries cannot be edited or
          removed afterwards.
        </p>
      </Section>

      <Section title={`Evidence trail · ${candidate.evidence.length}`}>
        <ol className="ml-trail" data-testid="vault-trail">
          {candidate.evidence.map((evidence) => (
            <TrailEntry key={evidence.id} evidence={evidence} />
          ))}
        </ol>
      </Section>
    </>
  );
}

function Explainer() {
  return (
    <div data-testid="vault-explainer">
      <div className="ml-hero__title">No candidate selected</div>
      <p className="ml-empty">
        Add the structure from the Architect, or choose a candidate on the left. Each candidate stands on one rung of this ladder; the first three are set by validation and
        searching, the others need evidence that you attach.
      </p>
      <ol className="ml-ladder">
        {STATUS_LADDER.map((status, i) => (
          <li key={status} className="ml-ladder__rung" data-state="ahead">
            <i>{i + 1}</i>
            <div>
              <b>{STATUS_LABELS[status]}</b>
              <span>{STATUS_REQUIREMENTS[status]}</span>
            </div>
          </li>
        ))}
      </ol>
      <p className="ml-empty">No rung says that a compound is new. Not finding a structure in a catalogue shows where it was looked for, and nothing about everywhere else.</p>
    </div>
  );
}

function CandidatePanel() {
  const open = useLab((s) => s.inspectorOpen);
  const candidate = useVault(selectedCandidate);
  const tab = useVault((s) => s.tab);
  if (!open) return null;
  return (
    <div className="ml-right">
      <aside className="ml-panel ml-inspector" aria-label="Candidate" data-testid="vault-candidate">
        <div className="ml-inspector__tabs">
          <Segmented<VaultTab>
            label="Candidate section"
            fill
            value={tab}
            onChange={setVaultTab}
            options={[
              { value: 'status', label: 'Status' },
              { value: 'searches', label: 'Searches' },
              { value: 'evidence', label: 'Evidence' },
            ]}
          />
          <IconButton size="sm" tip="Hide this panel" tipPos="bottom-end" onClick={() => lab.set({ inspectorOpen: false })}>
            <ChevronRight />
          </IconButton>
        </div>
        <div className="ml-inspector__body ml-scroll">
          {!candidate ? <Explainer /> : tab === 'status' ? <StatusTab candidate={candidate} /> : tab === 'searches' ? <SearchesTab candidate={candidate} /> : <EvidenceTab candidate={candidate} />}
        </div>
      </aside>
    </div>
  );
}

/**
 * The Discovery Vault workspace: candidates on the left, the selected candidate's status, searches
 * and evidence on the right, and its structure as drawn in the middle.
 */
export function VaultLab() {
  const sidePanelOpen = useLab((s) => s.sidePanelOpen);
  useEffect(() => {
    void loadCandidates().then(() => syncVaultStage(true));
  }, []);
  return (
    <>
      {sidePanelOpen ? (
        <div className="ml-sideslot">
          <SidePanel />
        </div>
      ) : (
        <div className="ml-left">
          <div className="ml-panel ml-bar ml-bar--vertical">
            <IconButton size="lg" tip="Show the candidates" tipPos="right" onClick={() => lab.set({ sidePanelOpen: true })} data-testid="vault-show-side">
              <ChevronRight />
            </IconButton>
          </div>
        </div>
      )}
      <CandidatePanel />
    </>
  );
}
