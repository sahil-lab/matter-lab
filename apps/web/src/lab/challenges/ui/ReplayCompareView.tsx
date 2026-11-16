import { useState } from 'react';
import type { TrialRecord } from '../goals';
import { buildReplayTimeline } from '../replay';
import type { AttemptComparison } from '../replay';
import { formatMl } from './evidence';

/** Scrubs through one trial's own saved event log. Built from the log, never from render/animation state. */
export function ReplayView({ trial }: { trial: TrialRecord }) {
  const timeline = buildReplayTimeline(trial);
  const [index, setIndex] = useState(Math.max(0, timeline.steps.length - 1));
  const step = timeline.steps[Math.min(index, timeline.steps.length - 1)];
  return (
    <div className="lc-replay">
      <label className="lc-replay__scrub">
        Replay position ({index + 1} of {timeline.steps.length})
        <input
          type="range"
          min={0}
          max={Math.max(0, timeline.steps.length - 1)}
          value={index}
          onChange={(e) => setIndex(Number(e.target.value))}
          aria-label={`Replay position, step ${index + 1} of ${timeline.steps.length}`}
        />
      </label>
      {step && (
        <div className="lc-replay__frame" aria-live="polite">
          <p>{step.description}</p>
          <p className="lc-muted">
            Delivered so far: {formatMl(step.cumulativeVolumeL)} mL{step.latestPh !== null ? `, pH ${step.latestPh.toFixed(2)}` : ''}
          </p>
        </div>
      )}
    </div>
  );
}

/** Side-by-side comparison of two saved, already-scored attempts. */
export function CompareView({ comparison }: { comparison: AttemptComparison | null }) {
  if (!comparison) return <p className="lc-muted">Select two saved attempts below to compare them.</p>;
  return (
    <table className="lc-table">
      <thead>
        <tr>
          <th>Metric</th>
          <th>{comparison.a.label}</th>
          <th>{comparison.b.label}</th>
        </tr>
      </thead>
      <tbody>
        {comparison.metrics.map((m) => (
          <tr key={m.id}>
            <td>{m.label}</td>
            <td data-better={m.betterSide === 'a'}>
              {m.a !== null ? `${m.a.toFixed(1)} ${m.unit}` : '\u2014'}
              {m.betterSide === 'a' ? ' (better)' : ''}
            </td>
            <td data-better={m.betterSide === 'b'}>
              {m.b !== null ? `${m.b.toFixed(1)} ${m.unit}` : '\u2014'}
              {m.betterSide === 'b' ? ' (better)' : ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
