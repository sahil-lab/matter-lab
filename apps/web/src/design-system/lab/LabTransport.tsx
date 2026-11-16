import { Pause, Play, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { LabButton, LabDialog } from './primitives';

export interface LabTransportProps {
  readonly state: 'idle' | 'running' | 'paused' | 'completed' | 'error' | 'unsupported';
  readonly simulationTimeLabel?: string;
  readonly canPlay?: boolean;
  readonly busy?: boolean;
  readonly disabledReason?: string;
  readonly onPlay?: () => void;
  readonly onPause?: () => void;
  readonly onReset?: () => void;
}

export function LabTransport({ state, simulationTimeLabel, canPlay = true, busy = false, disabledReason, onPlay, onPause, onReset }: LabTransportProps) {
  const [confirmReset, setConfirmReset] = useState(false);
  const running = state === 'running';
  const canOperate = !busy && (running ? Boolean(onPause) : canPlay && Boolean(onPlay) && state !== 'unsupported');
  return (
    <div className="mlab-transport" role="group" aria-label="Station simulation controls">
      {simulationTimeLabel && <span className="mlab-clock" aria-label={`Simulation time ${simulationTimeLabel}`}>{simulationTimeLabel}</span>}
      <LabButton variant={running ? 'outline' : 'primary'} disabled={!canOperate} title={canOperate ? undefined : disabledReason ?? 'Simulation controls are unavailable'}
        onClick={running ? onPause : onPlay} aria-label={running ? 'Pause simulation' : state === 'paused' ? 'Resume simulation' : 'Start simulation'}>
        {running ? <Pause /> : <Play />}<span>{running ? 'Pause' : state === 'paused' ? 'Resume' : 'Run'}</span>
      </LabButton>
      <LabButton icon aria-label="Reset station" title="Reset station" disabled={busy || !onReset} onClick={() => setConfirmReset(true)}><RotateCcw /></LabButton>
      {!canOperate && disabledReason && <span className="mlab-transport__reason">{disabledReason}</span>}
      <LabDialog open={confirmReset} size="small" title="Reset this station?" description="This asks the runtime to restore this station's starting state. Other stations are not a reset target."
        onClose={() => setConfirmReset(false)}
        footer={<><LabButton onClick={() => setConfirmReset(false)}>Keep station</LabButton><LabButton variant="danger" disabled={busy || !onReset} onClick={() => { setConfirmReset(false); onReset?.(); }}>Reset station</LabButton></>}>
        <p className="mlab-prose">Save a notebook snapshot first if you need to retain the current arrangement and observations. Reset is not a save operation.</p>
      </LabDialog>
    </div>
  );
}
