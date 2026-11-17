/**
 * TEMPORARY PLACEHOLDER — not Agent 03's apparatus.
 *
 * Simple primitive geometry standing in for a stand + clamp + burette + flask assembly, sized
 * from `coordinates.REFERENCE_HEIGHTS_M`, so Agent 02's camera, lighting and multi-station work
 * can be judged against a plausible silhouette before Agent 03's real glTF apparatus definitions
 * exist. Dev/QA/screenshot use only: `LabWorld` never imports this, it has no apparatus id,
 * socket, capability or chemical state, and it must be replaced (not extended) once Agent 03's
 * definitions land.
 */
import { REFERENCE_HEIGHTS_M } from '../coordinates';

const GLASS = { color: '#dcefe8', roughness: 0.04, transmission: 0.92, thickness: 0.01, ior: 1.46, clearcoat: 0.6 } as const;
const METAL = { color: '#4b525c', metalness: 0.8, roughness: 0.3 } as const;

export function DevTitrationStub() {
  const h = REFERENCE_HEIGHTS_M;
  const rodX = -0.05;
  const vesselX = 0.04;

  return (
    <group name="dev-titration-stub-placeholder">
      <mesh position={[rodX, h.benchTop + h.standBase / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.18, h.standBase, 0.14]} />
        <meshStandardMaterial color="#363c44" metalness={0.65} roughness={0.4} />
      </mesh>

      <mesh position={[rodX, h.benchTop + h.standBase + h.standRod / 2, 0]} castShadow>
        <cylinderGeometry args={[0.009, 0.009, h.standRod, 16]} />
        <meshStandardMaterial {...METAL} />
      </mesh>

      <mesh position={[(rodX + vesselX) / 2, h.benchTop + h.clampHeight, 0]} castShadow>
        <boxGeometry args={[vesselX - rodX + 0.02, 0.028, 0.028]} />
        <meshStandardMaterial color="#5d6470" metalness={0.55} roughness={0.45} />
      </mesh>

      <mesh position={[vesselX, h.benchTop + h.clampHeight - h.buretteLength / 2 + 0.09, 0]} castShadow>
        <cylinderGeometry args={[0.009, 0.009, h.buretteLength, 24]} />
        <meshPhysicalMaterial {...GLASS} />
      </mesh>

      <mesh position={[vesselX, h.benchTop + h.flaskHeight / 2, 0.15]} castShadow receiveShadow>
        <coneGeometry args={[0.058, h.flaskHeight, 24]} />
        <meshPhysicalMaterial {...GLASS} />
      </mesh>
    </group>
  );
}
