import { useLayoutEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  DynamicDrawUsage, Group, InstancedMesh, Mesh, Object3D, QuadraticBezierCurve3,
  SphereGeometry, TubeGeometry, Vector3,
} from 'three';
import type { MeshPhysicalMaterial } from 'three';
import type { UUID, Vec3M } from '@matterlab/contracts';
import { createLiquidMaterial } from './materials';
import { transferPathSupported, transferPointM } from './transfers';
import type { TransferPresentation } from './transfers';
import type { FluidScope, FluidVisualSettings } from './types';
import { useFluidSettings } from './useFluidSettings';

export interface TransferStreamProps {
  readonly presentation: TransferPresentation;
  readonly sourceInstanceId: UUID;
  readonly receiverInstanceId: UUID;
  readonly connectionId?: UUID;
  readonly sourceM: Vec3M;
  readonly receiverM: Vec3M;
  readonly scope: FluidScope;
  readonly settings?: FluidVisualSettings;
}

interface StreamModel {
  readonly drops: InstancedMesh;
  readonly ribbon: Mesh;
  readonly material: MeshPhysicalMaterial;
}

/** World-space, bounded rendering of accepted transfers. An open valve is never an input. */
export function TransferStream({
  presentation, sourceInstanceId, receiverInstanceId, connectionId, sourceM, receiverM, scope, settings,
}: TransferStreamProps) {
  const quality = useFluidSettings(settings);
  const root = useRef<Group>(null);
  const model = useRef<StreamModel | null>(null);
  const dummy = useRef(new Object3D());
  const wasSuppressed = useRef(false);
  const invalidate = useThree((state) => state.invalidate);
  const supported = transferPathSupported(sourceM, receiverM);
  const [sx, sy, sz] = sourceM;
  const [rx, ry, rz] = receiverM;

  useLayoutEffect(() => {
    if (!supported) return;
    const parent = root.current!;
    const sphere = new SphereGeometry(1, quality.quality === 'low' ? 8 : 12, quality.quality === 'low' ? 6 : 8);
    const material = createLiquidMaterial(quality, { colorSrgb: [1, 1, 1], opacity: 0.55, evidence: 'ILLUSTRATIVE' });
    const drops = new InstancedMesh(sphere, material, Math.max(1, quality.maxDroplets));
    drops.instanceMatrix.setUsage(DynamicDrawUsage);
    drops.count = 0;
    drops.frustumCulled = false;
    drops.raycast = () => {};
    drops.renderOrder = 12;
    const path = new QuadraticBezierCurve3(
      new Vector3(sx, sy, sz), new Vector3((sx + rx) / 2, sy, (sz + rz) / 2), new Vector3(rx, ry, rz),
    );
    const tube = new TubeGeometry(path, 8, 0.0007, 6, false);
    const ribbon = new Mesh(tube, material);
    ribbon.visible = false;
    ribbon.raycast = () => {};
    ribbon.renderOrder = 12;
    parent.add(drops, ribbon);
    model.current = { drops, ribbon, material };
    invalidate();
    return () => {
      parent.remove(drops, ribbon);
      model.current = null;
      drops.dispose();
      sphere.dispose();
      tube.dispose();
      material.dispose();
    };
  }, [supported, sx, sy, sz, rx, ry, rz, quality, invalidate]);

  useLayoutEffect(() => {
    const suppressed = !supported || quality.reducedMotion || !quality.enabled || scope.status !== 'RUNNING';
    if (suppressed || wasSuppressed.current) presentation.clearLink(sourceInstanceId, receiverInstanceId);
    wasSuppressed.current = suppressed;
    if (model.current) {
      model.current.drops.count = 0;
      model.current.ribbon.visible = false;
    }
    invalidate();
  }, [presentation, sourceInstanceId, receiverInstanceId, supported, quality, scope, invalidate]);

  useFrame(() => {
    const current = model.current;
    if (!current) return;
    const sample = presentation.sample({
      sourceInstanceId, receiverInstanceId, connectionId, scope, settings: quality,
    });
    current.drops.count = sample.drops.length;
    for (let i = 0; i < sample.drops.length; i++) {
      const drop = sample.drops[i]!;
      const point = transferPointM(sourceM, receiverM, drop.fraction);
      dummy.current.position.set(...point);
      dummy.current.scale.set(drop.radiusM, drop.radiusM * (1.15 + drop.fraction * 0.3), drop.radiusM);
      dummy.current.updateMatrix();
      current.drops.setMatrixAt(i, dummy.current.matrix);
    }
    if (sample.drops.length > 0) current.drops.instanceMatrix.needsUpdate = true;
    current.ribbon.visible = sample.pouring;
    if (sample.acceptedVolumeL > 0) invalidate();
  });

  return <group ref={root} name={`accepted-transfer:${sourceInstanceId}:${receiverInstanceId}`} dispose={null}
    userData={{ units: 'm', evidence: 'ILLUSTRATIVE', pathSupported: supported }} />;
}
