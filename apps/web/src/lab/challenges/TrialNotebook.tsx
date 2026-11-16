import { useId, useState } from 'react';
import { LabButton, LabSection, LabStateNotice, LabTag } from '../../design-system/lab/primitives';
import { supportedObservations } from './evidence.ts';
import {
  buildTrialNotebook, compareTrialPair, replayCursorForKey, trialNotebookRows, trialPlotPoints, trialReplayFrames,
} from './notebook.ts';
import type { TrialNotebookExport, TrialPlotPoint } from './notebook.ts';
import type { ChallengeAttempt, ChallengeController, ChallengeDefinition, TrialEvidence } from './types.ts';

const ml = (value: number | null) => value === null ? '—' : (value * 1000).toFixed(3);
const show = (value: number | null) => value === null ? '—' : value.toFixed(3);

export function TrialPlot({ primary, secondary = [] }: { readonly primary: readonly TrialPlotPoint[]; readonly secondary?: readonly TrialPlotPoint[] }) {
  const id = useId();
  const all = [...primary, ...secondary];
  if (!all.length) return <LabStateNotice status="empty" compact>No supported receiver pH observations with accepted volume context are available.</LabStateNotice>;
  const maximumX = Math.max(1e-9, ...all.map((point) => point.deliveredVolumeL));
  const minimumY = Math.min(...all.map((point) => point.pH)) - 0.25;
  const maximumY = Math.max(...all.map((point) => point.pH)) + 0.25;
  const xy = (point: TrialPlotPoint) => `${48 + point.deliveredVolumeL / maximumX * 360},${164 - (point.pH - minimumY) / (maximumY - minimumY) * 132}`;
  return <figure className="mlab-learning__plot">
    <svg viewBox="0 0 450 210" role="img" aria-labelledby={`${id}-title ${id}-description`}>
      <title id={`${id}-title`}>Recorded pH versus accepted delivered volume</title>
      <desc id={`${id}-description`}>Solid line: selected trial. Dashed line: comparison trial when selected. Points are supported model or reference observations; lines only join those samples.</desc>
      <path className="mlab-learning__axes" d="M48 24V164H415" fill="none" />
      <text x="14" y="24">pH</text>
      <text x="12" y="43">{maximumY.toFixed(1)}</text>
      <text x="12" y="163">{minimumY.toFixed(1)}</text>
      <text x="45" y="183">0</text>
      <text x="372" y="183">{ml(maximumX)}</text>
      <text x="113" y="202">Accepted delivered volume (mL)</text>
      <polyline className="mlab-learning__curve" points={primary.map(xy).join(' ')} fill="none" />
      {secondary.length > 0 && <polyline className="mlab-learning__curve mlab-learning__curve--comparison" points={secondary.map(xy).join(' ')} fill="none" strokeDasharray="6 4" />}
      {primary.map((point) => {
        const [cx, cy] = xy(point).split(',');
        return <circle key={point.observationId} cx={cx} cy={cy} r="2" className="mlab-learning__sample">
          <title>{`${ml(point.deliveredVolumeL)} mL, pH ${point.pH.toFixed(3)}; ${point.evidence}; observation ${point.observationId}`}</title>
        </circle>;
      })}
    </svg>
    <figcaption>Supported recorded samples only. Joined lines are a visual aid, not additional measurements or a fitted equivalence estimate.</figcaption>
    <details><summary>Accessible data table ({all.length} samples)</summary>
      <div className="mlab-learning__table-scroll"><table>
        <caption>Same observations used by the plot; all volumes in mL</caption>
        <thead><tr><th scope="col">Series</th><th scope="col">Sequence</th><th scope="col">Delivered (mL)</th><th scope="col">pH</th><th scope="col">Evidence</th></tr></thead>
        <tbody>{[primary, secondary].flatMap((series, index) => series.map((point) => <tr key={`${index}:${point.observationId}`}>
          <td>{index ? 'Comparison (dashed)' : 'Selected (solid)'}</td><td>{point.sequence}</td><td>{ml(point.deliveredVolumeL)}</td><td>{point.pH.toFixed(3)}</td><td>{point.evidence}</td>
        </tr>))}</tbody>
      </table></div>
    </details>
  </figure>;
}

