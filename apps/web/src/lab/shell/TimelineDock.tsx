import { ChevronDown, ChevronUp } from 'lucide-react';
import { Panel, cx } from '../../design-system';
import type { TitrationPoint } from './contracts';
import { PlaybackControls } from './PlaybackControls';
import { TitrationChart } from './TitrationChart';

/**
 * The bottom timeline dock: collapsed to a slim playback strip by default, expanding to show the
 * pH-vs-volume plot (shared contract §6 steps 5 and 7: "plot titration pH vs delivered mL",
 * "Pause, resume, reset, save, reopen and replay").
 */
export function TimelineDock({
  open,
  onToggle,
  points,
  equivalenceVolumeL,
  endpointVolumeL,
  cursorVolumeL,
  playing,
  onPlayPause,
  onReset,
  onStepBack,
  onStepForward,
  speed,
  onSpeedChange,
  disabled,
}: {
  open: boolean;
  onToggle: () => void;
  points: readonly TitrationPoint[];
  equivalenceVolumeL: number | null;
  endpointVolumeL: number | null;
  cursorVolumeL: number | null;
  playing: boolean;
  onPlayPause: () => void;
  onReset: () => void;
  onStepBack: () => void;
  onStepForward: () => void;
  speed: number;
  onSpeedChange: (speed: number) => void;
  disabled?: boolean;
}) {
  return (
    <Panel elevation="raised" padding="none" className={cx('astra-dock', open && 'is-open')} aria-label="Experiment timeline">
      <button type="button" className="astra-dock__toggle" aria-expanded={open} onClick={onToggle} data-testid="astra-dock-toggle">
        {open ? <ChevronDown /> : <ChevronUp />}
        <span className="astra-eyebrow">Timeline &amp; plot</span>
      </button>
      {open && (
        <div className="astra-dock__chart">
          <TitrationChart points={points} equivalenceVolumeL={equivalenceVolumeL} endpointVolumeL={endpointVolumeL} cursorVolumeL={cursorVolumeL} />
        </div>
      )}
      <div className="astra-dock__controls">
        <PlaybackControls playing={playing} onPlayPause={onPlayPause} onReset={onReset} onStepBack={onStepBack} onStepForward={onStepForward} speed={speed} onSpeedChange={onSpeedChange} disabled={disabled} />
      </div>
    </Panel>
  );
}
