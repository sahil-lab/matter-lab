import type { Observation, RunResult, ScientificProvenance } from '@matterlab/contracts';
import { ExternalLink, ListTree } from 'lucide-react';
import { useId, useState } from 'react';
import { Segmented } from '../../ui/kit';
import type { LabProperty } from './LabInspector';
import { ObservationReadout } from './ObservationReadout';
import type { ObservationAvailability } from './observations';
import { LabButton, LabSection, LabStateNotice, LabTag } from './primitives';
import type { LabSurfaceAction } from './types';

export interface LabReference {
  readonly id: string;
  readonly title: string;
  readonly authors?: string;
  readonly url?: string;
  readonly doi?: string;
  readonly version?: string;
  readonly license?: string;
}

export interface LabEquation {
  readonly label: string;
  readonly expression: string;
  readonly explanation?: string;
}

export type LabExplanationDepth = 'summary' | 'advanced';

export interface ScientificExplanationPanelProps {
  readonly run: Readonly<RunResult> | null;
  readonly provenance?: Readonly<ScientificProvenance>;
  readonly summary?: string;
  readonly methodLabel?: string;
  readonly equations?: readonly LabEquation[];
  readonly conditions?: readonly LabProperty[];
  readonly references?: readonly LabReference[];
  /** An optional selected subset, still subject to the run's success/failure gate. */
  readonly observations?: readonly Observation[];
  readonly depth?: LabExplanationDepth;
  readonly defaultDepth?: LabExplanationDepth;
  readonly onDepthChange?: (depth: LabExplanationDepth) => void;
  readonly onOpenLedger?: () => void;
  readonly retry?: LabSurfaceAction;
}

export function safeReferenceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch { return undefined; }
}

