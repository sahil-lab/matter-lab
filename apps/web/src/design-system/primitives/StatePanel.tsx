import { Ban, CircleAlert, Inbox, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Spinner } from './ProgressBar';

export type AstraStateKind = 'loading' | 'empty' | 'warning' | 'unsupported' | 'error';

const ICONS: Readonly<Record<Exclude<AstraStateKind, 'loading'>, typeof Inbox>> = {
  empty: Inbox,
  warning: TriangleAlert,
  unsupported: Ban,
  error: CircleAlert,
};

/**
 * The one component every lab surface uses to say "there is nothing real to show here right now",
 * instead of a silently blank panel or an invented number. Used for disconnected/empty data, slow
 * calculations, non-fatal warnings, scientifically unsupported configurations and hard errors.
 */
export function StatePanel({ kind, title, detail, action }: { kind: AstraStateKind; title: string; detail?: ReactNode; action?: ReactNode }) {
  const Icon = kind === 'loading' ? null : ICONS[kind];
  return (
    <div className="astra-state" data-kind={kind} role={kind === 'error' ? 'alert' : 'status'} data-testid={`astra-state-${kind}`}>
      {Icon ? <Icon className="astra-state__icon" aria-hidden /> : <Spinner className="astra-state__icon" />}
      <div className="astra-state__title">{title}</div>
      {detail && <div className="astra-state__detail">{detail}</div>}
      {action && <div className="astra-state__action">{action}</div>}
    </div>
  );
}
