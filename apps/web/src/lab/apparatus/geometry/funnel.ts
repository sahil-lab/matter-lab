/** Procedural geometry for a filter/powder funnel (FUNNEL): a conical bowl with a long thin stem.
 * Unlike the vessels in this module, a funnel is a flow passage, not a liquid-holding container —
 * it declares no `CONTAINER` capacity to calibrate against (see `definitions/funnel.ts`). */
import { at, cylinderGroup } from './hardware';
import { buildRevolutionMesh, funnelBowlProfile } from './profiles';
import { combineBuildResults, type GeometryBuildResult } from './types';

export interface FunnelGeometryConfig {
  readonly bowlTopRadiusM: number;
  readonly bowlBottomRadiusM: number;
  readonly bowlHeightM: number;
  readonly stemRadiusM: number;
  readonly stemHeightM: number;
}

export const DEFAULT_FUNNEL_CONFIG: FunnelGeometryConfig = {
  bowlTopRadiusM: 0.035,
  bowlBottomRadiusM: 0.004,
  bowlHeightM: 0.05,
  stemRadiusM: 0.004,
  stemHeightM: 0.09,
};

/** The funnel's local origin is the stem tip (its pour-out point), matching the convention every
 * other FLOW_SOURCE instrument in this module uses for its `tip` flow port. */
export function buildFunnelGeometry(config: FunnelGeometryConfig = DEFAULT_FUNNEL_CONFIG): GeometryBuildResult {
  const { bowlTopRadiusM, bowlBottomRadiusM, bowlHeightM, stemRadiusM, stemHeightM } = config;
  const bowlProfile = funnelBowlProfile(bowlTopRadiusM, bowlBottomRadiusM, bowlHeightM).map((p) => ({ ...p, y: p.y + stemHeightM }));
  const mesh = buildRevolutionMesh(bowlProfile, 28);
  return combineBuildResults([
    { materialSlot: 'glass', geometry: mesh.geometry },
    cylinderGroup('glass', stemRadiusM, stemRadiusM, stemHeightM, at(0, stemHeightM / 2, 0), 12),
  ]);
}
