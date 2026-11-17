import { validateScene } from '@matterlab/core';
import {
  Activity,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleSlash,
  Download,
  FileInput,
  FilePlus2,
  FlaskConical,
  FolderOpen,
  Hexagon,
  Library,
  LoaderCircle,
  Menu,
  PanelRightClose,
  PanelRightOpen,
  Redo2,
  Save,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  Undo2,
  Vault,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { getDeviceInfo } from '../render/MatterCanvas';
import { QUALITY } from '../render/quality';
import { cancelJob, clearFinishedJobs, isRunning, useJobs } from '../science/jobs';
import type { LabJob } from '../science/jobs';
import { clearSelection, enterWorkspace, newDocument, redo, undo } from '../state/actions';
import { pickFile } from '../state/commands';
import { saveCurrentProject } from '../state/persistence';
import { lab, useLab } from '../state/store';
import type { EditMode, QualityId, Workspace } from '../state/store';
import { Button, IconButton, Segmented, cx, useDismiss } from './kit';
import { useSettledScene } from '../state/useSettledScene';

function BrandMark() {
  return (
    <svg className="ml-brand__mark" viewBox="0 0 32 32" aria-hidden>
      <g fill="none" stroke="var(--accent)" strokeWidth="1.5">
        <ellipse cx="16" cy="16" rx="12.5" ry="5" />
        <ellipse cx="16" cy="16" rx="12.5" ry="5" transform="rotate(60 16 16)" />
        <ellipse cx="16" cy="16" rx="12.5" ry="5" transform="rotate(120 16 16)" />
      </g>
      <circle cx="16" cy="16" r="2.9" fill="var(--energy)" />
    </svg>
  );
}

function FileMenu() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const run = (action: () => void) => () => {
    close();
    action();
  };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <IconButton tip="File" tipPos="bottom" active={open} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <Menu />
      </IconButton>
      {open && (
        <div className="ml-menu" role="menu" style={{ top: 'calc(100% + 8px)', left: 0 }}>
          <button className="ml-menu__item" role="menuitem" onClick={run(newDocument)}>
            <FilePlus2 /> New project
          </button>
          <button className="ml-menu__item" role="menuitem" onClick={run(() => lab.set({ dialog: 'library' }))}>
            <Library /> Library and examples <span className="ml-kbd">Ctrl O</span>
          </button>
          <div className="ml-menu__sep" />
          <button className="ml-menu__item" role="menuitem" onClick={run(() => pickFile('replace'))}>
            <FolderOpen /> Open file…
          </button>
          <button className="ml-menu__item" role="menuitem" onClick={run(() => pickFile('insert'))}>
            <FileInput /> Insert from file…
          </button>
          <div className="ml-menu__sep" />
          <button className="ml-menu__item" role="menuitem" onClick={run(() => void saveCurrentProject())}>
            <Save /> Save to library <span className="ml-kbd">Ctrl S</span>
          </button>
          <button className="ml-menu__item" role="menuitem" onClick={run(() => lab.set({ dialog: 'export' }))}>
            <Download /> Export…
          </button>
        </div>
      )}
    </div>
  );
}

