import { Box } from 'lucide-react';
import type { ReactNode } from 'react';
import { Eyebrow } from '../../design-system';
import type { AstraCameraMode } from './store';

const CAMERA_LABEL: Readonly<Record<AstraCameraMode, string>> = {
  orbit: 'Orbit',
  'first-person': 'First-person',
  'top-down': 'Top-down (plan)',
};

/**
 * The full-bleed 3D viewport slot (brief §"Required implementation" 2: "75-85% of the usable area
 * can be a 3D viewport"). Agent 02 owns everything actually rendered here (`LabWorld`,
 * `CameraDirector`, …); this component is only the frame and, failing that, an honest placeholder —
 * never scene geometry or apparatus. Pass the real environment as `children` once it exists.
 */
export function ViewportFrame({ cameraMode, children }: { cameraMode: AstraCameraMode; children?: ReactNode }) {
  if (children) return <div className="astra-viewport">{children}</div>;
  return (
    <div className="astra-viewport astra-viewport--placeholder" data-testid="astra-viewport-placeholder">
      <div className="astra-viewport__backdrop" aria-hidden />
      <div className="astra-viewport__card">
        <Box aria-hidden />
        <Eyebrow>3D viewport</Eyebrow>
        <p>
          The environment, apparatus and editor (Agents 02–04) are not wired into this worktree yet. This frame is only the shell Agent 01 owns — the real scene mounts here unchanged.
        </p>
        <p className="astra-viewport__mode astra-mono">camera mode: {CAMERA_LABEL[cameraMode]}</p>
      </div>
    </div>
  );
}
