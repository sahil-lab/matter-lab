import type { ReactNode } from 'react';
import type { AstraEvidence } from '../tokens';
import { ASTRA_EVIDENCE_LEVELS } from '../tokens';
import { cx } from './cx';

export type AstraStatusTone = 'neutral' | 'ok' | 'warning' | 'danger' | 'cool' | 'warm';

/** A small status pill: a dot plus a label, used for connection/run/job states. */
export function StatusBadge({ tone = 'neutral', children }: { tone?: AstraStatusTone; children: ReactNode }) {
  return (
    <span className="astra-badge" data-tone={tone}>
      <i className="astra-badge__dot" aria-hidden />
      {children}
    </span>
  );
}

/**
 * States how a scientific value was obtained, using the shared contract's five-level vocabulary
 * (`REFERENCE_MEASURED` / `MODEL_CALCULATED` / `ILLUSTRATIVE` / `UNVERIFIED` / `UNSUPPORTED`).
 * Every number the titration HUD and explanation panel show must carry one of these.
 */
export function EvidenceBadge({ level, tipPos = 'top-end' }: { level: AstraEvidence; tipPos?: 'top' | 'top-end' | 'bottom' | 'bottom-end' }) {
  const meta = ASTRA_EVIDENCE_LEVELS[level];
  return (
    <span
      className={cx('astra-evidence')}
      style={{ ['--astra-evidence-color' as string]: `var(${meta.colorVar})` }}
      data-level={level}
      data-astra-tip={meta.description}
      data-astra-tip-pos={tipPos}
      tabIndex={0}
    >
      {meta.label}
    </span>
  );
}
