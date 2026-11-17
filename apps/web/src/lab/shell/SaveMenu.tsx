import { Copy, Download, Save } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Button, useDismiss } from '../../design-system';
import { notifyAstra } from './store';

/**
 * Save / duplicate / export entry points. Agent 09 owns real persistence and export
 * (`POST /api/v1/lab/scenes`, `.../duplicate`, `.../export`); none of that exists in this
 * worktree, so each action here only confirms the intent with a toast. Wire the real calls in
 * when the backend lands — the click targets and copy are stable.
 */
export function SaveMenu() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss<HTMLDivElement>(open, close);

  const run = (label: string, action: () => void) => () => {
    close();
    action();
    notifyAstra('info', label);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <Button variant="outline" tip="Save, duplicate or export this scene" tipPos="bottom" active={open} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <Save /> Save
      </Button>
      {open && (
        <div className="astra-menu" role="menu" style={{ top: 'calc(100% + 8px)', left: 0, width: 268 }}>
          <button type="button" className="astra-menu__item" role="menuitem" onClick={run('Scene saved (preview — Agent 09 persistence not yet connected)', () => {})}>
            <Save /> Save scene
          </button>
          <button type="button" className="astra-menu__item" role="menuitem" onClick={run('Scene duplicated as a second station (preview)', () => {})}>
            <Copy /> Duplicate station
          </button>
          <div className="astra-menu__sep" />
          <button type="button" className="astra-menu__item" role="menuitem" onClick={run('Export is not connected yet (Agent 09 owns POST /api/v1/lab/scenes/{id}/export)', () => {})}>
            <Download /> Export (.xlsx / .json)
          </button>
        </div>
      )}
    </div>
  );
}
