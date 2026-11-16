import { useEffect, useState } from 'react';
import type { GameMode } from '../goals';
import {
  deleteAttempt,
  exportNotebookJson,
  exportTemplate,
  finishAttempt,
  refreshAttempts,
  setInterpretation,
  setMode,
  setReducedMotion,
  toggleCompare,
  toggleHints,
  useChallenges,
  useFixtureDemoSource,
} from '../state';
import { AccessibleChecklist } from './AccessibleChecklist';
import { AttemptsPanel } from './AttemptsPanel';
import { DemoControls } from './DemoControls';
import { HintOverlay } from './HintOverlay';
import { NotebookView } from './NotebookView';
import { CompareView, ReplayView } from './ReplayCompareView';
import { ScoreCard } from './ScoreCard';
import './challenges.css';

const MODE_LABEL: Readonly<Record<GameMode, string>> = { guided: 'Guided Lab', challenge: 'Challenge', free: 'Free Experiment', precision: 'Precision' };
const MODES: readonly GameMode[] = ['guided', 'challenge', 'free', 'precision'];

const MODE_BLURB: Readonly<Record<GameMode, string>> = {
  guided: 'Step-by-step hints walk you through the whole titration.',
  challenge: 'You get the target and materials, but no step-by-step overlay.',
  free: 'Build any setup you like. Nothing here is graded.',
  precision: 'Repeat the titration and be scored on how reproducible your measurements are.',
};

function InterpretationForm({ trialId }: { trialId: string }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="lc-interpretation"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) setInterpretation(trialId, { reportedAnalyteMolarity: n });
      }}
    >
      <label>
        Your calculated analyte molarity (mol/L)
        <input type="number" step="0.0001" min="0" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <button type="submit">Submit conclusion</button>
    </form>
  );
}

export function ChallengesWorkspace() {
  const mode = useChallenges((s) => s.mode);
  const dataSourceKind = useChallenges((s) => s.dataSourceKind);
  const demoRuntime = useChallenges((s) => s.demoRuntime);
  const hint = useChallenges((s) => s.hint);
  const hintsEnabled = useChallenges((s) => s.hintsEnabled);
  const reducedMotion = useChallenges((s) => s.reducedMotion);
  const checklist = useChallenges((s) => s.checklist);
  const score = useChallenges((s) => s.score);
  const notebook = useChallenges((s) => s.notebook);
  const evaluation = useChallenges((s) => s.evaluation);
  const attempts = useChallenges((s) => s.attempts);
  const achievements = useChallenges((s) => s.achievements);
  const compareIds = useChallenges((s) => s.compareIds);
  const comparison = useChallenges((s) => s.comparison);
  const trials = useChallenges((s) => s.ctx.trials);

  useEffect(() => {
    void refreshAttempts();
  }, []);

  const lastTrial = trials[trials.length - 1];
  const canSave = evaluation.complete && trials.some((t) => t.endpoint !== null);

  return (
    <div className="lc-root" data-reduced-motion={reducedMotion}>
      <header className="lc-header">
        <div className="lc-modes" role="tablist" aria-label="Game mode">
          {MODES.map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <div className="lc-headeractions">
          <button type="button" onClick={() => useFixtureDemoSource()}>
            {dataSourceKind === 'fixture-demo' ? 'Restart fixture demo' : 'Start fixture demo'}
          </button>
          <label>
            <input type="checkbox" checked={hintsEnabled} onChange={toggleHints} /> Hints
          </label>
          <label>
            <input type="checkbox" checked={reducedMotion} onChange={(e) => setReducedMotion(e.target.checked)} /> Reduced motion
          </label>
        </div>
      </header>

      <p className="lc-modeblurb">{MODE_BLURB[mode]}</p>

      {dataSourceKind === 'live' && (
        <p className="lc-note" role="status">
          Experiment runtime not connected yet (Agent 07 experiment graph and Agent 06 titration solver are pending integration). Start the fixture demo to exercise this surface end-to-end with
          clearly labelled fixture data.
        </p>
      )}

      {demoRuntime && <DemoControls runtime={demoRuntime} />}

      <div className="lc-columns">
        <section aria-label="Guided checklist">
          {mode !== 'free' && hintsEnabled && <HintOverlay hint={hint} />}
          {mode !== 'free' && <AccessibleChecklist items={checklist} />}
          {mode === 'free' && <p className="lc-muted">No forced objective. Unsupported scientific models are still labelled honestly if you encounter them.</p>}
        </section>
        <section aria-label="Scoring">
          <h3>Scoring rubric</h3>
          {mode !== 'free' && <ScoreCard score={score} />}
          {mode === 'precision' && (
            <p className="lc-muted">
              Trials completed: {evaluation.trialsCompleted} of {evaluation.trialsRequired} required.
            </p>
          )}
          {mode === 'precision' && demoRuntime && evaluation.trialsCompleted < evaluation.trialsRequired && lastTrial?.endpoint && (
            <button type="button" onClick={() => demoRuntime.startNewTrial()}>
              Start repeat trial
            </button>
          )}
          {lastTrial?.endpoint && mode !== 'free' && <InterpretationForm trialId={lastTrial.trialId} />}
          {canSave && (
            <button type="button" className="lc-btn lc-btn--primary" onClick={() => void finishAttempt()}>
              Save this attempt
            </button>
          )}
        </section>
      </div>

      {mode !== 'free' && <NotebookView notebook={notebook} onExport={exportNotebookJson} />}

      {lastTrial && (
        <section aria-label="Replay">
          <h3>Replay last trial</h3>
          <ReplayView trial={lastTrial} />
        </section>
      )}

      <section aria-label="Compare saved attempts">
        <h3>Compare two saved attempts</h3>
        <CompareView comparison={comparison} />
      </section>

      <AttemptsPanel attempts={attempts} achievements={achievements} compareIds={compareIds} onToggleCompare={toggleCompare} onDelete={(id) => void deleteAttempt(id)} />

      <section aria-label="Export template">
        <button type="button" onClick={() => exportTemplate('Guided titration setup', 'Stand, clamp, burette and flask, ready to titrate.')}>
          Export this setup as a reusable template
        </button>
      </section>
    </div>
  );
}
