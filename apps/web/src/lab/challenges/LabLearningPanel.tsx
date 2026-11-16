import { useState } from 'react';
import type { ExperimentAssembly } from '@matterlab/contracts';
import { useLabMotion } from '../../design-system/lab/motion';
import { LabButton, LabSection, LabStateNotice, LabTag } from '../../design-system/lab/primitives';
import { goalHighlight, instructionAction } from './hints.ts';
import { LearningModeChooser } from './LearningModeChooser';
import { createGuidedTemplate } from './notebook.ts';
import type { TrialNotebookExport } from './notebook.ts';
import { captureProblems } from './predicates.ts';
import { endpointTarget, referenceExplanation } from './reference.ts';
import { TrialNotebook } from './TrialNotebook';
import type { ChallengeController, ChallengeView, LearningActionRequest, LearningHighlight } from './types.ts';
import { useChallenge } from './useChallenge.ts';
import './learning.css';

function EndpointControls({ controller, view }: { readonly controller: ChallengeController; readonly view: ChallengeView }) {
  const [selectedId, setSelectedId] = useState('');
  const [readingMl, setReadingMl] = useState('');
  const candidates = view.trial.observations.filter((record) => view.evaluation.eligibleObservationIds.includes(record.id));
  const selected = candidates.find((record) => record.id === selectedId) ?? candidates[0];
  const problems = selected ? captureProblems(view.trial, view.attempt.definition, selected.id) : ['Wait for a supported current receiver observation backed by accepted titrant delivery.'];
  const active = view.trial.status === 'active';
  return <LabSection title="Capture an operational endpoint">
    <label className="mlab-learning__field">Current receiver observation
      <select value={selected?.id ?? ''} onChange={(event) => setSelectedId(event.target.value)} disabled={!active || !candidates.length}>
        {!candidates.length && <option value="">No eligible observation</option>}
        {candidates.map((record) => <option key={record.id} value={record.id}>
          {record.observation.type} {record.observation.quantity.value.toPrecision(5)} {record.observation.quantity.unit} · sequence {record.sequence}
        </option>)}
      </select>
    </label>
    <label className="mlab-learning__field">Your delivered-volume meniscus reading (mL)
      <input type="number" min={0} step="any" value={readingMl} disabled={!active} onChange={(event) => setReadingMl(event.target.value)} />
    </label>
    <div className="mlab-learning__actions">
      <LabButton size="sm" variant="outline" disabled={!active || !selected || !readingMl.trim() || !Number.isFinite(Number(readingMl)) || Number(readingMl) < 0}
        onClick={() => { if (selected) controller.recordReading(selected.id, Number(readingMl) / 1000); }}>Record scale reading</LabButton>
      <LabButton size="sm" disabled={!active || !selected || problems.length > 0}
        onClick={() => { if (selected) controller.captureEndpoint({
          observationId: selected.id, basis: selected.observation.type === 'INDICATOR' ? 'indicator-change' : 'instrument-reading',
        }); }}>Capture current endpoint</LabButton>
    </div>
    <p className="mlab-caption">{active ? problems[0] ?? 'The valve is closed and current evidence is eligible. Capture is your explicit operational choice, not an automatic equivalence claim.'
      : 'This trial is frozen or interrupted. Reset the runtime station to record a new independent trial.'}</p>
  </LabSection>;
}

export interface LabLearningPanelProps {
  readonly controller: ChallengeController;
  readonly onActionRequest?: (request: LearningActionRequest) => void;
  readonly onHighlight?: (highlight: LearningHighlight) => void;
  readonly onExportNotebook?: (notebook: TrialNotebookExport) => void;
  readonly onExportTemplate?: (template: ExperimentAssembly) => void;
  readonly createId?: () => string;
}