export function EvidenceReplay({ trial }: { readonly trial: TrialEvidence }) {
  const [cursor, setCursor] = useState(0);
  const frames = trialReplayFrames(trial);
  const index = Math.min(cursor, Math.max(0, frames.length - 1));
  const frame = frames[index];
  if (!frame) return <LabStateNotice status="empty" compact>No accepted event ledger has been recorded for this trial.</LabStateNotice>;
  return <section className="mlab-learning__replay" aria-label="Read-only evidence replay">
    <p>Ledger replay: {index + 1} / {frames.length}. This view never reapplies actions or scores a new trial.</p>
    <div className="mlab-learning__actions">
      <LabButton size="sm" aria-label="Previous ledger event" disabled={index === 0} onClick={() => setCursor(index - 1)}>Previous</LabButton>
      <input type="range" aria-label="Evidence replay event" min={0} max={frames.length - 1} step={1} value={index}
        aria-valuetext={`Event ${index + 1}, sequence ${frame.sequence}, simulation time ${frame.timeS} seconds`}
        onChange={(event) => setCursor(Number(event.target.value))}
        onKeyDown={(event) => {
          const next = replayCursorForKey(index, event.key, frames.length);
          if (next !== null) { event.preventDefault(); setCursor(next); }
        }} />
      <LabButton size="sm" aria-label="Next ledger event" disabled={index === frames.length - 1} onClick={() => setCursor(index + 1)}>Next</LabButton>
    </div>
    <div className="mlab-learning__replay-frame" aria-live="polite">
      <strong>Sequence {frame.sequence} · {frame.timeS.toFixed(2)} s</strong>
      {frame.actions.map((action) => <p key={action.actionId}>APPLIED {action.type} · apparatus <code>{action.targetInstanceId}</code></p>)}
      {frame.observations.map((record) => <p key={record.id}>
        {record.observation.type}: {['MODEL_CALCULATED', 'REFERENCE_MEASURED'].includes(record.observation.evidence)
          ? `${record.observation.quantity.value.toPrecision(6)} ${record.observation.quantity.unit}`
          : 'no supported measurement'} · {record.observation.evidence} · <code>{record.id}</code>
      </p>)}
    </div>
  </section>;
}

function ConclusionForm({ trial, definition, controller }: { readonly trial: TrialEvidence; readonly definition: ChallengeDefinition; readonly controller: ChallengeController }) {
  const [text, setText] = useState(trial.conclusion?.text ?? '');
  const [relationship, setRelationship] = useState(trial.conclusion?.equivalenceAndEndpoint ?? 'unsure');
  const [position, setPosition] = useState(trial.conclusion?.endpointPosition ?? 'unsure');
  const [concentration, setConcentration] = useState(trial.conclusion?.concentration?.value.toString() ?? '');
  const [cite, setCite] = useState(Boolean(trial.endpoint && trial.conclusion?.citedObservationIds.includes(trial.endpoint.observationId)));
  const [limits, setLimits] = useState(trial.conclusion?.acknowledgesModelLimits ?? false);
  const endpoint = trial.endpoint && supportedObservations(trial, definition).find((record) => record.id === trial.endpoint!.observationId);
  return <form className="mlab-learning__form" onSubmit={(event) => {
    event.preventDefault();
    controller.recordConclusion({
      text, citedObservationIds: cite && trial.endpoint ? [trial.endpoint.observationId] : [],
      equivalenceAndEndpoint: relationship, endpointPosition: position, acknowledgesModelLimits: limits,
      ...(concentration.trim() ? { concentration: { value: Number(concentration), unit: 'mol/L' as const } } : {}),
    }, trial.id);
  }}>
    <fieldset disabled={!endpoint}>
      <legend>Evidence-linked scientific conclusion</legend>
      <label>Endpoint and equivalence
        <select value={relationship} onChange={(event) => setRelationship(event.target.value as typeof relationship)}>
          <option value="unsure">Select an interpretation</option><option value="distinct">Different concepts; they need not coincide</option><option value="same">Always the same point</option>
        </select>
      </label>
      <label>Endpoint volume relative to the equivalence learning window
        <select value={position} onChange={(event) => setPosition(event.target.value as typeof position)}>
          <option value="unsure">Select a comparison</option><option value="before">Before the reference window</option><option value="within">Within the reference window</option><option value="after">After the reference window</option>
        </select>
      </label>
      <label>Known-preparation concentration answer (mol/L)
        <input type="number" min={0} step="any" value={concentration} onChange={(event) => setConcentration(event.target.value)} />
      </label>
      <label>Explain what the graph and these observations support
        <textarea rows={4} maxLength={2000} value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      <label className="mlab-learning__check"><input type="checkbox" checked={cite} onChange={(event) => setCite(event.target.checked)} />
        Cite this trial’s endpoint {endpoint ? <code>{endpoint.id}</code> : '(capture required)'}</label>
      <label className="mlab-learning__check"><input type="checkbox" checked={limits} onChange={(event) => setLimits(event.target.checked)} />
        I distinguish model/reference evidence from a physical experiment and do not claim unmeasured experimental uncertainty.</label>
      <LabButton type="submit" size="sm">Save conclusion</LabButton>
    </fieldset>
    <p className="mlab-caption">The rubric checks explicit evidence-linked answers, not the truth of arbitrary free-text prose.</p>
  </form>;
}