function TextList({ items, missing }: { items: readonly string[]; missing: string }) {
  return items.length ? <ul className="mlab-science-list">{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul> : <p className="mlab-caption">{missing}</p>;
}

export function ScientificExplanationPanel({
  run, provenance, summary, methodLabel, equations = [], conditions = [], references = [], observations,
  depth, defaultDepth = 'summary', onDepthChange, onOpenLedger, retry,
}: ScientificExplanationPanelProps) {
  const id = useId();
  const [localDepth, setLocalDepth] = useState<LabExplanationDepth>(defaultDepth);
  const shownDepth = depth ?? localDepth;
  const selectedObservations = observations ?? run?.observations ?? [];
  const recordedOnly = !run && selectedObservations.length > 0;
  const sourceIds = [...new Set([...(provenance?.sourceIds ?? []), ...selectedObservations.flatMap((observation) => observation.sourceIds)])];
  const sources = new Map(references.map((source) => [source.id, source]));
  const warningItems = [...new Set([...(run?.warnings ?? []), ...(provenance?.warnings ?? [])])];
  const assumptions = provenance?.assumptions ?? run?.assumptions ?? [];
  const limitations = provenance?.limitations ?? run?.limitations ?? [];
  const diagnostics = provenance?.diagnostics ?? run?.solverDiagnostics;
  const availability: ObservationAvailability = !run ? (recordedOnly ? 'stale' : 'empty') : run.status === 'FAILED' ? 'error' : run.status === 'UNSUPPORTED' ? 'unsupported' : run.status === 'QUEUED' || run.status === 'RUNNING' ? 'loading' : run.status === 'CANCELLED' ? 'stale' : 'current';
  const active = run?.status === 'QUEUED' || run?.status === 'RUNNING';
  const numericResultsAllowed = recordedOnly || run?.status === 'SUCCEEDED' || run?.status === 'CANCELLED';
  const diagnosticJson = shownDepth === 'advanced' && diagnostics ? JSON.stringify(diagnostics, null, 2) : '';
  return (
    <article className="mlab-explanation" aria-labelledby={`${id}-title`}>
      <header className="mlab-explanation__header">
        <div className="mlab-eyebrow">Scientific reasoning / source first</div><h2 id={`${id}-title`}>What supports this result?</h2>
        <Segmented<LabExplanationDepth> label="Scientific explanation depth" value={shownDepth} onChange={(next) => { if (depth === undefined) setLocalDepth(next); onDepthChange?.(next); }} options={[{ value: 'summary', label: 'In plain language' }, { value: 'advanced', label: 'Methods & diagnostics' }]} />
      </header>
      {!run && !recordedOnly && <LabSection><LabStateNotice status="empty" title="No calculation selected">Choose a recorded run to inspect its method and evidence. No explanation of a numerical result is available yet.</LabStateNotice></LabSection>}
      {recordedOnly && <LabSection><LabTag>Recorded observations</LabTag><p className="mlab-caption">No frozen run envelope was supplied. These observations are shown as recorded history, not as a completed experiment.</p></LabSection>}
      {run && (run.status === 'FAILED' || run.status === 'UNSUPPORTED') && <LabSection><LabStateNotice status={run.status === 'FAILED' ? 'error' : 'unsupported'} title={run.error.title} action={retry}>{run.error.detail}<p className="mlab-error-code">{run.error.code}</p></LabStateNotice><p className="mlab-caption">No numeric result from this operation is displayed. Earlier history is not a successful result of this run.</p></LabSection>}
      {active && <LabSection><LabStateNotice status="loading" compact title={run.status === 'QUEUED' ? 'Waiting for a worker' : 'Calculating'}>The result is not final. The viewport stays available while the worker runs.</LabStateNotice></LabSection>}
      {run?.status === 'CANCELLED' && <LabSection><LabStateNotice status="warning" compact title="Run cancelled">Any quantities below were recorded before cancellation. They are not a completed run.</LabStateNotice></LabSection>}
      {summary && (!run || numericResultsAllowed) && <LabSection title="In context"><p className="mlab-prose">{summary}</p></LabSection>}
      {(run || provenance) && <LabSection title="Method" eyebrow={shownDepth === 'advanced' ? 'Reproducibility' : undefined}>
        <p className="mlab-method-name">{methodLabel ?? provenance?.methodId ?? run?.methodId}</p>
        <dl className="mlab-properties"><div><dt>Method ID</dt><dd>{provenance?.methodId ?? run?.methodId}</dd></div><div><dt>Version</dt><dd>{provenance?.methodVersion ?? run?.methodVersion}</dd></div>{run && <div><dt>Run status</dt><dd><LabTag tone={run.status === 'FAILED' ? 'danger' : run.status === 'UNSUPPORTED' ? 'warm' : 'neutral'}>{run.status}</LabTag></dd></div>}</dl>
      </LabSection>}
      {conditions.length > 0 && <LabSection title="Inputs & conditions"><dl className="mlab-properties">{conditions.map((condition, index) => <div key={`${condition.label}-${index}`}><dt title={condition.description}>{condition.label}</dt><dd>{condition.value}{condition.unit && <span className="mlab-unit"> {condition.unit}</span>}</dd></div>)}</dl></LabSection>}
      {(run || recordedOnly) && <LabSection title="Recorded quantities" action={onOpenLedger && <LabButton size="sm" onClick={onOpenLedger}><ListTree />Full ledger</LabButton>}>
        {numericResultsAllowed && selectedObservations.length > 0 ? <>
          {selectedObservations.length > 8 && <p className="mlab-caption">Showing the latest 8 of {selectedObservations.length} recorded quantities. The complete collection remains in the run.</p>}
          <div className="mlab-observation-grid">{selectedObservations.slice(-8).map((observation, index) => <ObservationReadout key={`${observation.type}-${observation.apparatusId}-${observation.timeS}-${index}`} label={observation.type.replaceAll('_', ' ')} observation={observation} availability={availability} />)}</div>
        </> : <p className="mlab-caption">{active ? 'Waiting for a completed result.' : numericResultsAllowed ? 'The run supplied no observations.' : 'Numerical outputs withheld for this unsuccessful operation.'}</p>}
      </LabSection>}
      {shownDepth === 'advanced' && <LabSection title="Equations">
        {equations.length ? equations.map((equation, index) => <figure className="mlab-equation" key={`${equation.label}-${index}`}><figcaption>{equation.label}</figcaption><pre>{equation.expression}</pre>{equation.explanation && <p className="mlab-prose">{equation.explanation}</p>}</figure>) : <p className="mlab-caption">No equation text was supplied by the method. The interface does not substitute one.</p>}
      </LabSection>}
      <LabSection title="Assumptions"><TextList items={assumptions} missing="No assumptions were supplied. Do not interpret that as an assumption-free model." /></LabSection>
      <LabSection title="Limitations"><TextList items={limitations} missing="No limitations were supplied. Absence of a limitation statement is not a claim of accuracy." /></LabSection>
      {warningItems.length > 0 && <LabSection title="Warnings"><LabStateNotice status="warning" compact><TextList items={warningItems} missing="" /></LabStateNotice></LabSection>}
      <LabSection title="Sources & references">
        {sourceIds.length === 0 ? <LabStateNotice status="warning" compact title="No source IDs supplied">No external reference is implied by the interface. Check the method and its provenance before relying on a value.</LabStateNotice> :
          <ol className="mlab-references">{sourceIds.map((sourceId) => {
            const reference = sources.get(sourceId);
            const url = safeReferenceUrl(reference?.url);
            return <li key={sourceId}><code>{sourceId}</code>{reference ? <><cite>{reference.authors && `${reference.authors}. `}{reference.title}</cite>{url && <a href={url} target="_blank" rel="noopener noreferrer">Open reference<ExternalLink aria-hidden="true" /></a>}{reference.doi && <p>DOI / {reference.doi}</p>}{reference.version && <p>Version / {reference.version}</p>}{reference.license && <p>License / {reference.license}</p>}</> : <p>Reference metadata was not supplied for this source ID.</p>}</li>;
          })}</ol>}
      </LabSection>
      {shownDepth === 'advanced' && <LabSection title="Diagnostics & lineage">
        {diagnosticJson ? <><pre className="mlab-diagnostics" tabIndex={0} aria-label="Solver diagnostics">{diagnosticJson.slice(0, 20000)}</pre>{diagnosticJson.length > 20000 && <p className="mlab-caption">Preview limited to 20,000 characters. Full diagnostics remain in the run export.</p>}</> : <p className="mlab-caption">No solver diagnostics were supplied.</p>}
        {run && <dl className="mlab-properties"><div><dt>Run ID</dt><dd>{run.runId}</dd></div><div><dt>Frozen input hash</dt><dd>{run.inputHash}</dd></div></dl>}
        <p className="mlab-caption">These are quoted model outputs and metadata, not computations performed by this panel.</p>
      </LabSection>}
    </article>
  );
}
