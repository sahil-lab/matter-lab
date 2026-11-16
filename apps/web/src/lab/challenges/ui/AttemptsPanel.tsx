import type { Achievement, ChallengeAttemptSummary } from '../persistence';
import { formatPercent01 } from './evidence';

export function AttemptsPanel({
  attempts,
  achievements,
  compareIds,
  onToggleCompare,
  onDelete,
}: {
  attempts: readonly ChallengeAttemptSummary[];
  achievements: readonly Achievement[];
  compareIds: readonly string[];
  onToggleCompare: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="lc-attempts">
      <section>
        <h4>Achievements</h4>
        <ul className="lc-achievements">
          {achievements.map((a) => (
            <li key={a.id} data-earned={a.earned}>
              <strong>{a.title}</strong>
              <span>{a.description}</span>
              <span className="lc-achievements__status">{a.earned ? 'Earned' : 'Not yet'}</span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h4>Saved attempts</h4>
        {attempts.length === 0 && <p className="lc-muted">No attempts saved yet.</p>}
        <ul className="lc-attemptlist">
          {attempts.map((a) => (
            <li key={a.id}>
              <label>
                <input type="checkbox" checked={compareIds.includes(a.id)} onChange={() => onToggleCompare(a.id)} aria-label={`Select "${a.objectiveTitle}" (saved ${a.savedAt}) for comparison`} />
                {a.objectiveTitle} {'\u2014'} {formatPercent01(a.overallScore01)} ({a.band}), {a.trialCount} trial(s)
              </label>
              <button type="button" onClick={() => onDelete(a.id)} aria-label={`Delete attempt "${a.objectiveTitle}" saved ${a.savedAt}`}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
