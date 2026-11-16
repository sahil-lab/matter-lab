/**
 * Renders the shared vertical slice's apparatus (shared contract §6 steps 1-2) as a group of
 * `ApparatusMesh`es, positioned by `buildVerticalSliceAssembly`. This component only needs a
 * `<Canvas>` and some lighting around it — see `ApparatusShowcaseApp.tsx` for the standalone demo
 * page, or mount it directly inside Agent 02's real environment for a quick integration check.
 *
 * Two things here are explicitly *not* part of the reusable `lab/apparatus` API: the illustrative
 * liquid discs (Agent 05 owns the real fluid/glass shaders) and the demo's socket-status overlay
 * (Agent 04 owns real hover/drag detection). Both are labeled as such in the rendered UI.
 */
import { useMemo } from 'react';
import { Environment, Lightformer } from '@react-three/drei';
import { DoubleSide, Shape } from 'three';
import { ApparatusMesh } from '../components';
import { buildVerticalSliceAssembly } from './sceneAssembly';
import type { ApparatusDefinition, Transform } from '../types';

/** A demo-only stand-in for Agent 05's real liquid shader: a flat tinted disc at the declared fill
 * height for a given volume, purely to prove `ContainerSpec.fillLevelForVolume` and the rendered
 * glass agree with each other. ILLUSTRATIVE — never used outside this demo. */
function IllustrativeLiquidSurface({ definition, volumeL, color }: { definition: ApparatusDefinition; volumeL: number; color: string }) {
  const shape = useMemo(() => {
    const container = definition.container;
    if (!container) return null;
    const { heightM, surfaceRadiusM } = container.fillLevelForVolume(volumeL);
    const s = new Shape();
    s.absarc(0, 0, Math.max(surfaceRadiusM, 0.001), 0, Math.PI * 2, false);
    return { heightM, s };
  }, [definition, volumeL]);
  if (!shape) return null;
  return (
    <group position={[0, shape.heightM, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <mesh renderOrder={5}>
        <shapeGeometry args={[shape.s]} />
        <meshPhysicalMaterial color={color} transparent opacity={0.75} roughness={0.15} metalness={0} side={DoubleSide} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

function Floor() {
  // A plain neutral ground plane — Agent 02 owns the real room/environment and coordinate space.
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
      <planeGeometry args={[6, 6]} />
      <meshStandardMaterial color="#1b2430" roughness={0.9} />
    </mesh>
  );
}

export interface ApparatusShowcaseSceneProps {
  /** 0..1 demo-only valve openness driving the stopcock key's rotation, purely visual. */
  readonly valveOpenFraction?: number;
  /** 0..1 demo-only stir speed driving the stirrer knob's rotation, purely visual. */
  readonly stirrerSpeedFraction?: number;
  readonly showSockets?: boolean;
  /** Which instance ids get socket highlight rings when `showSockets` is on — every instance has
   * sockets, but showing all of them at once (including the bench's whole-tabletop surface ring)
   * clutters the view more than it clarifies. Defaults to the stand\u2192clamp\u2192burette chain
   * the brief's worked example is about. */
  readonly highlightedInstanceIds?: readonly string[];
}

const DEFAULT_HIGHLIGHTED_INSTANCES: readonly string[] = ['stand', 'clamp', 'burette'];

export function ApparatusShowcaseScene({
  valveOpenFraction = 0.35,
  stirrerSpeedFraction = 0.6,
  showSockets = true,
  highlightedInstanceIds = DEFAULT_HIGHLIGHTED_INSTANCES,
}: ApparatusShowcaseSceneProps) {
  const assembly = useMemo(() => buildVerticalSliceAssembly(), []);
  const byId = useMemo(() => new Map(assembly.instances.map((i) => [i.id, i])), [assembly]);
  const highlighted = useMemo(() => new Set(highlightedInstanceIds), [highlightedInstanceIds]);

  const buretteTransform: Transform = byId.get('burette')!.transform;
  const flaskTransform: Transform = byId.get('flask')!.transform;

  return (
    <>
      <hemisphereLight args={['#cfe3ff', '#0a0f16', 0.55]} />
      <directionalLight position={[2.5, 4, 2]} intensity={1.6} castShadow />
      <Floor />
      {/* A minimal, fully procedural environment (no external HDR fetch) so the provisional
       * MeshPhysicalMaterial glass has *something* to transmit/reflect — without it, `transmission`
       * renders as a flat, foggy white rather than anything glass-like. */}
      <Environment resolution={64} frames={1} background={false}>
        <color attach="background" args={['#05080e']} />
        <Lightformer form="rect" intensity={2.2} color="#e6f0ff" position={[-3, 4, 3]} scale={[4, 3, 1]} target={[0, 1, 0]} />
        <Lightformer form="rect" intensity={1.1} color="#a6d6ff" position={[3, 1, 2]} scale={[3, 4, 1]} target={[0, 1, 0]} />
        <Lightformer form="ring" intensity={1} color="#55e2d1" position={[0, -3, -1]} scale={3} target={[0, 1, 0]} />
      </Environment>

      {assembly.instances.map((instance) => (
        <ApparatusMesh
          key={instance.id}
          definition={instance.definition}
          transform={instance.transform}
          showSockets={showSockets && highlighted.has(instance.id)}
          socketStatus={() => 'valid'}
          partSpin={
            instance.id === 'burette'
              ? { 'stopcock-key': valveOpenFraction * (Math.PI / 2) }
              : instance.id === 'stirrer'
                ? { 'stirrer-knob': stirrerSpeedFraction * (Math.PI / 2) }
                : undefined
          }
        />
      ))}

      {/* Demo-only, ILLUSTRATIVE fill verification — not Agent 05's real liquid renderer. */}
      <group position={buretteTransform.positionM} quaternion={buretteTransform.quaternion}>
        <IllustrativeLiquidSurface definition={byId.get('burette')!.definition} volumeL={0.032} color="#f6a6c1" />
      </group>
      <group position={flaskTransform.positionM} quaternion={flaskTransform.quaternion}>
        <IllustrativeLiquidSurface definition={byId.get('flask')!.definition} volumeL={0.025} color="#bfe6c8" />
      </group>
    </>
  );
}
