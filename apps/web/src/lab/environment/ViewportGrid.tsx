/**
 * A metre-scale placement grid over the floor: a visual reference for spatial layout and a visual
 * home for snap feedback. `coordinates.ts`'s `snapToGrid`/`GRID_CELL_M` is the matching numeric
 * snap function Agent 04 can call while dragging; this component only draws the reference, it does
 * not itself constrain placement.
 */
import { Grid } from '@react-three/drei';
import { GRID_CELL_M } from './coordinates';

export interface ViewportGridProps {
  readonly widthM: number;
  readonly depthM: number;
  readonly visible: boolean;
  readonly color?: string;
}

export function ViewportGrid({ widthM, depthM, visible, color = '#6f7682' }: ViewportGridProps) {
  if (!visible) return null;
  return (
    <Grid
      args={[widthM, depthM]}
      position={[0, 0.002, 0]}
      cellSize={GRID_CELL_M}
      cellThickness={0.5}
      cellColor={color}
      sectionSize={1}
      sectionThickness={1}
      sectionColor={color}
      fadeDistance={Math.max(widthM, depthM) * 1.3}
      fadeStrength={1.5}
      infiniteGrid={false}
      followCamera={false}
    />
  );
}
