/**
 * Visible droplets falling from a stopcock tip to a receiving vessel, driven entirely by Agent 07's
 * authoritative `FluidOutflow.flowRateMlPerS`. This component never invents a flow rate: at exactly
 * zero (closed valve, paused run, finished transfer) it spawns nothing, and `resetSignal` lets a
 * caller clear every in-flight drop immediately on an explicit RESET action (a flow rate that drops
 * to zero on its own instead lets any already-falling drops land naturally).
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Color, InstancedMesh, MeshPhysicalMaterial, Object3D, SphereGeometry } from 'three';
import type { FluidOutflow } from '../contracts';
import { INITIAL_DROPLET_SPAWN_STATE, advanceDropletSpawn, dropletFallDurationS, dropletPositionAt } from '../flow/dropletTiming';
import type { DropletSpawnState } from '../flow/dropletTiming';
import type { FluidQualitySettings } from '../quality/fluidQuality';

export interface DropletStreamProps {
  readonly outflow: FluidOutflow | null | undefined;
  readonly colorHex: string;
  readonly quality: FluidQualitySettings;
  /** Bump this (e.g. an incrementing counter) to instantly clear every in-flight droplet on a RESET action. */
  readonly resetSignal?: number;
}

interface ActiveDrop {
  readonly spawnedAt: number;
  readonly fromPointM: readonly [number, number, number];
  readonly toPointM: readonly [number, number, number];
  readonly durationS: number;
}

const DROP_RADIUS_M = 0.0013;

export function DropletStream({ outflow, colorHex, quality, resetSignal }: DropletStreamProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const drops = useRef<ActiveDrop[]>([]);
  const spawnState = useRef<DropletSpawnState>(INITIAL_DROPLET_SPAWN_STATE);
  const dummy = useMemo(() => new Object3D(), []);

  const geometry = useMemo(() => new SphereGeometry(DROP_RADIUS_M, 10, 8), []);
  const material = useMemo(
    () =>
      new MeshPhysicalMaterial({
        color: new Color(colorHex),
        roughness: 0.05,
        metalness: 0,
        transmission: quality.liquidTransmission ? 0.7 : 0,
        transparent: true,
        opacity: quality.liquidTransmission ? 1 : 0.85,
        depthWrite: false,
      }),
    [quality.liquidTransmission], // eslint-disable-line react-hooks/exhaustive-deps -- color updates are applied in place below, not by rebuilding the material.
  );

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => {
    material.color.set(colorHex);
  }, [material, colorHex]);

  useEffect(() => {
    drops.current = [];
    spawnState.current = INITIAL_DROPLET_SPAWN_STATE;
    const mesh = meshRef.current;
    if (mesh) mesh.count = 0;
  }, [resetSignal]);

  useFrame(({ clock }, delta) => {
    const flowRateMlPerS = outflow?.flowRateMlPerS ?? 0;
    if (outflow && flowRateMlPerS > 0) {
      const { state, dropsSpawned } = advanceDropletSpawn(spawnState.current, flowRateMlPerS, delta);
      spawnState.current = state;
      for (let i = 0; i < dropsSpawned && drops.current.length < quality.maxDroplets; i++) {
        drops.current.push({
          spawnedAt: clock.elapsedTime,
          fromPointM: outflow.fromPointM,
          toPointM: outflow.toPointM,
          durationS: dropletFallDurationS(outflow.fromPointM, outflow.toPointM),
        });
      }
    } else {
      spawnState.current = INITIAL_DROPLET_SPAWN_STATE;
    }

    drops.current = drops.current.filter((drop) => clock.elapsedTime - drop.spawnedAt <= drop.durationS);

    const mesh = meshRef.current;
    if (!mesh) return;
    const count = Math.min(drops.current.length, quality.maxDroplets);
    for (let i = 0; i < count; i++) {
      const drop = drops.current[i]!;
      const age = clock.elapsedTime - drop.spawnedAt;
      const [x, y, z] = dropletPositionAt(drop.fromPointM, drop.toPointM, age, drop.durationS);
      dummy.position.set(x, y, z);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
  });

  return <instancedMesh ref={meshRef} args={[geometry, material, quality.maxDroplets]} frustumCulled={false} />;
}
