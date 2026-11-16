/**
 * The PBR glass shell for a burette, flask, beaker or reagent bottle. Pure presentation: it reads
 * the vessel's calibration profile (standing in for Agent 03's eventual vessel metadata — see
 * `VesselProfile` in `contracts.ts`) and the render quality, and owns nothing about where the
 * vessel sits in the scene. The caller positions this component's local origin at the vessel's own
 * base socket (e.g. by wrapping it in a `<group>` using Agent 02/03/04's transform).
 */
import { useEffect, useMemo } from 'react';
import { LatheGeometry } from 'three';
import type { VesselProfile } from '../contracts';
import { glassShellPoints } from '../geometry/latheProfile';
import { createGlassMaterial } from '../materials/glassMaterial';
import type { FluidQualitySettings } from '../quality/fluidQuality';

export interface GlassVesselProps {
  readonly profile: VesselProfile;
  readonly quality: FluidQualitySettings;
  /** Optional body tint, e.g. the amber of a UV-protective reagent bottle. Omit for clear glass. */
  readonly tintHex?: string;
}

export function GlassVessel({ profile, quality, tintHex }: GlassVesselProps) {
  const geometry = useMemo(
    () => new LatheGeometry(glassShellPoints(profile), quality.latheRadialSegments),
    [profile, quality.latheRadialSegments],
  );
  const material = useMemo(
    () => createGlassMaterial(quality, { wallThicknessM: profile.wallThicknessM, tintHex }),
    [quality, profile.wallThicknessM, tintHex],
  );

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  return <mesh geometry={geometry} material={material} />;
}
