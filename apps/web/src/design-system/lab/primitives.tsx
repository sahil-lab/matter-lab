import { CircleAlert, CircleHelp, CircleSlash, Inbox, Info, LoaderCircle, TriangleAlert, WifiOff, X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { Button, cx } from '../../ui/kit';
import type { LabSurfaceAction, LabSurfaceStatus, LabTone } from './types';

export function LabButton({ className, ...props }: ComponentProps<typeof Button>) {
  return <Button className={cx('mlab-button', className)} {...props} />;
}

export function LabTag({ children, tone = 'neutral' }: { children: ReactNode; tone?: LabTone }) {
  return <span className="mlab-tag" data-tone={tone}>{children}</span>;
}

export function LabSection({ title, eyebrow, action, children }: { title?: string; eyebrow?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mlab-section">
      {(title || eyebrow || action) && (
        <div className="mlab-section__heading">
          <div>{eyebrow && <div className="mlab-eyebrow">{eyebrow}</div>}{title && <h3>{title}</h3>}</div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

const STATE_ICONS = { empty: Inbox, loading: LoaderCircle, warning: TriangleAlert, offline: WifiOff, error: CircleAlert, unsupported: CircleSlash };
const STATE_TITLES = { empty: 'Nothing here yet', loading: 'Working', warning: 'Check before continuing', offline: 'Offline', error: 'Something needs attention', unsupported: 'Not supported by this model' };

export interface LabStateNoticeProps {
  readonly status: LabSurfaceStatus;
  readonly title?: string;
  readonly children?: ReactNode;
  readonly action?: LabSurfaceAction;
  readonly compact?: boolean;
}

export function LabStateNotice({ status, title, children, action, compact = false }: LabStateNoticeProps) {
  const Icon = STATE_ICONS[status];
  return (
    <div
      className={cx('mlab-state', compact && 'mlab-state--compact')}
      data-state={status}
      role={status === 'error' ? 'alert' : 'status'}
      aria-live={status === 'error' ? 'assertive' : 'polite'}
      aria-busy={status === 'loading' || undefined}
    >
      <Icon className={status === 'loading' ? 'mlab-spin' : undefined} aria-hidden="true" />
      <div className="mlab-state__body">
        <strong>{title ?? STATE_TITLES[status]}</strong>
        {children && <div className="mlab-prose">{children}</div>}
        {action && <LabButton variant="outline" size="sm" disabled={action.disabled} onClick={action.onPress}>{action.label}</LabButton>}
      </div>
    </div>
  );
}

export interface LabJobProgressProps {
  readonly title: string;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unsupported';
  /** Fraction reported by the worker, or null for genuinely indeterminate work. */
  readonly progress?: number | null;
  readonly detail?: string;
  readonly onCancel?: () => void;
}

export function LabJobProgress({ title, status, progress, detail, onCancel }: LabJobProgressProps) {
  const active = status === 'queued' || status === 'running';
  const fraction = progress != null && Number.isFinite(progress) && progress >= 0 && progress <= 1 ? progress : undefined;
  return (
    <section className="mlab-job" aria-label={title} data-state={status}>
      <div className="mlab-row">
        {active ? <LoaderCircle className="mlab-spin" aria-hidden="true" /> : status === 'failed' ? <CircleAlert aria-hidden="true" /> : <Info aria-hidden="true" />}
        <strong>{title}</strong>
        <LabTag tone={status === 'failed' ? 'danger' : status === 'unsupported' ? 'warm' : 'neutral'}>{status}</LabTag>
        {active && onCancel && <LabButton icon size="sm" aria-label={`Cancel ${title}`} onClick={onCancel}><X /></LabButton>}
      </div>
      {active && <progress className="mlab-progress" aria-label={`${title} progress`} max={1} value={fraction} />}
      <p className="mlab-caption" role="status">{detail ?? (active ? 'The viewport remains available while this job runs.' : status === 'unsupported' ? 'No result was produced for these conditions.' : status === 'failed' ? 'No successful result was produced.' : status === 'cancelled' ? 'The calculation was cancelled.' : 'The calculation finished.')}</p>
    </section>
  );
}

export interface LabDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly size?: 'small' | 'medium' | 'large';
  readonly onClose: () => void;
}

export function LabDialog({ open, title, description, children, footer, size = 'medium', onClose }: LabDialogProps) {
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open || !ref.current) return;
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    return () => {
      dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <dialog ref={ref} className="mlab-dialog" data-size={size} aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined}
      onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <header className="mlab-dialog__header">
        <div><div className="mlab-eyebrow">MATTER LAB / instrument room</div><h2 id={`${id}-title`}>{title}</h2>{description && <p id={`${id}-description`}>{description}</p>}</div>
        <LabButton icon aria-label={`Close ${title}`} onClick={onClose}><X /></LabButton>
      </header>
      <div className="mlab-dialog__body">{children}</div>
      {footer && <footer className="mlab-dialog__footer">{footer}</footer>}
    </dialog>
  );
}

export function LabHelpHint({ children }: { children: ReactNode }) {
  return <p className="mlab-help"><CircleHelp aria-hidden="true" /><span>{children}</span></p>;
}
