import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Euler, Quaternion } from 'three';
import type { ApparatusDefinition, ApparatusInstance, Connection, SocketEndpoint } from '@matterlab/contracts/lab';
import type { LabEditorController } from './LabEditorController';
import { useLabEditorState, useLabRuntimeSelector } from './hooks';
import { EDITOR_SHORTCUTS, handleEditorShortcut } from './shortcuts';
import { socketCandidate } from './sockets';
import type { EditorMode } from './types';
import './editor.css';

export interface LabEditorControlsProps { readonly editor: LabEditorController }
export interface LabEditorInspectorProps extends LabEditorControlsProps {
  /** Science-owned solution preparation UI; this module never computes reagent inventories. */
  readonly preparationControls?: ReactNode;
}
const value = (form: HTMLFormElement, name: string) => new FormData(form).get(name)?.toString() ?? '';
const numeric = (form: HTMLFormElement, name: string) => Number(value(form, name));
const endpointValue = (endpoint: SocketEndpoint) => JSON.stringify(endpoint);
function endpointFrom(value: string): SocketEndpoint | null {
  try {
    const parsed = JSON.parse(value) as Partial<SocketEndpoint>;
    return typeof parsed.instanceId === 'string' && typeof parsed.socketId === 'string' ? parsed as SocketEndpoint : null;
  } catch { return null; }
}
function shortcut(editor: LabEditorController) {
  return (event: KeyboardEvent) => { handleEditorShortcut(event, editor); };
}
export function LabEditorToolbar({ editor }: LabEditorControlsProps) {
  const state = useLabEditorState(editor);
  const station = useLabRuntimeSelector(editor, (snapshot) => snapshot.stationStates[state.activeStationId]);
  const [confirmReset, setConfirmReset] = useState(false);
  const modes: readonly [EditorMode, string, string][] = [
    ['select', 'Select', 'V'], ['translate', 'Move', 'G'], ['rotate', 'Rotate', 'R'],
    ['connect', 'Connect', 'C'], ['operate', 'Operate', 'O'],
  ];
  return (
    <div className="lab-editor lab-editor-toolbar" onKeyDown={shortcut(editor)}>
      <div role="toolbar" aria-label="Laboratory editing tools" className="lab-editor-row">
        {modes.map(([mode, label, key]) => (
          <button key={mode} type="button" aria-pressed={state.mode === mode} title={`${label} (${key})`}
            onClick={() => editor.setMode(mode)} disabled={state.busy}>{label}</button>
        ))}
        <button type="button" onClick={() => { void editor.undo(); }} disabled={!state.canUndo} title="Undo preparation edit (Ctrl/⌘ Z)">Undo</button>
        <button type="button" onClick={() => { void editor.redo(); }} disabled={!state.canRedo} title="Redo preparation edit (Ctrl/⌘ Shift Z)">Redo</button>
        <button type="button" onClick={() => editor.cancel()} disabled={!editor.getPreview() && !state.pointerCaptured && !state.connectionSource}>Cancel</button>
      </div>
      <div className="lab-editor-row">
        <label>Grid (m)<select aria-label="Placement grid in meters" value={state.snapM}
          onChange={(event) => editor.setPrecision(Number(event.target.value))}>
          <option value={0}>Off</option><option value={0.001}>0.001</option><option value={0.005}>0.005</option>
          <option value={0.01}>0.01</option><option value={0.05}>0.05</option><option value={0.1}>0.1</option>
        </select></label>
        <span className="lab-editor-muted">Shift: 1 mm / 1° precision · wheel: camera zoom</span>
      </div>
      <details className="lab-editor-run-controls">
        <summary>Experiment controls — separate from preparation undo</summary>
        <p>Transfers, preparation and observations are never undone by the editor. Reset starts a new runtime epoch; replay belongs to the runtime ledger.</p>
        <div className="lab-editor-row">
          <button type="button" data-control-id="pause" disabled={state.busy || station?.status !== 'RUNNING'}
            onClick={() => { void editor.controlStation('PAUSE'); }}>Pause station</button>
          <button type="button" data-control-id="resume" disabled={state.busy || !station || station.status === 'RUNNING'}
            onClick={() => { void editor.controlStation('RESUME'); }}>Run / resume station</button>
          <label>Speed<select aria-label="Simulation speed" value={station?.speed ?? 1}
            onChange={(event) => { void editor.controlStation('SET_SPEED', Number(event.target.value)); }}>
            <option value={0.25}>¼×</option><option value={0.5}>½×</option><option value={1}>1×</option>
            <option value={2}>2×</option><option value={4}>4×</option>
          </select></label>
          <button type="button" disabled={state.busy} onClick={() => setConfirmReset(true)}>Reset experiment…</button>
          <button type="button" disabled={state.busy || !editor.supportsReplay} onClick={() => { void editor.replayStation(); }}
            title="Requires the runtime owner’s recorded checkpoint/replay adapter">Replay recorded run</button>
        </div>
        {confirmReset && <div role="alert" className="lab-editor-warning">
          <p>Restore the runtime’s recorded initial station and start a new epoch? This is an explicit experiment reset, not an inventory undo.</p>
          <button type="button" data-control-id="reset" onClick={() => { setConfirmReset(false); void editor.resetStation(); }}>Confirm station reset</button>
          <button type="button" onClick={() => setConfirmReset(false)}>Keep current experiment</button>
        </div>}
      </details>
      <p role="status" aria-live="polite" aria-atomic="true" className={`lab-editor-feedback lab-editor-feedback-${state.feedback.kind}`}>
        {state.feedback.message}
      </p>
      <LabEditorContextMenu editor={editor} />
    </div>
  );
}