/** Inspector/timeline content for Agent01's shell; not a standalone app or laboratory state store. */
export function LabLearningPanel({
  controller, onActionRequest, onHighlight, onExportNotebook, onExportTemplate, createId = () => crypto.randomUUID(),
}: LabLearningPanelProps) {
  const view = useChallenge(controller);
  const motion = useLabMotion();
  const [exportError, setExportError] = useState<string | null>(null);
  const { attempt, trial, evaluation } = view;
  const { reference } = trial;
  const target = endpointTarget(reference);
  const currentAction = instructionAction(view);
  return <div className="mlab-learning" data-motion={motion.reduced ? 'reduced' : 'full'}>
    <LabSection title={attempt.definition.title} eyebrow="Virtual educational experiment">
      <LearningModeChooser mode={attempt.mode} onChange={controller.setMode} />
      <div className="mlab-learning__actions">
        {attempt.mode === 'guided' && <LabButton size="sm" variant="outline" onClick={() => controller.dismissGuide(!attempt.progression.dismissed)}>
          {attempt.progression.dismissed ? 'Show guided instructions' : 'Hide guided instructions'}
        </LabButton>}
        <LabButton size="sm" variant="outline" disabled={!onActionRequest}
          onClick={() => onActionRequest?.({ kind: 'reset', instanceIds: Object.values(trial.bindings) })}>Request fresh trial / station reset</LabButton>
      </div>
      {!onActionRequest && <p className="mlab-caption">Runtime reset and apparatus operation controls must be supplied by the laboratory editor. This panel cannot change inventory.</p>}
      {attempt.mode === 'free' && <p>No forced objective or score. Build independently and inspect supported observations; unsupported chemistry is never replaced by a plausible value.</p>}
      <p className="mlab-learning__scope">Current station <code>{trial.scope.stationId}</code> · epoch {trial.scope.epoch}</p>
      {view.lastMessage && <p className="mlab-learning__message" role="status" aria-live="polite">{view.lastMessage}</p>}
    </LabSection>

    <LabSection title="Materials and model reference">
      {reference.status !== 'SUPPORTED' ? <LabStateNotice status="unsupported">{reference.reasons.join(' ')}</LabStateNotice> : <>
        <LabTag>{reference.evidence}</LabTag>
        <ul className="mlab-learning__materials">{reference.preparations.map((preparation) => <li key={preparation.role}>
          <strong>{preparation.label}</strong> · {(preparation.contents.volumeL * 1000).toFixed(2)} mL · {preparation.contents.temperatureK} K · {preparation.contents.mixing}
        </li>)}</ul>
        {target && <p>Supplied {reference.indicatorEndpoint ? 'indicator-criterion' : 'equivalence'} volume target: <strong>{(target.value * 1000).toFixed(3)} mL</strong>.</p>}
        <p>Endpoint scoring window: ±{(attempt.definition.rubric.endpointToleranceL * 1000).toFixed(3)} mL. This is a pedagogical tolerance, not measured experimental uncertainty.</p>
      </>}
      <details><summary>Endpoint, equivalence and model limitations</summary>
        {referenceExplanation(reference).map((statement) => <p key={statement}>{statement}</p>)}
        <p>Method: <code>{reference.methodId}</code> / {reference.methodVersion}</p>
        <h4>Assumptions</h4><ul>{reference.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>
        <h4>Limitations and warnings</h4><ul>{[...reference.limitations, ...reference.warnings].map((limitation, index) => <li key={`${index}:${limitation}`}>{limitation}</li>)}</ul>
        <h4>Source identifiers</h4><ul>{reference.sourceIds.map((source) => <li key={source}><code>{source}</code></li>)}</ul>
      </details>
    </LabSection>
    {evaluation.issues.length > 0 && <LabStateNotice status="warning" title="Evidence or setup needs attention"><ul>{evaluation.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></LabStateNotice>}
    {attempt.mode !== 'free' && <LabSection title="Evidence-based objectives">
      <ul className="mlab-learning__goals">{evaluation.goals.map((goal) => <li key={goal.id}>
        <span className="mlab-learning__goal-heading"><strong>{goal.label}</strong><LabTag tone={goal.state === 'complete' ? 'cool' : 'neutral'}>{goal.state}</LabTag></span>
        {goal.reasons.length > 0 && <p>{goal.reasons[0]}</p>}
        <LabButton size="sm" variant="outline" onClick={() => {
          controller.requestHint(goal.id);
          const hint = goalHighlight(view, goal.id, { reducedMotion: motion.reduced, focus: Boolean(onHighlight) });
          if (hint) onHighlight?.(hint);
        }}>Hint / locate apparatus</LabButton>
        {attempt.progression.hintsRequested.includes(goal.id) && <p className="mlab-learning__hint">{attempt.definition.goals.find((entry) => entry.id === goal.id)?.hint}</p>}
      </li>)}</ul>
      <p><strong>{evaluation.score.total} / {evaluation.score.maximum}</strong> · {evaluation.score.complete ? 'Evidence criteria satisfied' : 'Not yet complete'}</p>
      <p className="mlab-caption">{evaluation.score.label}</p>
      <ul>{evaluation.score.categories.map((category) => <li key={category.category}>{category.category}: {category.points}/{category.maximum} · {category.explanation}</li>)}</ul>
      {(attempt.mode === 'precision' || attempt.mode === 'challenge') && <p>
        Independent captures: {evaluation.statistics.count}. Mean: {evaluation.statistics.meanVolumeL === null ? 'unavailable' : `${(evaluation.statistics.meanVolumeL * 1000).toFixed(3)} mL`}.
        {' '}Sample SD: {evaluation.statistics.sampleStandardDeviationL === null ? 'needs at least two captures' : `${(evaluation.statistics.sampleStandardDeviationL * 1000).toFixed(3)} mL`}.
        {' '}{evaluation.statistics.uncertaintyStatement}
      </p>}
    </LabSection>}
    {onActionRequest && <details className="mlab-learning__accessible"><summary>Non-3D guided path / apparatus controls</summary>
      <p>These controls open the real editor’s keyboard-capable inspector. They do not skip validation or complete a goal.</p>
      {currentAction && <LabButton size="sm" onClick={() => onActionRequest(currentAction)}>Open current instruction’s apparatus controls</LabButton>}
      {attempt.definition.instructions.filter((instruction) => instruction.actionKind).map((instruction, index) => <LabButton key={instruction.id} size="sm" variant="outline" onClick={() => {
        const instructionIndex = attempt.definition.instructions.indexOf(instruction);
        const targetView = { ...view, attempt: { ...attempt, progression: { ...attempt.progression, instructionIndex } } };
        const action = instructionAction(targetView);
        if (action) onActionRequest(action);
      }}>{index + 1}. {instruction.title}</LabButton>)}
    </details>}
    <EndpointControls key={trial.id} controller={controller} view={view} />
    <TrialNotebook key={attempt.id} attempt={attempt} controller={controller} onExport={onExportNotebook} />
    {onExportTemplate && <LabSection title="Reuse this apparatus layout">
      <LabButton size="sm" variant="outline" onClick={() => {
        try {
          const template = createGuidedTemplate(attempt, { id: createId(), sceneId: createId(), name: `${attempt.definition.title} — empty apparatus layout` });
          setExportError(null);
          onExportTemplate(template);
        } catch (error) { setExportError(error instanceof Error ? error.message : 'Template export failed.'); }
      }}>Export guided setup as an empty template</LabButton>
      <p className="mlab-caption">Only this station’s registered layout is exported. No trial evidence, prepared inventory or score is copied into a new experiment.</p>
      {exportError && <LabStateNotice status="error" compact>{exportError}</LabStateNotice>}
    </LabSection>}
  </div>;
}
