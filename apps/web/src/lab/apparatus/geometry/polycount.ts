/**
 * Single place that turns a built geometry's triangle tally into the integer
 * `AssetManifestEntry.polyCount` every definition reports (brief acceptance test: "documented
 * poly count"). Every definition should call this rather than reading `.polyCount` off its build
 * result directly, so the figure is always derived from the actual mesh and never hand-typed.
 */
import type { GeometryBuildResult } from './types';

export function polyCountOf(build: GeometryBuildResult): number {
  return Math.round(build.polyCount);
}
