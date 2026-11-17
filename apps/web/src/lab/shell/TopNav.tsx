import { ArrowLeft, Maximize, Minimize, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { IconButton } from '../../design-system';
import { JobProgress } from './JobProgress';
import { QualityMenu } from './QualityMenu';
import { SaveMenu } from './SaveMenu';
import { ViewModeSwitcher } from './ViewModeSwitcher';
import type { AstraCameraMode, AstraQualityId } from './store';

function useFullscreen(): [boolean, () => void] {
  const [full, setFull] = useState(() => typeof document !== 'undefined' && document.fullscreenElement !== null);
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => {});
  };
  return [full, toggle];
}

export function TopNav({
  libraryOpen,
  onToggleLibrary,
  inspectorOpen,
  onToggleInspector,
  cameraMode,
  onCameraModeChange,
  quality,
  onQualityChange,
  onBack,
}: {
  libraryOpen: boolean;
  onToggleLibrary: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  cameraMode: AstraCameraMode;
  onCameraModeChange: (mode: AstraCameraMode) => void;
  quality: AstraQualityId;
  onQualityChange: (quality: AstraQualityId) => void;
  onBack: () => void;
}) {
  const [full, toggleFull] = useFullscreen();
  return (
    <div className="astra-topnav">
      <div className="astra-panel astra-panel--raised astra-topnav__group">
        <IconButton tip="Back to MATTER LAB" tipPos="bottom" onClick={onBack}>
          <ArrowLeft />
        </IconButton>
        <div className="astra-sep" />
        <span className="astra-brand">
          MATTER LAB <span className="astra-brand__accent">Astra</span>
        </span>
        <div className="astra-sep" />
        <IconButton tip={libraryOpen ? 'Hide apparatus library' : 'Show apparatus library'} tipPos="bottom" active={libraryOpen} onClick={onToggleLibrary} data-testid="astra-toggle-library">
          {libraryOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
        </IconButton>
      </div>

      <div className="astra-topnav__center astra-panel astra-panel--raised">
        <ViewModeSwitcher value={cameraMode} onChange={onCameraModeChange} />
      </div>

      <div className="astra-panel astra-panel--raised astra-topnav__group">
        <SaveMenu />
        <div className="astra-sep" />
        <JobProgress />
        <QualityMenu quality={quality} onChange={onQualityChange} />
        <IconButton tip={full ? 'Exit fullscreen' : 'Enter fullscreen'} tipPos="bottom" active={full} onClick={toggleFull}>
          {full ? <Minimize /> : <Maximize />}
        </IconButton>
        <IconButton tip={inspectorOpen ? 'Hide inspector' : 'Show inspector'} tipPos="bottom-end" active={inspectorOpen} onClick={onToggleInspector} data-testid="astra-toggle-inspector">
          {inspectorOpen ? <PanelRightClose /> : <PanelRightOpen />}
        </IconButton>
      </div>
    </div>
  );
}