export function LabEditorPalette({ editor }: LabEditorControlsProps) {
  const state = useLabEditorState(editor);
  const [query, setQuery] = useState('');
  const drag = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => () => {
    if (drag.current?.pointerId === editor.capturedPointerId) editor.cancel();
  }, [editor]);
  function down(event: PointerEvent<HTMLButtonElement>, definitionId: string): void {
    if (event.button !== 0 || event.isPrimary === false || state.busy) return;
    if (!editor.beginPlacement(definitionId) || !editor.beginCapture(event.currentTarget, event.pointerId, `palette:${definitionId}`)) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    suppressClick.current = true;
  }
  function move(event: PointerEvent<HTMLButtonElement>): void {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || editor.capturedPointerId !== event.pointerId) return;
    event.preventDefault();
    if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 4) current.moved = true;
    if (current.moved) {
      const ray = editor.camera.getWorldRay(event.clientX, event.clientY);
      if (ray) editor.hoverPlacement(ray, event.shiftKey);
    }
  }
  function up(event: PointerEvent<HTMLButtonElement>): void {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    move(event);
    drag.current = null;
    editor.finishCapture();
    if (current.moved) void editor.commitPreview();
  }
  function cancel(): void { drag.current = null; editor.cancel(); }
  const definitions = editor.definitions.listDefinitions().filter((definition) =>
    `${definition.label} ${definition.category} ${definition.capabilities.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <section className="lab-editor lab-editor-palette" aria-label="Apparatus palette" onKeyDown={shortcut(editor)}>
      <h3>Build your workbench</h3>
      <label>Find equipment<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Glassware, stand, sensor…" /></label>
      <p className="lab-editor-muted">Drag into the scene, or select an item and use the placement controls. All scene distances are meters.</p>
      <div className="lab-editor-palette-grid">
        {definitions.map((definition) => (
          <button key={definition.id} type="button" disabled={state.busy} className="lab-editor-equipment"
            aria-pressed={state.placementDefinitionId === definition.id} data-definition-id={definition.id}
            onPointerDown={(event) => down(event, definition.id)} onPointerMove={move} onPointerUp={up}
            onPointerCancel={cancel} onLostPointerCapture={() => { if (drag.current) cancel(); }}
            onClick={(event) => {
              if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; return; }
              suppressClick.current = false;
              editor.beginPlacement(definition.id);
            }}>
            <span>{definition.label}</span>
            <small>{definition.category}{definition.capacityL ? ` · ${(definition.capacityL * 1000).toLocaleString()} mL` : ''}</small>
            {definition.tags?.includes('requires-mount') && <small>Requires mechanical mount</small>}
          </button>
        ))}
      </div>
      {!definitions.length && <p>No equipment matches this search.</p>}
    </section>
  );
}

function PlacementControls({ editor }: LabEditorControlsProps) {
  const state = useLabEditorState(editor);
  const definition = state.placementDefinitionId ? editor.definitions.getDefinition(state.placementDefinitionId) : undefined;
  if (!definition) return null;
  const scene = editor.getRuntimeSnapshot().scene;
  const surfaces = editor.getSurfaces().filter((surface) =>
    (surface.stationId === undefined || surface.stationId === state.activeStationId) &&
    (definition.kind === 'BENCH' || definition.tags?.includes('floor-standing') ? surface.kind === 'floor' : surface.kind === 'tabletop'));
  const draft = editor.getPreview()?.instances[0];
  const mountedScene = draft ? { ...scene, apparatus: [...scene.apparatus, draft] } : scene;
  const mounts = scene.apparatus.filter((instance) => instance.stationId === state.activeStationId)
    .flatMap((instance) => editor.definitions.getDefinition(instance.definitionId)?.sockets
      .filter((socket) => socket.kind === 'MECHANICAL' && socket.direction !== 'IN')
      .flatMap((socket) => {
        const target = { instanceId: instance.id, socketId: socket.id };
        const compatible = draft && definition.sockets.some((source) => source.kind === 'MECHANICAL' && source.direction === 'IN' &&
          socketCandidate(mountedScene, editor.definitions, { instanceId: draft.id, socketId: source.id }, target,
            '00000000-0000-4000-8000-000000000000', editor.connectionValidator).valid);
        return compatible ? [{ endpoint: target, label: `${editor.definitions.getDefinition(instance.definitionId)!.label} / ${socket.id}` }] : [];
      }) ?? []);
  function surfaceSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    if (editor.previewPlacementOnSurface(value(form, 'surface'), numeric(form, 'x'), numeric(form, 'z'), numeric(form, 'yaw'))) {
      void editor.commitPreview();
    }
  }
  return (
    <fieldset className="lab-editor-card" disabled={state.busy}>
      <legend>Place {definition.label}</legend>
      {!definition.tags?.includes('requires-mount') && <form onSubmit={surfaceSubmit} className="lab-editor-form">
        <label>Supporting surface<select name="surface" required aria-label="Supporting surface">
          {surfaces.map((surface) => <option key={surface.id} value={surface.id}>{surface.kind} · {surface.id.slice(0, 8)}</option>)}
        </select></label>
        <div className="lab-editor-row">
          <label>Local X (m)<input name="x" type="number" step="0.001" defaultValue="0" required /></label>
          <label>Local Z (m)<input name="z" type="number" step="0.001" defaultValue="0" required /></label>
          <label>Yaw (°)<input name="yaw" type="number" step="1" defaultValue="0" required /></label>
        </div>
        <button type="submit" disabled={!surfaces.length}>Place on surface</button>
      </form>}
      <form className="lab-editor-form" onSubmit={(event) => {
        event.preventDefault();
        const target = endpointFrom(value(event.currentTarget, 'mount'));
        if (target && editor.previewPlacementOnSocket(target)) void editor.commitPreview();
      }}>
        <label>Compatible mount<select name="mount" aria-label="Compatible mechanical mount" required>
          {mounts.map((mount) => <option key={endpointValue(mount.endpoint)} value={endpointValue(mount.endpoint)}>{mount.label}</option>)}
        </select></label>
        <button type="submit" disabled={!mounts.length || !editor.supportsAtomicEdits}>Place and attach atomically</button>
        {!mounts.length && <small>No compatible free mount in this station. Place the required supporting apparatus first.</small>}
      </form>
    </fieldset>
  );
}

function TransformControls({ editor, instance, definition }: LabEditorControlsProps & {
  readonly instance: ApparatusInstance; readonly definition: ApparatusDefinition;
}) {
  const state = useLabEditorState(editor);
  const euler = new Euler().setFromQuaternion(new Quaternion(...instance.transform.quaternion), 'YXZ');
  const rotation = [euler.x, euler.y, euler.z].map((angle) => angle * 180 / Math.PI);
  return (
    <fieldset className="lab-editor-card" disabled={state.busy || state.lockedIds.includes(instance.id)}>
      <legend>Transform selection</legend>
      <form key={`${instance.id}:${instance.transform.positionM.join(',')}:${instance.transform.quaternion.join(',')}`}
        className="lab-editor-form" onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const quaternion = new Quaternion().setFromEuler(new Euler(
            numeric(form, 'rx') * Math.PI / 180, numeric(form, 'ry') * Math.PI / 180, numeric(form, 'rz') * Math.PI / 180, 'YXZ',
          )).toArray();
          void editor.setSelectionTransform({ positionM: [numeric(form, 'x'), numeric(form, 'y'), numeric(form, 'z')], quaternion });
        }}>
        <div className="lab-editor-row">
          {(['X', 'Y', 'Z'] as const).map((axis, index) => (
            <label key={axis}>{axis} (m)<input name={axis.toLowerCase()} type="number" step="0.001" required
              readOnly={!definition.permittedTransforms.translation.includes(axis)} defaultValue={instance.transform.positionM[index]} /></label>
          ))}
        </div>
        <div className="lab-editor-row">
          {(['X', 'Y', 'Z'] as const).map((axis, index) => (
            <label key={axis}>{axis} rotation (°)<input name={`r${axis.toLowerCase()}`} type="number" step="1" required
              readOnly={!definition.permittedTransforms.rotation.includes(axis)} defaultValue={Number(rotation[index].toFixed(6))} /></label>
          ))}
        </div>
        <button type="submit">Apply transform</button>
      </form>
      <div className="lab-editor-row">
        <button type="button" onClick={() => { void editor.rotateSelection('Y', -state.angleStepDeg); }}>Rotate left</button>
        <button type="button" onClick={() => { void editor.rotateSelection('Y', state.angleStepDeg); }}>Rotate right</button>
        <button type="button" onClick={() => { void editor.resetTransforms(); }}>Reset transforms</button>
      </div>
      <div className="lab-editor-row">
        <button type="button" disabled={state.selectedIds.length < 2} onClick={() => { void editor.alignSelection('X'); }}>Align X centers</button>
        <button type="button" disabled={state.selectedIds.length < 2} onClick={() => { void editor.alignSelection('Z'); }}>Align Z centers</button>
      </div>
    </fieldset>
  );
}

function ConnectionRow({ editor, connection }: LabEditorControlsProps & { readonly connection: Connection }) {
  const scene = editor.getRuntimeSnapshot().scene;
  const child = scene.apparatus.find((instance) => instance.id === connection.to.instanceId);
  const surfaces = editor.getSurfaces().filter((surface) => surface.kind === 'tabletop' &&
    (!surface.stationId || surface.stationId === child?.stationId));
  const without = { ...scene, connections: scene.connections.filter((edge) => edge.id !== connection.id) };
  const parents = connection.kind === 'MECHANICAL' ? scene.apparatus.flatMap((instance) =>
    editor.definitions.getDefinition(instance.definitionId)?.sockets.filter((socket) => socket.kind === 'MECHANICAL' && socket.direction !== 'IN')
      .flatMap((socket) => {
        const endpoint = { instanceId: instance.id, socketId: socket.id };
        const candidate = socketCandidate(without, editor.definitions, connection.to, endpoint,
          '00000000-0000-4000-8000-000000000000', editor.connectionValidator);
        return candidate.valid ? [{ endpoint, label: `${editor.definitions.getDefinition(instance.definitionId)!.label} / ${socket.id}` }] : [];
      }) ?? []) : [];
  return (
    <li className="lab-editor-connection">
      <span>{connection.kind}: {connection.from.socketId} → {connection.to.socketId}</span>
      {connection.kind === 'MECHANICAL' ? <>
        <form onSubmit={(event) => {
          event.preventDefault();
          const target = endpointFrom(value(event.currentTarget, 'parent'));
          if (target) void editor.reparent(connection.id, target);
        }}>
          <label>New parent<select name="parent" aria-label="New mechanical parent">
            {parents.map((parent) => <option key={endpointValue(parent.endpoint)} value={endpointValue(parent.endpoint)}>{parent.label}</option>)}
          </select></label>
          <button type="submit" disabled={!parents.length || !editor.supportsAtomicEdits}>Reparent atomically</button>
        </form>
        {!editor.definitions.getDefinition(child?.definitionId ?? '')?.tags?.includes('requires-mount') && <form onSubmit={(event) => {
          event.preventDefault();
          void editor.detach(connection.id, value(event.currentTarget, 'surface'));
        }}>
          <label>Detach onto<select name="surface" aria-label="Detachment support surface">
            {surfaces.map((surface) => <option key={surface.id} value={surface.id}>{surface.kind} · {surface.id.slice(0, 8)}</option>)}
          </select></label>
          <button type="submit" disabled={!surfaces.length || !editor.supportsAtomicEdits}>Detach to supported surface</button>
        </form>}
      </> : <button type="button" onClick={() => { void editor.detach(connection.id); }}>Disconnect {connection.kind.toLowerCase()}</button>}
    </li>
  );
}
function SocketControls({ editor, instance, definition }: LabEditorControlsProps & {
  readonly instance: ApparatusInstance; readonly definition: ApparatusDefinition;
}) {
  const state = useLabEditorState(editor);
  const scene = editor.getRuntimeSnapshot().scene;
  const candidates = state.connectionSource ? editor.connectionCandidates().filter((candidate) =>
    candidate.target.instanceId !== state.connectionSource!.instanceId) : [];
  const connections = scene.connections.filter((edge) => [edge.from.instanceId, edge.to.instanceId].includes(instance.id));
  return (
    <fieldset className="lab-editor-card" disabled={state.busy}>
      <legend>Sockets and assembly</legend>
      <p className="lab-editor-muted">Mechanical connections snap exactly. Fluid, sensor and control connections validate their current positions and never teleport.</p>
      <ul className="lab-editor-list">
        {definition.sockets.map((socket) => <li key={socket.id}>
          <button type="button" data-control-id={`socket:${socket.id}`} aria-pressed={state.connectionSource?.instanceId === instance.id && state.connectionSource.socketId === socket.id}
            onClick={() => editor.beginConnection({ instanceId: instance.id, socketId: socket.id })}>
            {socket.id} · {socket.kind.toLowerCase()} {socket.direction.toLowerCase()}
          </button>
        </li>)}
      </ul>
      {state.connectionSource && <form className="lab-editor-form" onSubmit={(event) => {
        event.preventDefault();
        const target = endpointFrom(value(event.currentTarget, 'target'));
        if (target) void editor.connect(state.connectionSource!, target);
      }}>
        <label>Target socket<select name="target" aria-label="Target socket" defaultValue={endpointValue(candidates.find((item) => item.valid)?.target ?? { instanceId: '', socketId: '' })}>
          {candidates.map((candidate) => {
            const target = scene.apparatus.find((item) => item.id === candidate.target.instanceId)!;
            return <option key={endpointValue(candidate.target)} value={endpointValue(candidate.target)} disabled={!candidate.valid}>
              {editor.definitions.getDefinition(target.definitionId)?.label} / {candidate.target.socketId}
              {candidate.valid ? '' : ` — ${candidate.reasons[0]}`}
            </option>;
          })}
        </select></label>
        <button type="submit" disabled={!candidates.some((candidate) => candidate.valid)}>Connect selected sockets</button>
      </form>}
      <ul className="lab-editor-list">
        {connections.map((connection) => <ConnectionRow key={connection.id} editor={editor} connection={connection} />)}
      </ul>
      {!definition.sockets.length && <p>No connections are declared for this apparatus.</p>}
    </fieldset>
  );
}

function OperationControls({ editor, instance, definition, preparationControls }: LabEditorInspectorProps & {
  readonly instance: ApparatusInstance; readonly definition: ApparatusDefinition;
}) {
  const snapshot = useLabRuntimeSelector(editor, (current) => current);
  const state = useLabEditorState(editor);
  const runtime = snapshot.apparatusStates[instance.id];
  const [opening, setOpening] = useState(runtime?.valveOpeningFraction ?? 0);
  useEffect(() => setOpening(runtime?.valveOpeningFraction ?? 0), [runtime?.valveOpeningFraction, instance.id]);
  const supports = (actionType: string) => definition.controls.some((control) => control.actionType === actionType);
  const frequency = definition.controls.find((control) => control.actionType === 'START_STIRRER')?.fields.frequencyHz;
  const transferVolume = definition.controls.find((control) => control.actionType === 'TRANSFER')?.fields.volumeL;
  const receivers = snapshot.scene.connections.filter((edge) => edge.enabled && edge.kind === 'FLUID' && edge.from.instanceId === instance.id);
  const probeReceivers = snapshot.scene.apparatus.filter((item) => item.stationId === instance.stationId && item.capabilities.includes('CONTAINER'));
  const contents = snapshot.scene.containerStates[instance.id];
  return (
    <fieldset className="lab-editor-card" disabled={state.busy || state.lockedIds.includes(instance.id)}>
      <legend>Operate apparatus</legend>
      {contents && <p>Authoritative contents: <output>{(contents.volumeL * 1000).toFixed(3)} mL</output> · {contents.temperatureK.toFixed(2)} K</p>}
      {supports('SET_VALVE') && <form className="lab-editor-form" onSubmit={(event) => {
        event.preventDefault(); void editor.setValve(instance.id, opening);
      }}>
        <label>Stopcock opening — {(opening * 100).toFixed(0)}%
          <input type="range" data-control-id="stopcock" min="0" max="1" step="0.01" value={opening}
            aria-valuetext={`${(opening * 100).toFixed(0)} percent; press Apply to operate`}
            onChange={(event) => setOpening(Number(event.target.value))} />
        </label>
        <div className="lab-editor-row">
          <button type="submit">Apply stopcock</button>
          <button type="button" onClick={() => { void editor.setValve(instance.id, 0); }}>Close valve</button>
          <button type="button" onClick={() => { void editor.setValve(instance.id, 0.05); }}>Fine flow 5%</button>
          <button type="button" onClick={() => { void editor.setValve(instance.id, 1); }}>Open valve</button>
        </div>
        <small>Click or drag the 3D stopcock. Opening is sent as SET_VALVE; only accepted runtime transfers change liquid volume.</small>
      </form>}
      {supports('START_STIRRER') && <form className="lab-editor-form" key={`${instance.id}:stirring:${runtime?.stirring?.enabled}`}
        onSubmit={(event) => {
          event.preventDefault();
          void editor.startStirrer(instance.id, value(event.currentTarget, 'enabled') === 'on', numeric(event.currentTarget, 'frequency'));
        }}>
        <label className="lab-editor-check"><input type="checkbox" name="enabled" data-control-id="stirring" defaultChecked={runtime?.stirring?.enabled ?? false} />Stirring enabled</label>
        <label>Frequency (Hz)<input type="number" name="frequency" min={frequency?.type === 'number' ? frequency.minimum : 0}
          max={frequency?.type === 'number' ? frequency.maximum : undefined} step="any"
          defaultValue={runtime?.stirring?.frequencyHz || (frequency?.type === 'number' ? frequency.default ?? 0 : 0)} required /></label>
        <button type="submit">Apply stirrer</button>
      </form>}
      {supports('SET_PROBE') && <form className="lab-editor-form" key={`${instance.id}:probe:${runtime?.probe?.containerInstanceId ?? ''}`}
        onSubmit={(event) => { event.preventDefault(); void editor.setProbe(instance.id, value(event.currentTarget, 'container') || null); }}>
        <label>Measured container<select name="container" data-control-id="probe" defaultValue={runtime?.probe?.containerInstanceId ?? ''}>
          <option value="">Disconnected</option>
          {probeReceivers.map((receiver) => <option key={receiver.id} value={receiver.id}>
            {editor.definitions.getDefinition(receiver.definitionId)?.label} · {receiver.id.slice(0, 8)}
          </option>)}
        </select></label>
        <button type="submit">Bind probe</button>
        <small>Position and connect compatible sensor sockets first. pH is read from the scientific ledger, never calculated here.</small>
      </form>}
      {supports('TRANSFER') && <form className="lab-editor-form" onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const edge = receivers.find((connection) => connection.id === value(form, 'connection'));
        if (edge) void editor.transfer(instance.id, edge.to.instanceId, numeric(form, 'volumeMl') / 1000, edge.id);
      }}>
        <label>Connected receiver<select name="connection" aria-label="Connected transfer receiver" required>
          {receivers.map((edge) => <option key={edge.id} value={edge.id}>
            {editor.definitions.getDefinition(snapshot.scene.apparatus.find((item) => item.id === edge.to.instanceId)?.definitionId ?? '')?.label}
            {' · '}{edge.to.instanceId.slice(0, 8)}
          </option>)}
        </select></label>
        <label>Metered volume (mL)<input type="number" name="volumeMl" min="0.001" max={(definition.capacityL ?? 1) * 1000}
          step="0.001" defaultValue={(transferVolume?.type === 'number' ? transferVolume.default ?? 0.00005 : 0.00005) * 1000} required /></label>
        <button type="submit" data-control-id="transfer" disabled={!receivers.length}>Request transfer</button>
        <small>{receivers.length ? 'Operate-mode drag onto a connected receiver requests the apparatus’s declared default metered volume.' : 'Align and connect a compatible fluid receiver before transferring.'}</small>
      </form>}
      {supports('FILL') && (preparationControls ?? <p className="lab-editor-muted">
        Prepare a supported solution with the science-owned preparation panel. The editor accepts its validated contents through <code>editor.fill</code>; it does not invent reagent species or concentrations.
      </p>)}
      {!definition.controls.length && <p>This apparatus has no declared operation controls.</p>}
    </fieldset>
  );
}

export function LabEditorInspector({ editor, preparationControls }: LabEditorInspectorProps) {
  const state = useLabEditorState(editor);
  const scene = useLabRuntimeSelector(editor, (snapshot) => snapshot.scene);
  const selected = scene.apparatus.find((instance) => instance.id === state.selectedIds[0]);
  const definition = selected && editor.definitions.getDefinition(selected.definitionId);
  const allLocked = state.selectedIds.length > 0 && state.selectedIds.every((id) => state.lockedIds.includes(id));
  return (
    <section className="lab-editor lab-editor-inspector" aria-label="Accessible laboratory editor" onKeyDown={shortcut(editor)}>
      <h3>Apparatus editor</h3>
      <label>Workstation<select value={state.activeStationId} aria-label="Active workstation"
        onChange={(event) => editor.setActiveStation(event.target.value)}>
        {scene.stations.map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}
      </select></label>
      <label>Apparatus selection (multiple supported)<select multiple size={6} value={[...state.selectedIds]}
        aria-label="Apparatus selection" onChange={(event) => editor.select([...event.target.selectedOptions].map((option) => option.value))}>
        {scene.apparatus.filter((instance) => instance.stationId === state.activeStationId).map((instance) => (
          <option key={instance.id} value={instance.id}>
            {editor.definitions.getDefinition(instance.definitionId)?.label ?? instance.definitionId} · {instance.id.slice(0, 8)}
            {state.lockedIds.includes(instance.id) ? ' · locked' : ''}
          </option>
        ))}
      </select></label>
      <div className="lab-editor-row">
        <button type="button" onClick={() => editor.selectStation()}>Select workstation</button>
        <button type="button" onClick={() => editor.focusSelection()}>Focus selection</button>
        <button type="button" disabled={!editor.supportsStationDuplication || state.busy} onClick={() => { void editor.duplicateStation(); }}
          title="Creates a new scene/run proposal with an empty independent duplicate; requires the runtime-owner adapter">Duplicate workstation…</button>
      </div>
      <PlacementControls editor={editor} />
      {selected && definition ? <>
        <h4>{state.selectedIds.length > 1 ? `${state.selectedIds.length} apparatus selected` : definition.label}</h4>
        <div className="lab-editor-row">
          <button type="button" onClick={() => { editor.copySelection(); }}>Copy geometry</button>
          <button type="button" disabled={state.busy} onClick={() => { void editor.paste(); }}>Paste empty</button>
          <button type="button" disabled={state.busy} onClick={() => { void editor.duplicateSelection(); }}>Duplicate empty</button>
          <button type="button" disabled={state.busy} onClick={() => { void editor.groupSelection(); }}>Group</button>
          <button type="button" disabled={state.busy} onClick={() => { void editor.ungroupSelection(); }}>Ungroup</button>
          <button type="button" disabled={state.busy} onClick={() => { void editor.lockSelection(!allLocked); }}>{allLocked ? 'Unlock' : 'Lock'}</button>
          <button type="button" disabled={state.busy || allLocked} onClick={() => { void editor.deleteSelection(); }}>Delete empty</button>
        </div>
        <TransformControls editor={editor} instance={selected} definition={definition} />
        <SocketControls editor={editor} instance={selected} definition={definition} />
        <OperationControls editor={editor} instance={selected} definition={definition} preparationControls={preparationControls} />
      </> : <p>Select apparatus in the scene or in this keyboard-accessible list. No 3D pointer is required to assemble a station.</p>}
      <details><summary>Keyboard reference</summary><dl className="lab-editor-shortcuts">
        {EDITOR_SHORTCUTS.map(([keys, description]) => <div key={keys}><dt>{keys}</dt><dd>{description}</dd></div>)}
      </dl></details>
      <p role="status" aria-live="polite" className={`lab-editor-feedback lab-editor-feedback-${state.feedback.kind}`}>{state.feedback.message}</p>
    </section>
  );
}

export function LabEditorContextMenu({ editor }: LabEditorControlsProps) {
  const state = useLabEditorState(editor);
  const menu = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!state.contextMenu) return;
    const element = menu.current;
    const previous = element?.ownerDocument.activeElement as HTMLElement | null;
    element?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [state.contextMenu]);
  if (!state.contextMenu || typeof document === 'undefined') return null;
  const run = (action: () => unknown) => () => { editor.closeContextMenu(); void action(); };
  return createPortal(
    <div ref={menu} className="lab-editor lab-editor-context" role="menu" aria-label="Apparatus context actions"
      style={{ left: Math.max(8, Math.min(state.contextMenu.clientX, (globalThis.innerWidth || 1024) - 230)),
        top: Math.max(8, Math.min(state.contextMenu.clientY, (globalThis.innerHeight || 768) - 310)) }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); editor.closeContextMenu(); }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
          const current = buttons.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement);
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[index]?.focus();
        }
      }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) editor.closeContextMenu(); }}>
      <button role="menuitem" type="button" onClick={run(() => editor.focusSelection())}>Focus selection</button>
      <button role="menuitem" type="button" onClick={run(() => editor.copySelection())}>Copy geometry</button>
      <button role="menuitem" type="button" onClick={run(() => editor.duplicateSelection())}>Duplicate empty</button>
      <button role="menuitem" type="button" onClick={run(() => editor.groupSelection())}>Group selection</button>
      <button role="menuitem" type="button" onClick={run(() => editor.ungroupSelection())}>Ungroup selection</button>
      <button role="menuitem" type="button" onClick={run(() => editor.lockSelection(!state.selectedIds.every((id) => state.lockedIds.includes(id))))}>Lock / unlock</button>
      <button role="menuitem" type="button" onClick={run(() => editor.resetTransforms())}>Reset transforms</button>
      <button role="menuitem" type="button" onClick={run(() => editor.deleteSelection())}>Delete empty apparatus</button>
      <button role="menuitem" type="button" onClick={() => editor.closeContextMenu()}>Close menu</button>
    </div>,
    document.body,
  );
}
