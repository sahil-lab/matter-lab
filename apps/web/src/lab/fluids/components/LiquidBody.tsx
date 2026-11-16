/**
 * The liquid fill inside a vessel: side wall up to the meniscus plus a displaced-disc meniscus cap,
 * both built from `ContainerContents.volumeL` (Agent 07's authoritative state) and the vessel's own
 * calibration profile through `heightForVolume` — the same conversion the numeric burette reading
 * uses (`GraduationMarks`/`geometry/vesselProfile.ts`), so the two can never disagree. Nothing here
 * computes or adjusts a volume, a species amount or a color; `colorHex` must already be the final
 * composited liquid color (see `color/liquidTint.ts` + `color/indicatorColor.ts`).
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { LatheGeometry } from 'three';
import type { VesselProfile } from '../contracts';
import { liquidBodyPoints } from '../geometry/latheProfile';
import { applyMeniscusDisplacement, buildMeniscusDisc } from '../geometry/meniscusSurface';
import type { MeniscusParams } from '../geometry/meniscusSurface';
import { heightForVolume, radiusAtHeight, volumeAtHeight } from '../geometry/vesselProfile';
import { createLiquidMaterial, updateLiquidMaterial } from '../materials/liquidMaterial';
import { shouldAnimateSurface } from '../quality/fluidQuality';
import type { FluidQualitySettings } from '../quality/fluidQuality';

export interface LiquidBodyProps {
  readonly profile: VesselProfile;
  /** Authoritative liquid volume, liters (`ContainerContents.volumeL`). Read-only input. */
  readonly volumeL: number;
  readonly colorHex: string;
  readonly quality: FluidQualitySettings;
  /** 0 = still liquid, 1 = vigorous stirring/swirl. Purely decorative; never read back into `volumeL`. */
  readonly agitation?: number;
  readonly reducedMotion?: boolean;
}

/** Static concave dip at the vessel axis — a rendering parameter tuned for legibility, see `meniscusSurface.ts`. */
const DIP_DEPTH_M = 0.00035;
const SWIRL_SPEED_RAD_PER_S = 2.4;

export function LiquidBody({ profile, volumeL, colorHex, quality, agitation = 0, reducedMotion }: LiquidBodyProps) {
  const clampedVolumeL = Math.max(volumeL, 0);
  const fillHeightM = useMemo(() => heightForVolume(profile.points, clampedVolumeL), [profile.points, clampedVolumeL]);
  const surfaceRadiusM = useMemo(() => radiusAtHeight(profile.points, fillHeightM), [profile.points, fillHeightM]);
  const visibleVolumeL = useMemo(() => volumeAtHeight(profile.points, fillHeightM), [profile.points, fillHeightM]);

  const wallGeometry = useMemo(
    () => new LatheGeometry(liquidBodyPoints(profile, fillHeightM), quality.latheRadialSegments),
    [profile, fillHeightM, quality.latheRadialSegments],
  );
  const discGeometry = useMemo(
    () => buildMeniscusDisc(surfaceRadiusM, quality.meniscusRings, quality.meniscusSegments),
    [surfaceRadiusM, quality.meniscusRings, quality.meniscusSegments],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt only when the transmission/alpha fallback choice changes; color updates go through updateLiquidMaterial below.
  const material = useMemo(() => createLiquidMaterial(quality, { colorHex }), [quality.liquidTransmission]);

  useEffect(() => () => wallGeometry.dispose(), [wallGeometry]);
  useEffect(() => () => discGeometry.dispose(), [discGeometry]);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => updateLiquidMaterial(material, { colorHex }), [material, colorHex]);

  const params = useMemo<MeniscusParams>(
    () => ({ dipDepthM: DIP_DEPTH_M, agitation, swirlSpeedRadPerS: SWIRL_SPEED_RAD_PER_S }),
    [agitation],
  );

  // The resting shape (no animation) is always built at least once, including on low-power/reduced-motion paths.
  useEffect(() => {
    applyMeniscusDisplacement(discGeometry, surfaceRadiusM, 0, params);
  }, [discGeometry, surfaceRadiusM, params]);

  useFrame(({ clock }) => {
    if (!shouldAnimateSurface(quality, agitation, reducedMotion)) return;
    applyMeniscusDisplacement(discGeometry, surfaceRadiusM, clock.elapsedTime, params);
  });

  if (visibleVolumeL <= 0) return null;

  return (
    <group>
      <mesh geometry={wallGeometry} material={material} />
      <mesh geometry={discGeometry} material={material} position={[0, fillHeightM, 0]} />
    </group>
  );
}
