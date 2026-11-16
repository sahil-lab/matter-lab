import { useId, useState } from 'react';
import type { LabCameraController } from './CameraController';
import { useCameraSnapshot, useOptionalLabCamera } from './CameraModes';
import { DEFAULT_CAMERA_VIEW } from './cameraMath';
import type { LabCameraMode } from './types';

const cameraLabels: readonly [LabCameraMode, string][] = [
  ['orbit', 'Orbit'], ['first-person', 'Walk'], ['top-down', 'Top'], ['inspection', 'Inspect'],
];

/** Optional standalone controls. Agent01 can replace these using the same controller API. */
export function LabViewportControls({ controller: provided }: { controller?: LabCameraController }) {
  const context = useOptionalLabCamera();
  const controller = provided ?? context;
  if (!controller) throw new Error('LabViewportControls requires a camera controller.');
  const snapshot = useCameraSnapshot(controller);
  const [bookmarkName, setBookmarkName] = useState('');
  const bookmarkInputId = useId();
  return (
    <div className="lab-view-controls" aria-label="Laboratory camera controls">
      <div className="lab-view-controls-row" role="toolbar" aria-label="View mode">
        {cameraLabels.map(([mode, label]) => (
          <button
            key={mode} type="button" aria-label={`${label} camera`}
            aria-pressed={snapshot.view.mode === mode} disabled={snapshot.controlsLocked}
            onClick={() => controller.setMode(mode)}
          >{label}</button>
        ))}
        <button type="button" disabled={snapshot.controlsLocked} onClick={() => controller.setView(DEFAULT_CAMERA_VIEW)}>Reset view</button>
      </div>
      {snapshot.stations.length > 0 && (
        <div className="lab-view-controls-row" role="group" aria-label="Focus workstation">
          {snapshot.stations.map((station) => (
            <button
              key={station.id} type="button" disabled={snapshot.controlsLocked}
              aria-label={`Focus ${station.label}`} aria-pressed={snapshot.activeStationId === station.id}
              onClick={() => controller.focusStation(station.id)}
            >{station.label}</button>
          ))}
        </div>
      )}
      <details>
        <summary>Camera bookmarks &amp; keys</summary>
        <form onSubmit={(event) => { event.preventDefault(); if (controller.saveBookmark(bookmarkName)) setBookmarkName(''); }}>
          <label htmlFor={bookmarkInputId}>Bookmark name</label>
          <input id={bookmarkInputId} value={bookmarkName} maxLength={64} onChange={(event) => setBookmarkName(event.target.value)} />
          <button type="submit" disabled={!bookmarkName.trim() || snapshot.bookmarks.length >= 32}>Save view</button>
        </form>
        {snapshot.bookmarks.length > 0 && (
          <ul>
            {snapshot.bookmarks.map((bookmark) => (
              <li key={bookmark.id}>
                <button type="button" disabled={snapshot.controlsLocked} onClick={() => controller.restoreBookmark(bookmark.id)}>{bookmark.name}</button>
                <button type="button" aria-label={`Delete bookmark ${bookmark.name}`} onClick={() => controller.removeBookmark(bookmark.id)}>×</button>
              </li>
            ))}
          </ul>
        )}
        <p>Focus the viewport first. 1–4: camera mode. Arrows: pan. +/−: zoom. F: focus station. Home: reset. Escape: skip introduction.</p>
        <p>Walk: drag to look; W/A/S/D to move; Q/E down/up; Shift for faster movement. Camera controls pause during apparatus dragging.</p>
      </details>
      {snapshot.controlsLocked && <span role="status">Camera paused for editing</span>}
    </div>
  );
}
