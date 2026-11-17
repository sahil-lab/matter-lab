import { Activity, CircleAlert, CircleCheck, CircleSlash, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button, IconButton, ProgressBar, useDismiss } from '../../design-system';
import type { AstraJobPreview } from './store';
import { astraLab, clearFinishedAstraJobs, useAstraLab } from './store';

const TONE_COLOR: Readonly<Record<'cool' | 'ok' | 'danger' | 'neutral' | 'warm', string>> = {
  cool: 'var(--astra-cool-400)',
  ok: 'var(--astra-ok)',
  danger: 'var(--astra-danger)',
  neutral: 'var(--astra-text-2)',
  warm: 'var(--astra-warm-400)',
};

const STATUS_META: Readonly<Record<AstraJobPreview['status'], { label: string; icon: typeof Activity; tone: keyof typeof TONE_COLOR }>> = {
  queued: { label: 'Waiting', icon: LoaderCircle, tone: 'neutral' },
  running: { label: 'Running', icon: LoaderCircle, tone: 'cool' },
  succeeded: { label: 'Finished', icon: CircleCheck, tone: 'ok' },
  failed: { label: 'Failed', icon: CircleAlert, tone: 'danger' },
  cancelled: { label: 'Cancelled', icon: CircleSlash, tone: 'neutral' },
  unsupported: { label: 'Not supported', icon: TriangleAlert, tone: 'warm' },
};

function isRunning(job: AstraJobPreview): boolean {
  return job.status === 'queued' || job.status === 'running';
}

export function JobRow({ job }: { job: AstraJobPreview }) {
  const meta = STATUS_META[job.status];
  const Icon = meta.icon;
  const active = isRunning(job);
  return (
    <div className="astra-job" data-status={job.status} data-testid="astra-job">
      <Icon className={active ? 'astra-spin' : undefined} style={{ color: TONE_COLOR[meta.tone] }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="astra-job__title">{job.title}</div>
        {job.detail && <div className="astra-job__detail">{job.detail}</div>}
        <div className="astra-job__detail" style={{ color: TONE_COLOR[meta.tone] }}>
          {meta.label}
        </div>
        {active && (
          <div style={{ marginTop: 4 }}>
            <ProgressBar progress={job.progress} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Long-running job progress, styled like the brief's requirement for "status and long-running job
 * progress". Backed by the shell's own demo job queue (`store.ts`'s `enqueueDemoJob`) until Agent 06
 * (solver runs) and Agent 09 (export/persistence jobs) expose real asynchronous work to surface here.
 */
export function JobProgress() {
  const jobs = useAstraLab((s) => s.jobs);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss<HTMLDivElement>(open, close);
  const running = jobs.filter(isRunning).length;

  useEffect(() => {
    if (!open) return;
    // Re-render while a job is active so elapsed/progress stay current without a global ticker.
    const timer = window.setInterval(() => astraLab.set((s) => ({ ...s })), 300);
    return () => window.clearInterval(timer);
  }, [open]);

  if (jobs.length === 0) return null;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <Button tip={running > 0 ? `${running} job${running === 1 ? '' : 's'} running` : 'Jobs'} tipPos="bottom" active={open} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} data-testid="astra-jobs-trigger">
        {running > 0 ? <LoaderCircle className="astra-spin" style={{ color: TONE_COLOR.cool }} /> : <Activity />}
        {running > 0 && <span className="astra-mono">{running}</span>}
      </Button>
      {open && (
        <div className="astra-menu" style={{ top: 'calc(100% + 8px)', left: 0, width: 320 }} data-testid="astra-jobs-list">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span className="astra-eyebrow">Jobs</span>
            {jobs.some((j) => !isRunning(j)) && (
              <Button size="sm" onClick={clearFinishedAstraJobs}>
                Clear finished
              </Button>
            )}
          </div>
          <div className="astra-list astra-scroll" style={{ maxHeight: 320 }}>
            {jobs.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ToastStack() {
  const toasts = useAstraLab((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="astra-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="astra-panel astra-toast" data-kind={toast.kind} data-testid="astra-toast">
          <span>{toast.title}</span>
          <IconButton size="sm" aria-label="Dismiss" onClick={() => astraLab.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== toast.id) }))}>
            <X />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