function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const quality = useLab((s) => s.quality);
  const ambientMotion = useLab((s) => s.ambientMotion);
  const showPerf = useLab((s) => s.showPerf);
  const device = open ? getDeviceInfo() : null;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <IconButton tip="Display settings" tipPos="bottom" active={open} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <SlidersHorizontal />
      </IconButton>
      {open && (
        <div className="ml-menu" style={{ top: 'calc(100% + 8px)', right: 0, width: 318, padding: 12 }}>
          <div className="ml-label" style={{ marginBottom: 7 }}>
            Render quality
          </div>
          <Segmented<QualityId>
            label="Render quality"
            fill
            value={quality}
            onChange={(value) => lab.set({ quality: value })}
            options={(Object.keys(QUALITY) as QualityId[]).map((id) => ({ value: id, label: QUALITY[id].label }))}
          />
          <p style={{ margin: '8px 0 12px', color: 'var(--text-2)', fontSize: 12, lineHeight: 1.45 }}>{QUALITY[quality].description}</p>
          <div className="ml-menu__sep" style={{ margin: '0 -4px 6px' }} />
          <button className="ml-menu__item" role="menuitemcheckbox" aria-checked={ambientMotion} onClick={() => lab.set({ ambientMotion: !ambientMotion })}>
            <span style={{ width: 16, color: 'var(--accent)' }}>{ambientMotion ? '✓' : ''}</span> Ambient motion
          </button>
          <button className="ml-menu__item" role="menuitemcheckbox" aria-checked={showPerf} onClick={() => lab.set({ showPerf: !showPerf })}>
            <span style={{ width: 16, color: 'var(--accent)' }}>{showPerf ? '✓' : ''}</span> Performance monitor
          </button>
          {device && (
            <p className="ml-mono" style={{ margin: '10px 2px 0', color: 'var(--text-3)', fontSize: 10.5, lineHeight: 1.5, overflowWrap: 'anywhere', userSelect: 'text' }}>
              {device.renderer}
              <br />
              WebGL 2 renderer{device.webgpuAvailable ? ' · WebGPU available in this browser but not used' : ''}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ValidationChip() {
  const current = useLab((s) => s.scene);
  // For a large structure the check runs once editing pauses, not inside every edit.
  const { scene, pending } = useSettledScene(current);
  if (current.atoms.size === 0) return null;
  const open = () => {
    clearSelection();
    lab.set({ inspectorOpen: true, inspectorTab: 'inspect' });
  };
  if (pending) {
    return (
      <button type="button" className="ml-status-chip" data-state="pending" data-tip="Rule-based structure checks, running now that editing has paused." data-tip-pos="bottom" data-testid="validation-chip" onClick={open}>
        <LoaderCircle className="ml-spin" />
        <span>Checking…</span>
      </button>
    );
  }
  const report = validateScene(scene);
  const state = report.errors > 0 ? 'error' : report.warnings > 0 ? 'warning' : 'ok';
  const Icon = state === 'error' ? CircleAlert : state === 'warning' ? TriangleAlert : CircleCheck;
  const text =
    state === 'error'
      ? `${report.errors} error${report.errors === 1 ? '' : 's'}`
      : state === 'warning'
        ? `${report.warnings} warning${report.warnings === 1 ? '' : 's'}`
        : 'Structure valid';
  return (
    <button type="button" className="ml-status-chip" data-state={state} data-tip="Rule-based structure checks. Click for details." data-tip-pos="bottom" data-testid="validation-chip" onClick={open}>
      <Icon />
      <span>{text}</span>
    </button>
  );
}

function ProjectName() {
  const name = useLab((s) => s.projectName);
  const dirty = useLab((s) => s.revision !== s.savedRevision);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  return (
    <div style={{ display: 'flex', alignItems: 'center', paddingRight: 4 }}>
      <input
        className="ml-docname"
        aria-label="Project name"
        value={draft}
        spellCheck={false}
        size={Math.max(8, Math.min(26, draft.length + 1))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim() || 'Untitled';
          setDraft(next);
          if (next !== name) lab.set({ projectName: next });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Escape') {
            if (e.key === 'Escape') setDraft(name);
            e.currentTarget.blur();
            e.stopPropagation();
          }
        }}
      />
      {dirty && <span className="ml-dirty" data-tip="Unsaved changes" data-tip-pos="bottom" />}
    </div>
  );
}

const JOB_STATUS: Readonly<Record<LabJob['status'], { label: string; icon: typeof Activity; tone: string }>> = {
  queued: { label: 'Waiting', icon: LoaderCircle, tone: 'var(--text-2)' },
  running: { label: 'Running', icon: LoaderCircle, tone: 'var(--accent)' },
  succeeded: { label: 'Finished', icon: CircleCheck, tone: 'var(--ok)' },
  failed: { label: 'Failed', icon: CircleAlert, tone: 'var(--danger)' },
  cancelled: { label: 'Cancelled', icon: CircleSlash, tone: 'var(--text-2)' },
  unsupported: { label: 'Not supported', icon: TriangleAlert, tone: 'var(--energy)' },
};

function seconds(job: LabJob, now: number): string {
  const elapsed = ((job.finishedAt ?? now) - job.startedAt) / 1000;
  return elapsed < 10 ? `${elapsed.toFixed(1)} s` : `${Math.round(elapsed)} s`;
}

function JobRow({ job, now }: { job: LabJob; now: number }) {
  const status = JOB_STATUS[job.status];
  const Icon = status.icon;
  const active = isRunning(job);
  return (
    <div className="ml-job" data-status={job.status} data-testid="job">
      <Icon className={active ? 'ml-spin' : undefined} style={{ color: status.tone }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="ml-job__title">{job.title}</div>
        {job.detail && <div className="ml-job__detail">{job.detail}</div>}
        <div className="ml-job__detail">
          <span style={{ color: status.tone }}>{status.label}</span>
          {active && job.stage ? ` · ${job.stage}` : ''} · {seconds(job, now)}
        </div>
        {active && (
          <div className="ml-progress" data-indeterminate={job.progress === null}>
            <i style={job.progress === null ? undefined : { width: `${Math.round(job.progress * 100)}%` }} />
          </div>
        )}
        {job.message && <div className="ml-job__detail" style={{ color: job.status === 'failed' ? 'var(--danger)' : 'var(--text-2)' }}>{job.message}</div>}
      </div>
      {active && (
        <IconButton size="sm" variant="danger" tip="Cancel this calculation" tipPos="top-end" onClick={() => cancelJob(job.id)}>
          <X />
        </IconButton>
      )}
    </div>
  );
}

/** Calculations in progress and their recent outcomes. Appears once anything has been computed. */
function JobsIndicator() {
  const jobs = useJobs((s) => s.jobs);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const running = jobs.filter(isRunning).length;

  useEffect(() => {
    if (running === 0 && !open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [running, open]);

  if (jobs.length === 0) return null;
  return (
    <>
      <div ref={ref} style={{ position: 'relative' }}>
        <Button
          tip={running > 0 ? `${running} calculation${running === 1 ? '' : 's'} running` : 'Calculations'}
          tipPos="bottom"
          active={open}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid="jobs"
          style={{ gap: 6, padding: '0 8px' }}
        >
          {running > 0 ? <LoaderCircle className="ml-spin" style={{ color: 'var(--accent)' }} /> : <Activity />}
          {running > 0 && <span className="ml-mono">{running}</span>}
        </Button>
        {open && (
          <div className="ml-menu" style={{ top: 'calc(100% + 8px)', right: 0, width: 344, padding: 10 }} data-testid="jobs-list">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span className="ml-label">Calculations</span>
              {jobs.some((job) => !isRunning(job)) && (
                <Button size="sm" onClick={clearFinishedJobs}>
                  Clear finished
                </Button>
              )}
            </div>
            <div className="ml-list ml-scroll" style={{ maxHeight: 360 }}>
              {jobs.map((job) => (
                <JobRow key={job.id} job={job} now={now} />
              ))}
            </div>
            <p className="ml-empty" style={{ marginTop: 8 }}>
              Calculations run in background threads, so the view and the editor stay responsive. Cancelling stops one immediately.
            </p>
          </div>
        )}
      </div>
      <div className="ml-sep" />
    </>
  );
}

const WORKSPACES: ReadonlyArray<{ id: Workspace; label: string; tip: string; icon: typeof Hexagon }> = [
  { id: 'architect', label: 'Architect', tip: 'Build and study atoms and molecules', icon: Hexagon },
  { id: 'reactions', label: 'Reactions', tip: 'Reaction laboratory: balance, thermodynamics and kinetics', icon: FlaskConical },
  { id: 'vault', label: 'Vault', tip: 'Discovery Vault: candidates for investigation, with their searches and evidence', icon: Vault },
];

function WorkspaceSwitch() {
  const workspace = useLab((s) => s.workspace);
  return (
    <Segmented<Workspace>
      label="Workspace"
      accent
      tipPos="bottom"
      value={workspace}
      onChange={enterWorkspace}
      options={WORKSPACES.map(({ id, label, tip, icon: Icon }) => ({
        value: id,
        tip,
        ariaLabel: label,
        label: (
          <>
            <Icon />
            <span className="ml-hide-narrow">{label}</span>
          </>
        ),
      }))}
    />
  );
}

export function TopBar({ children }: { children?: ReactNode }) {
  const canUndo = useLab((s) => s.history.past.length > 0);
  const canRedo = useLab((s) => s.history.future.length > 0);
  const undoLabel = useLab((s) => s.history.past[s.history.past.length - 1]?.label);
  const redoLabel = useLab((s) => s.history.future[s.history.future.length - 1]?.label);
  const editMode = useLab((s) => s.editMode);
  const inspectorOpen = useLab((s) => s.inspectorOpen);
  const architect = useLab((s) => s.workspace === 'architect');

  return (
    <div className="ml-top">
      <div className="ml-panel ml-bar">
        <div className="ml-brand">
          <BrandMark />
          <span className="ml-brand__name">
            MATTER <span>LAB</span>
          </span>
        </div>
        <div className="ml-sep" />
        <WorkspaceSwitch />
        <div className="ml-sep" />
        <Button
          tip="Open the Astra 3D laboratory — an in-progress, separately built expansion"
          tipPos="bottom"
          onClick={() => window.location.assign('/lab')}
          data-testid="open-astra-lab"
        >
          <Sparkles /> <span className="ml-hide-narrow">Astra lab</span>
        </Button>
        {architect && (
          <>
            <div className="ml-sep" />
            <FileMenu />
            <ProjectName />
          </>
        )}
      </div>

      <div className="ml-top__center">{children}</div>

      <div className="ml-panel ml-bar">
        {architect && (
          <>
            <IconButton tip={canUndo ? `Undo ${undoLabel?.toLowerCase() ?? ''}` : 'Nothing to undo'} tipPos="bottom" disabled={!canUndo} onClick={undo} data-testid="undo">
              <Undo2 />
            </IconButton>
            <IconButton tip={canRedo ? `Redo ${redoLabel?.toLowerCase() ?? ''}` : 'Nothing to redo'} tipPos="bottom" disabled={!canRedo} onClick={redo} data-testid="redo">
              <Redo2 />
            </IconButton>
            <div className="ml-sep" />
            <span className={cx('ml-hide-narrow')} style={{ display: 'flex' }}>
              <Segmented<EditMode>
                label="Editing mode"
                accent
                tipPos="bottom"
                value={editMode}
                onChange={(value) => lab.set({ editMode: value })}
                options={[
                  { value: 'creative', label: 'Creative', tip: 'Creative editing: build freely; caveats stay in the inspector' },
                  { value: 'physics', label: 'Physics', tip: 'Physics evaluation: every structural problem is flagged in the view' },
                ]}
              />
            </span>
            <ValidationChip />
            <div className="ml-sep" />
          </>
        )}
        <JobsIndicator />
        <SettingsMenu />
        <IconButton tip="Keyboard shortcuts" tipPos="bottom" onClick={() => lab.set({ dialog: 'shortcuts' })}>
          <CircleHelp />
        </IconButton>
        <IconButton
          tip={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
          tipPos="bottom-end"
          active={inspectorOpen}
          onClick={() => lab.set({ inspectorOpen: !inspectorOpen })}
          data-testid="toggle-inspector"
        >
          {inspectorOpen ? <PanelRightClose /> : <PanelRightOpen />}
        </IconButton>
      </div>
    </div>
  );
}
