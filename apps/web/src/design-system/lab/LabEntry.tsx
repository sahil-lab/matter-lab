import { ArrowRight, BookOpen, Check, Crosshair } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLabMotion } from './motion';
import type { LabMotion } from './motion';
import { LabButton, LabDialog, LabTag } from './primitives';

export const LAB_ENTRY_KEY = 'matterlab.instrument-room.entry.v1';
export type LabEntryStage = 'wide' | 'bench' | 'ready';
export type LabEntryStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function needsLabEntry(storage?: LabEntryStorage): boolean {
  try { return storage?.getItem(LAB_ENTRY_KEY) !== 'seen'; } catch { return true; }
}

export function rememberLabEntry(storage?: LabEntryStorage): boolean {
  try {
    if (!storage) return false;
    storage.setItem(LAB_ENTRY_KEY, 'seen');
    return true;
  } catch { return false; }
}

function browserStorage(): LabEntryStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; }
}

export interface LabEntryProps {
  readonly onEnter?: (choice: 'explore' | 'guided') => void;
  /** The environment may use the shared durations for its camera. Never delays the Enter button. */
  readonly onStageChange?: (stage: LabEntryStage, motion: LabMotion) => void;
  readonly storage?: LabEntryStorage;
  readonly replay?: boolean;
}

export function LabEntry({ onEnter, onStageChange, storage, replay = false }: LabEntryProps) {
  const [preferenceStorage] = useState(() => storage ?? browserStorage());
  const [open, setOpen] = useState(() => replay || needsLabEntry(preferenceStorage));
  const [stage, setStage] = useState<LabEntryStage>('wide');
  const motion = useLabMotion();
  useEffect(() => {
    if (!open || motion.reduced) {
      setStage('ready');
      onStageChange?.('ready', { ...motion, cameraDurationS: 0 });
      return;
    }
    setStage('wide');
    onStageChange?.('wide', motion);
    const approach = window.setTimeout(() => { setStage('bench'); onStageChange?.('bench', motion); }, motion.entryDurationMs / 2);
    const ready = window.setTimeout(() => { setStage('ready'); onStageChange?.('ready', motion); }, motion.entryDurationMs);
    return () => { window.clearTimeout(approach); window.clearTimeout(ready); };
  }, [open, motion, onStageChange]);
  const enter = (choice: 'explore' | 'guided') => {
    rememberLabEntry(preferenceStorage);
    setOpen(false);
    onEnter?.(choice);
  };
  if (!open) return null;
  return (
    <LabDialog open={open} title="Observe. Measure. Understand." size="large"
      description="Your instrument room, ready when you are. This introduction is optional."
      onClose={() => enter('explore')}
      footer={<><LabButton onClick={() => enter('explore')}>Skip introduction</LabButton>{onEnter && <LabButton variant="outline" onClick={() => enter('guided')}><BookOpen />Guided experiments</LabButton>}<LabButton variant="primary" onClick={() => enter('explore')}>Enter laboratory<ArrowRight /></LabButton></>}>
      <div className="mlab-entry" data-stage={stage}>
        <div className="mlab-entry__instrument" aria-hidden="true">
          <span className="mlab-eyebrow">MATTER / FIELD NOTES</span><Crosshair /><span className="mlab-entry__index">01<span>LABORATORY</span></span>
          <div className="mlab-entry__scale">{Array.from({ length: 21 }, (_, index) => <i key={index} />)}</div>
        </div>
        <div className="mlab-entry__copy">
          <LabTag tone="warm">An educational instrument, not a prediction machine</LabTag>
          <ol>
            <li><span>01</span><div><h3>Assemble a question</h3><p>Find apparatus in the library. Place, connect and adjust it on your own workbench.</p></div></li>
            <li><span>02</span><div><h3>Let the model speak</h3><p>Read observations with their units, evidence and method. Missing support stays visible, never filled in.</p></div></li>
            <li><span>03</span><div><h3>Keep the reasoning</h3><p>Open the ledger and explanation to inspect assumptions and sources. Save through the connected notebook controls.</p></div></li>
          </ol>
          <p className="mlab-entry__ready"><Check aria-hidden="true" />Enter at any time. Returning visits skip this introduction.</p>
        </div>
      </div>
    </LabDialog>
  );
}
