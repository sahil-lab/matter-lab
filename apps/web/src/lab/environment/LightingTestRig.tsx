/**
 * A calibration rig for Agent 05: a mirror sphere, a glass sphere and a matte diffuse sphere under
 * the active lighting, so glass/fluid materials can be judged against a known reference instead of
 * guesswork. Dev/QA aid, not part of the production scene — `LabWorld` only mounts it when asked.
 */
import { REFERENCE_HEIGHTS_M } from './coordinates';

export interface LightingTestRigProps {
  readonly visible: boolean;
  /** Height (metres) of the rig's centre line; defaults to resting on the workbench. */
  readonly originY?: number;
}

const SPHERE_RADIUS_M = 0.05;
const SPACING_M = 0.16;

export function LightingTestRig({ visible, originY }: LightingTestRigProps) {
  if (!visible) return null;
  const y = (originY ?? REFERENCE_HEIGHTS_M.benchTop) + SPHERE_RADIUS_M + 0.002;

  return (
    <group position={[0, y, 0]} name="lighting-test-rig">
      {/* Mirror: shows the environment reflection directly, with no material confusion. */}
      <mesh position={[-SPACING_M, 0, 0]} castShadow>
        <sphereGeometry args={[SPHERE_RADIUS_M, 48, 32]} />
        <meshStandardMaterial color="#ffffff" roughness={0.02} metalness={1} />
      </mesh>
      {/* Glass: transmissive + a touch of clearcoat, the same family of material Agent 05's vessels use. */}
      <mesh position={[0, 0, 0]} castShadow>
        <sphereGeometry args={[SPHERE_RADIUS_M, 48, 32]} />
        <meshPhysicalMaterial color="#ffffff" roughness={0.04} metalness={0} transmission={1} thickness={0.08} ior={1.5} clearcoat={1} envMapIntensity={1.1} />
      </mesh>
      {/* Matte diffuse: a neutral grey reference unaffected by reflections, for judging light colour/intensity alone. */}
      <mesh position={[SPACING_M, 0, 0]} castShadow>
        <sphereGeometry args={[SPHERE_RADIUS_M, 48, 32]} />
        <meshStandardMaterial color="#9aa0a8" roughness={1} metalness={0} />
      </mesh>
    </group>
  );
}
