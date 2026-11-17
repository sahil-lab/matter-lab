import { cx } from './cx';

/** A determinate (`progress` 0–1) or indeterminate (`progress` null) bar for long-running jobs. */
export function ProgressBar({ progress, tone = 'cool' }: { progress: number | null; tone?: 'cool' | 'warm' | 'ok' }) {
  return (
    <div className="astra-progress" data-tone={tone} data-indeterminate={progress === null} role="progressbar" aria-valuenow={progress === null ? undefined : Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
      <i style={progress === null ? undefined : { width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%` }} />
    </div>
  );
}

/** A compact dot-sequence spinner alternative for very small spaces (e.g. inline next to a label). */
export function Spinner({ className }: { className?: string }) {
  return <span className={cx('astra-spinner', className)} role="status" aria-label="Loading" />;
}
