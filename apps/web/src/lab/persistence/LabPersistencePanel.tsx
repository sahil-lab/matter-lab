import { useEffect, useMemo, useRef, useState } from 'react';
import { saveDownload } from '../../services/science-client';
import type { Page } from '../../services/science-client';
import { Button, Note } from '../../ui/kit';
import '../../ui/backend/backend.css';
import { LabApiClient, importSceneDraft } from './client';
import { ScenePersistenceCoordinator } from './coordinator';
import type { PersistenceState } from './coordinator';
import type { DraftCache } from './drafts';
import type { ReagentDefinition, ReagentPage, RunEvent, RunResource, SceneDraft, SceneResource, SceneSummary, TemplateResource } from './types';

export interface LabPersistencePanelProps {
  readonly api: LabApiClient | null;
  readonly draft: SceneDraft;
  readonly confirmedRevision: number | null;
  readonly draftCache?: DraftCache;
  readonly onOpen: (resource: SceneResource) => void;
  readonly onSaved?: (resource: SceneResource) => void;
  readonly onImportDraft?: (draft: SceneDraft) => void;
  readonly onRun?: (run: RunResource) => void;
  readonly onChooseReagent?: (reagent: ReagentDefinition) => void;
}

const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNSUPPORTED']);

/** Controlled persistence UI: callbacks, never direct writes to Agent07's runtime or molecule store. */
export function LabPersistencePanel({ api, draft, confirmedRevision, draftCache, onOpen, onSaved, onImportDraft, onRun, onChooseReagent }: LabPersistencePanelProps) {
  const coordinator = useMemo(
    () => api ? new ScenePersistenceCoordinator(api, draft.scene.id, confirmedRevision, draftCache) : null,
    [api, draft.scene.id, confirmedRevision, draftCache],
  );
  const [state, setState] = useState<PersistenceState>({ status: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [scenes, setScenes] = useState<Page<SceneSummary> | null>(null);
  const [templates, setTemplates] = useState<Page<TemplateResource> | null>(null);
  const [reagents, setReagents] = useState<ReagentPage | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [run, setRun] = useState<RunResource | null>(null);
  const [progress, setProgress] = useState<RunEvent['status'] | null>(null);
  const operation = useRef<AbortController | null>(null);
  const runCallback = useRef(onRun);
  runCallback.current = onRun;

  useEffect(() => {
    setState(coordinator?.getState() ?? { status: 'idle' });
    return coordinator?.subscribe(setState);
  }, [coordinator]);
  useEffect(() => {
    setScenes(null); setTemplates(null); setReagents(null); setRun(null); setProgress(null); setError(null); setNotice(null);
    return () => operation.current?.abort();
  }, [api, draft.scene.id]);

  useEffect(() => {
    if (!api || !run || terminal.has(run.status)) return;
    const controller = new AbortController();
    const runId = run.runId;
    void (async () => {
      let after = 0;
      try {
        while (!controller.signal.aborted) {
          for await (const event of api.events(runId, { after, signal: controller.signal })) {
            after = event.sequence;
            if (controller.signal.aborted) return;
            setProgress(event.status);
            if (terminal.has(event.status)) {
              const completed = await api.getRun(runId, controller.signal);
              if (!controller.signal.aborted) { setRun(completed); runCallback.current?.(completed); }
              return;
            }
          }
          if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Progress disconnected. The last confirmed run state is retained.');
      }
    })();
    return () => controller.abort();
  }, [api, run?.runId, run?.status]);

  async function perform(action: (signal: AbortSignal) => Promise<void>) {
    operation.current?.abort();
    const current = new AbortController();
    operation.current = current;
    setBusy(true); setError(null); setNotice(null);
    try { await action(current.signal); }
    catch (cause) { if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : 'The service did not confirm this operation.'); }
    finally { if (operation.current === current) setBusy(false); }
  }

  function browse(offset = 0) {
    if (api) void perform(async (signal) => {
      const page = await api.listScenes({ q: query.trim(), offset, limit: 20 }, signal);
      if (!signal.aborted) setScenes(page);
    });
  }

  function browseTemplates(offset = 0) {
    if (api) void perform(async (signal) => {
      const page = await api.templates('', offset, signal);
      if (!signal.aborted) setTemplates(page);
    });
  }

  const revision = coordinator?.getConfirmedRevision() ?? confirmedRevision;
  return <section className="ml-backend-panel" aria-label="Laboratory persistence">
    <header><h2>Laboratory notebook</h2><p>Remote scenes and immutable replay results are stored in PostgreSQL. Exports use the last saved scene, not unsaved edits.</p></header>
    {!api && <Note severity="warning">Backend not connected. Open Connected science settings first. A local draft is not a remote save.</Note>}
    {error && <div role="alert"><Note severity="error">{error}</Note></div>}
    {notice && <div role="status"><Note severity="info">{notice}</Note></div>}
    {state.status === 'local-draft' && <div role="status"><Note severity="warning">{state.reason}</Note></div>}
    {state.status === 'conflict' && <div role="alert"><Note severity="warning">{state.reason} Your draft has not been overwritten. Download it before reopening a remote scene.</Note></div>}
    {state.status === 'saved' && <p role="status">Remote revision {state.revision} confirmed. New edits require another save.</p>}
    <div className="ml-backend-tabs">
      <Button variant="primary" disabled={!coordinator || busy} onClick={() => { if (coordinator) void perform(async (signal) => {
        const resource = await coordinator.save(draft, signal);
        if (!signal.aborted) { onSaved?.(resource); setNotice(`PostgreSQL confirmed revision ${resource.scene.revision}.`); }
      }); }}>{state.status === 'saving' ? 'Saving…' : 'Save remotely'}</Button>
      <Button onClick={() => saveDownload({ blob: new Blob([JSON.stringify({ format: 'matterlab-local-draft', schemaVersion: 1, remoteSave: 'UNCONFIRMED', ...draft })], { type: 'application/json' }), filename: `lab-draft-${draft.scene.id}.json` })}>Download local draft</Button>
      <Button disabled={!api || revision === null || busy} onClick={() => { if (api) void perform(async (signal) => { const file = await api.exportScene(draft.scene.id, 'json', undefined, signal); if (!signal.aborted) saveDownload(file); }); }}>Export saved JSON</Button>
      <Button disabled={!api || revision === null || busy} onClick={() => { if (api) void perform(async (signal) => { const file = await api.exportScene(draft.scene.id, 'xlsx', undefined, signal); if (!signal.aborted) saveDownload(file); }); }}>Export saved Excel</Button>
    </div>
    {onImportDraft && <label className="ml-backend-file">Open JSON as an unverified local draft<input type="file" accept=".json,application/json" disabled={busy} onChange={(event) => {
      const file = event.target.files?.[0];
      if (file) void perform(async (signal) => {
        if (file.size > 8 * 1024 * 1024) throw new Error('JSON draft limit: 8 MiB.');
        const imported = importSceneDraft(await file.text());
        if (!signal.aborted) onImportDraft(imported);
      });
      event.target.value = '';
    }} /></label>}
    <form className="ml-backend-search" onSubmit={(event) => { event.preventDefault(); browse(); }}>
      <label>Find my remote scenes<input className="ml-input" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <Button type="submit" disabled={!api || busy}>Browse saved scenes</Button>
    </form>
    {scenes && <><p>{scenes.total} owned scenes</p><ul className="ml-backend-engines">{scenes.items.map((scene) => <li key={scene.id}>
      <strong>{scene.title} · revision {scene.revision}</strong>
      <Button disabled={busy || !api} onClick={() => { if (api) void perform(async (signal) => {
        const resource = await api.getScene(scene.id, signal);
        if (!signal.aborted) onOpen(resource);
      }); }}>Reopen saved (replace current draft)</Button>
      <Button disabled={busy || !api} onClick={() => { if (api) void perform(async (signal) => {
        const resource = await api.duplicateScene(scene.id, undefined, undefined, signal);
        if (!signal.aborted) onOpen(resource);
      }); }}>Duplicate saved scene</Button>
    </li>)}</ul><div className="ml-backend-tabs">
      <Button disabled={busy || scenes.offset === 0} onClick={() => browse(Math.max(0, scenes.offset - scenes.limit))}>Previous scenes</Button>
      <Button disabled={busy || scenes.offset + scenes.items.length >= scenes.total} onClick={() => browse(scenes.offset + scenes.limit)}>Next scenes</Button>
    </div></>}
    <section><h3>Independent server replay</h3><p className="ml-backend-muted">Replays the saved checkpoint from its immutable initial state. It does not reapply prior actions to the already-mutated current scene.</p>
      <div className="ml-backend-tabs">
        <Button disabled={!api || revision === null || busy || (run !== null && !terminal.has(run.status))} onClick={() => { if (api && revision !== null) void perform(async (signal) => {
          const started = await api.replaySavedScene(draft.scene.id, revision, undefined, signal);
          if (!signal.aborted) { setRun(started); setProgress(started.status); onRun?.(started); }
        }); }}>Replay saved scene</Button>
        {run && !terminal.has(run.status) && <Button disabled={!api || busy} onClick={() => { if (api) void perform(async (signal) => {
          const cancelled = await api.cancelRun(run.runId, signal);
          if (!signal.aborted) { setRun(cancelled); setProgress(cancelled.cancelRequested && !terminal.has(cancelled.status) ? 'CANCELLING' : cancelled.status); onRun?.(cancelled); }
        }); }}>Cancel server replay</Button>}
      </div>
      {run && <div role="status"><p>{progress ?? run.status} · {run.runId}</p>{run.failureCode && <Note severity="warning">{run.failureCode}: {run.result?.warnings.join(' ') || 'No successful scientific result was recorded.'}</Note>}
        {(run.result?.status === 'FAILED' || run.result?.status === 'UNSUPPORTED') && <Note severity="warning">{run.result.error.detail}</Note>}
        <p className="ml-backend-muted">Input SHA-256: {run.inputHash}</p></div>}
      {run && <div className="ml-backend-tabs">{(['json', 'xlsx'] as const).map((format) => <Button key={format} disabled={!api || busy} onClick={() => {
        if (api) void perform(async (signal) => { const download = await api.exportScene(run.sceneId, format, run.runId, signal); if (!signal.aborted) saveDownload(download); });
      }}>Export this run {format.toUpperCase()}</Button>)}</div>}
    </section>
    <section><h3>Reusable assemblies</h3><label className="ml-backend-file">Assembly name<input className="ml-input" value={templateName} onChange={(event) => setTemplateName(event.target.value)} /></label>
      <div className="ml-backend-tabs">
        <Button disabled={!api || revision === null || !templateName.trim() || busy} onClick={() => { if (api && revision !== null) void perform(async (signal) => {
          const template = await api.saveTemplate(draft.scene.id, revision, templateName.trim(), 'ASSEMBLY');
          if (!signal.aborted) setNotice(`Saved reusable assembly ${template.title}.`);
        }); }}>Save saved scene as assembly</Button>
        <Button disabled={!api || busy} onClick={() => browseTemplates()}>Browse my templates</Button>
      </div>
      {templates && <ul className="ml-backend-engines">{templates.items.map((template) => <li key={template.id}><strong>{template.title} · {template.kind}</strong>
        <Button disabled={!api || busy} onClick={() => { if (api) void perform(async (signal) => {
          const created = await api.instantiateTemplate(template.id, undefined, undefined, signal);
          if (!signal.aborted) onOpen(created);
        }); }}>Open independent copy</Button>
      </li>)}</ul>}
      {templates && <div className="ml-backend-tabs">
        <Button disabled={busy || templates.offset === 0} onClick={() => browseTemplates(Math.max(0, templates.offset - templates.limit))}>Previous templates</Button>
        <Button disabled={busy || templates.offset + templates.items.length >= templates.total} onClick={() => browseTemplates(templates.offset + templates.limit)}>Next templates</Button>
      </div>}
    </section>
    <section><h3>Curated virtual reagents</h3><p className="ml-backend-muted">These entries come from the same versioned chemistry package as the runtime. They are not a complete compound catalogue or physical laboratory instructions.</p>
      <Button disabled={!api || busy} onClick={() => { if (api) void perform(async (signal) => {
        const page = await api.reagents('', 0, signal); if (!signal.aborted) setReagents(page);
      }); }}>Read reagent catalogue</Button>
      {reagents && <ul className="ml-backend-engines">{reagents.items.map((reagent) => <li key={reagent.id}>
        <strong>{reagent.label} · {reagent.formula} ({reagent.phase})</strong>
        <span>Model {reagent.modelId} · maximum {reagent.maximumConcentrationMolL} mol/L · {reagent.temperatureK} K</span>
        <small>{reagent.sourceIds.join(', ')}</small>
        {onChooseReagent && <Button disabled={busy} onClick={() => onChooseReagent(reagent)}>Choose virtual reagent</Button>}
      </li>)}</ul>}
    </section>
  </section>;
}
