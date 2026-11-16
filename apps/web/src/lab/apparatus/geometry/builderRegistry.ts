/**
 * Maps each definition's `asset.proceduralBuilderId` to the function that actually builds its
 * mesh. `components/ApparatusMesh.tsx` is the one place that needs this map — definitions and
 * individual geometry builders never need to know the string keys exist.
 */
import { buildBeakerGeometry } from './beaker';
import { buildBuretteGeometry } from './burette';
import { buildBuretteClampGeometry } from './buretteClamp';
import { buildConicalFlaskGeometry } from './conicalFlask';
import { buildMagneticStirrerGeometry } from './magneticStirrer';
import { buildPhProbeGeometry } from './phProbe';
import { buildPipetteGeometry } from './pipette';
import { buildReagentBottleGeometry } from './reagentBottle';
import { buildRetortStandGeometry } from './retortStand';
import { buildTestTubeGeometry } from './testTube';
import type { GeometryBuildResult } from './types';
import { buildVolumetricFlaskGeometry } from './volumetricFlask';
import { buildWorkbenchGeometry } from './workbench';

export type ProceduralGeometryBuilder = () => GeometryBuildResult;

/** Keyed by `ApparatusDefinition.id` (every current definition uses its own id as its
 * `proceduralBuilderId`, so there is exactly one obvious builder per registered definition). */
export const PROCEDURAL_GEOMETRY_BUILDERS: Readonly<Record<string, ProceduralGeometryBuilder>> = {
  'workbench-standard': () => buildWorkbenchGeometry(),
  'retort-stand-600mm': () => buildRetortStandGeometry(),
  'burette-clamp-boss-head': () => buildBuretteClampGeometry(),
  'burette-50ml-class-a': () => buildBuretteGeometry(),
  'conical-flask-250ml': () => buildConicalFlaskGeometry(),
  'reagent-bottle-250ml': () => buildReagentBottleGeometry(),
  'magnetic-stirrer-compact': () => buildMagneticStirrerGeometry(),
  'ph-probe-combination': () => buildPhProbeGeometry(),
  'beaker-250ml-low-form': () => buildBeakerGeometry(),
  'test-tube-16x100mm': () => buildTestTubeGeometry(),
  'volumetric-flask-250ml': () => buildVolumetricFlaskGeometry(),
  'pipette-25ml-volumetric': () => buildPipetteGeometry(),
};

export function resolveProceduralBuilder(id: string): ProceduralGeometryBuilder | undefined {
  return PROCEDURAL_GEOMETRY_BUILDERS[id];
}