export interface TrialNotebookProps {
  readonly attempt: ChallengeAttempt;
  readonly controller: ChallengeController;
  readonly onExport?: (notebook: TrialNotebookExport) => void;
}

export function TrialNotebook({ attempt, controller, onExport }: TrialNotebookProps) {
  const [selectedId, setSelectedId] = useState(attempt.activeTrialId);
  const [comparisonId, setComparisonId] = useState('');
  const trial = attempt.trials.find((entry) => entry.id === selectedId) ?? attempt.trials.find((entry) => entry.id === attempt.activeTrialId)!;
  const comparison = attempt.trials.find((entry) => entry.id === comparisonId);
  const rows = trialNotebookRows(attempt);
  const pair = comparison ? compareTrialPair(attempt, trial.id, comparison.id) : null;
  return <LabSection title="Trial notebook" eyebrow="Evidence before achievement"
    action={onExport && <LabButton size="sm" variant="outline" onClick={() => onExport(buildTrialNotebook(attempt))}>Export complete notebook JSON</LabButton>}>
    <div className="mlab-learning__table-scroll"><table>
      <caption>Immutable endpoint captures; learner notes remain editable. Volume values are mL.</caption>
      <thead><tr><th scope="col">Trial</th><th scope="col">Epoch</th><th scope="col">State</th><th scope="col">Delivered</th><th scope="col">pH at same solve</th><th scope="col">Target deviation</th><th scope="col">Draft score</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.trialId}>
        <th scope="row"><button type="button" onClick={() => setSelectedId(row.trialId)} aria-pressed={row.trialId === trial.id}>Trial {row.number}</button></th>
        <td>{row.scope.epoch}</td><td>{row.status}{row.status === 'captured' && !row.validCapture ? ' (ineligible)' : ''}</td>
        <td>{ml(row.deliveredVolumeL)}</td><td>{show(row.pH)}</td><td>{ml(row.deviationL)}</td>
        <td>{attempt.mode === 'free' ? 'No objective' : `${row.score.total} / ${row.score.maximum}`}</td>
      </tr>)}</tbody>
    </table></div>
    <p className="mlab-learning__scope">Run <code>{trial.scope.runId}</code> · station <code>{trial.scope.stationId}</code> · epoch {trial.scope.epoch}</p>
    <LabTag>{trial.reference.methodId} / {trial.reference.methodVersion}</LabTag>
    <label className="mlab-learning__field">Compare selected trial with
      <select value={comparisonId} onChange={(event) => setComparisonId(event.target.value)}>
        <option value="">No comparison</option>
        {attempt.trials.filter((entry) => entry.id !== trial.id).map((entry) => <option key={entry.id} value={entry.id}>Trial {attempt.trials.indexOf(entry) + 1} · epoch {entry.scope.epoch}</option>)}
      </select>
    </label>
    {pair && (pair.comparable ? <div className="mlab-learning__comparison">
      <p>Comparison minus selected endpoint: {ml(pair.differenceL)} mL.</p>
      <p>Pair mean: {ml(pair.statistics.meanVolumeL)} mL · sample SD: {ml(pair.statistics.sampleStandardDeviationL)} mL.</p>
      <p>{pair.statistics.uncertaintyStatement}</p>
      {!pair.countsTowardSameStationProgress && <p>This is a cross-run/station display comparison only; it cannot satisfy this station’s repeated-trial objective.</p>}
    </div> : <LabStateNotice status="warning" compact>{pair.reason}</LabStateNotice>)}
    <TrialPlot primary={trialPlotPoints(trial, attempt.definition)} secondary={comparison && pair?.comparable ? trialPlotPoints(comparison, attempt.definition) : []} />
    <details><summary>Replay this trial’s accepted event ledger</summary><EvidenceReplay key={trial.id} trial={trial} /></details>
    <label className="mlab-learning__field">Trial notes
      <textarea rows={3} maxLength={4000} value={trial.notes} onChange={(event) => controller.setNotes(event.target.value, trial.id)} />
    </label>
    <ConclusionForm key={trial.id} trial={trial} definition={attempt.definition} controller={controller} />
  </LabSection>;
}
