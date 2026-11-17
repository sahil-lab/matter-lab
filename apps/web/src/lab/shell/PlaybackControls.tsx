import { Pause, Play, RotateCcw, SkipBack, SkipForward } from 'lucide-react';
import { IconButton, Segmented } from '../../design-system';

const SPEEDS = [0.5, 1, 2, 4] as const;

/**
 * Play / pause / reset / step / speed — the shared contract's "pause, resume, replay, simulation
 * speed, reset" (§4, Agent 07). This component only renders controls and reports intent through
 * callbacks; Agent 07's runtime is the only thing allowed to actually advance or rewind lab time.
 */
export function PlaybackControls({
  playing,
  onPlayPause,
  onReset,
  onStepBack,
  onStepForward,
  speed,
  onSpeedChange,
  disabled,
}: {
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
    <div className="astra-playback">
      <IconButton tip="Step back" tipPos="top" disabled={disabled} onClick={onStepBack}>
        <SkipBack />
      </IconButton>
      <IconButton tip={playing ? 'Pause' : 'Play'} tipPos="top" variant="cool" size="lg" disabled={disabled} onClick={onPlayPause} data-testid="astra-playpause">
        {playing ? <Pause /> : <Play />}
      </IconButton>
      <IconButton tip="Step forward" tipPos="top" disabled={disabled} onClick={onStepForward}>
        <SkipForward />
      </IconButton>
      <IconButton tip="Reset to the start of this run" tipPos="top" disabled={disabled} onClick={onReset} data-testid="astra-reset">
        <RotateCcw />
      </IconButton>
      <div className="astra-sep" />
      <Segmented<string>
        label="Playback speed"
        tipPos="top"
        value={String(speed)}
        onChange={(v) => onSpeedChange(Number(v))}
        options={SPEEDS.map((s) => ({ value: String(s), label: `${s}×`, tip: `${s}× speed` }))}
      />
    </div>
  );
}
