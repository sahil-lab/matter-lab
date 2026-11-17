/**
 * Standalone exerciser for `apps/web/src/lab/editor/**` — not part of the production app shell
 * (that is Agent 01/02's surface, which does not exist in this worktree). Mounted from its own
 * Vite HTML entry (`apps/web/lab-editor.html`) so it never touches the existing, working molecule
 * editor. Wires the provisional stand-ins (`createLabReducer`, `APPARATUS_CATALOG`) together with
 * everything this branch actually owns, so the shared contract's Section 6 vertical slice —
 * place → snap/attach → fill → open valve → meter transfer → live pH → plot → pause/resume/reset →
 * save/reopen → a second independent station — can be driven with a real mouse and keyboard and
 * verified by Playwright, not merely asserted in prose.
 */
import { useEffect, useRef, useState } from 'react';
import type { Camera } from 'three';
import { createLabReducer } from '../../experiments/labReducer';
import type { LabReducer } from '../../experiments/labReducer';
import { installLabActionSink } from '../actionSink';
import { duplicateStation, undo, redo } from '../commands';
import { ApparatusPalette } from './ApparatusPalette';
import { Hud } from './Hud';
import { LabEditorCanvas } from './LabEditorScene';
import type { GestureController } from '../GestureController';
import { labEditor, useLabEditor } from '../editorStore';
import { installLabEditorTestApi } from '../dev/testApi';

export function LabEditorHarness(): React.JSX.Element {
  const [reducer] = useState<LabReducer>(() => createLabReducer());
  const gesturesRef = useRef<GestureController | null>(null);
  const cameraRef = useRef<Camera | null>(null);
  const stations = useLabEditor((s) => s.stations);
  const activeStationId = useLabEditor((s) => s.activeStationId);

  useEffect(() => installLabActionSink(reducer), [reducer]);
  useEffect(() => installLabEditorTestApi(reducer, () => cameraRef.current, () => gesturesRef.current), [reducer]);

  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh', background: '#0b0f16', fontFamily: 'system-ui, sans-serif' }}>
      <ApparatusPalette onArm={(id) => gesturesRef.current?.armPlacement(id)} />
      <div
        style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column' }}
        onDragOver={(e) => {
          e.preventDefault();
          gesturesRef.current?.updatePlacementPreviewAt(e.clientX, e.clientY);
        }}
        onDrop={(e) => {
          e.preventDefault();
          gesturesRef.current?.commitPlacementAt(e.clientX, e.clientY);
        }}
      >
        <div style={{ display: 'flex', gap: 8, padding: 8, alignItems: 'center', color: '#e7edf5', fontSize: 13 }} data-testid="station-bar">
          {stations.map((station) => (
            <button
              key={station.id}
              type="button"
              onClick={() => labEditor.set({ activeStationId: station.id })}
              data-testid={`station-${station.id}`}
              style={{ fontWeight: station.id === activeStationId ? 700 : 400, padding: '4px 8px', borderRadius: 6, border: '1px solid #2a3444', background: station.id === activeStationId ? '#1d2531' : 'transparent', color: '#e7edf5' }}
            >
              {station.name}
            </button>
          ))}
          <button
            type="button"
            data-testid="btn-duplicate-station"
            onClick={() => {
              const newId = duplicateStation(activeStationId, `Station ${stations.length + 1}`);
              labEditor.set({ activeStationId: newId });
            }}
            style={{ marginLeft: 'auto', padding: '4px 8px', borderRadius: 6, border: '1px solid #2a3444', background: 'transparent', color: '#e7edf5' }}
          >
            Duplicate station
          </button>
          <button type="button" onClick={() => undo()} data-testid="btn-undo-top" style={{ padding: '4px 8px' }}>
            ↶
          </button>
          <button type="button" onClick={() => redo()} data-testid="btn-redo-top" style={{ padding: '4px 8px' }}>
            ↷
          </button>
        </div>
        <div style={{ flex: 1, position: 'relative' }}>
          <LabEditorCanvas onGesturesReady={(g) => (gesturesRef.current = g)} onFrame={(dt) => reducer.advanceSimulation(dt)} onCameraReady={(c) => (cameraRef.current = c)} />
        </div>
      </div>
      <Hud reducer={reducer} />
    </div>
  );
}
