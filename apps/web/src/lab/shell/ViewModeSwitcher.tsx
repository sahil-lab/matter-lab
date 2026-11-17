import { Compass, Orbit, Video } from 'lucide-react';
import { Segmented } from '../../design-system';
import type { AstraCameraMode } from './store';

const OPTIONS: ReadonlyArray<{ value: AstraCameraMode; label: string; icon: typeof Orbit; tip: string }> = [
  { value: 'orbit', label: 'Orbit', icon: Orbit, tip: 'Orbit camera: rotate freely around the station' },
  { value: 'first-person', label: 'Walk', icon: Video, tip: 'First-person: move through the room at eye height' },
  { value: 'top-down', label: 'Plan', icon: Compass, tip: 'Orthographic top-down: a plan view of the bench' },
];

/**
 * The camera-mode switcher named in the brief ("lab-mode switcher (orbit/first-person/top-down)").
 * Agent 01 owns the control; Agent 02 owns what it actually does to the camera. Until that
 * integration lands, choosing a mode only updates this shell's own state (and the viewport
 * placeholder's label) so the control can be reviewed and tested in isolation.
 */
export function ViewModeSwitcher({ value, onChange }: { value: AstraCameraMode; onChange: (mode: AstraCameraMode) => void }) {
  return (
    <Segmented<AstraCameraMode>
      label="Camera mode"
      accent
      tipPos="bottom"
      value={value}
      onChange={onChange}
      options={OPTIONS.map((o) => ({ value: o.value, tip: o.tip, ariaLabel: o.label, label: (
        <>
          <o.icon />
          <span className="astra-hide-narrow">{o.label}</span>
        </>
      ) }))}
    />
  );
}
