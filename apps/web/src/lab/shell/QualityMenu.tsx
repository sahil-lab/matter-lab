import { Gauge, MonitorCog, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useCallback, useState } from 'react';
import { IconButton, Segmented, setReducedMotionPreference, useDismiss, useReducedMotion } from '../../design-system';
import type { AstraQualityId } from './store';
import { replayOnboarding } from './store';

const QUALITY_INFO: Readonly<Record<AstraQualityId, { label: string; description: string }>> = {
  efficient: { label: 'Efficient', description: 'Direct pipeline, minimal post-processing. Best for integrated graphics or battery power.' },
  balanced: { label: 'Balanced', description: 'Ambient occlusion and restrained bloom. The default once a device is recognised.' },
  quality: { label: 'Quality', description: 'Full post-processing stack for capable discrete GPUs.' },
};

/** Display settings: render quality preset, the reduced-motion toggle, and replaying the opening sequence. */
export function QualityMenu({ quality, onChange }: { quality: AstraQualityId; onChange: (quality: AstraQualityId) => void }) {
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss<HTMLDivElement>(open, close);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <IconButton tip="Display settings" tipPos="bottom" active={open} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <SlidersHorizontal />
      </IconButton>
      {open && (
        <div className="astra-menu" role="menu" style={{ top: 'calc(100% + 8px)', right: 0, width: 300 }}>
          <div className="astra-menu__label">
            <Gauge /> Render quality
          </div>
          <Segmented<AstraQualityId>
            label="Render quality"
            fill
            value={quality}
            onChange={onChange}
            options={(Object.keys(QUALITY_INFO) as AstraQualityId[]).map((id) => ({ value: id, label: QUALITY_INFO[id].label }))}
          />
          <p className="astra-menu__hint">{QUALITY_INFO[quality].description}</p>
          <div className="astra-menu__sep" />
          <button type="button" className="astra-menu__item" role="menuitemcheckbox" aria-checked={reduced} onClick={() => setReducedMotionPreference(!reduced)}>
            <MonitorCog /> Reduce motion
            <span className="astra-menu__check">{reduced ? '✓' : ''}</span>
          </button>
          <button
            type="button"
            className="astra-menu__item"
            role="menuitem"
            onClick={() => {
              close();
              replayOnboarding();
            }}
          >
            <RotateCcw /> Replay the opening sequence
          </button>
        </div>
      )}
    </div>
  );
}

