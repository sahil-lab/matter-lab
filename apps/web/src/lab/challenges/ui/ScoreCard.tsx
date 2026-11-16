import type { ScoreBand, ScoreBreakdown } from '../scoring';
import { EvidenceTag, formatPercent01 } from './evidence';

const BAND_LABEL: Readonly<Record<ScoreBand, string>> = { novice: 'Novice', developing: 'Developing', proficient: 'Proficient', exemplary: 'Exemplary' };

/**
 * Renders a `ScoreBreakdown` exactly as computed — this component never adjusts, rounds away, or
 * recomputes anything from render state. The same score object always renders the same way.
 */
export function ScoreCard({ score }: { score: ScoreBreakdown | null }) {
  if (!score) return <p className="lc-muted">No score yet. Complete a trial to see the rubric.</p>;
  return (
    <div className="lc-score">
      <div className="lc-score__overall">
        <span className="lc-score__value">{formatPercent01(score.overall01)}</span>
        <span className="lc-score__band">{BAND_LABEL[score.band]}</span>
      </div>
      <ul className="lc-score__dims">
        {score.dimensions.map((d) => (
          <li key={d.id}>
            <div className="lc-score__dimhead">
              <span>{d.label}</span>
              <EvidenceTag level={d.evidence} />
            </div>
            <div className="lc-score__bar" role="meter" aria-valuenow={Math.round(d.score01 * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={d.label}>
              <span style={{ width: formatPercent01(d.score01) }} />
            </div>
            <p className="lc-score__detail">{d.detail}</p>
          </li>
        ))}
      </ul>
      <p className="lc-muted">
        Based on {score.basedOnEventCount} recorded event(s) across {score.basedOnTrialCount} trial(s). Deterministic: re-scoring the same saved log reproduces this exactly.
      </p>
    </div>
  );
}
