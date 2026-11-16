import type { RoomConfiguration } from './RoomConfig';
import { LabDistanceLOD } from './SceneQuality';

/** Original storage/architectural furniture, deliberately NOT working benches or apparatus. */
export default function RoomFurnishings({ room }: { room: RoomConfiguration }) {
  const back = -room.depthM / 2 + 0.24;
  return (
    <group name="room-storage-and-light-fixtures">
      {[-1, 1].map((side) => (
        <group key={side} position={[side * (room.widthM / 2 - 0.8), 0, back]}>
          <mesh castShadow receiveShadow position={[0, 1.05, 0]}>
            <boxGeometry args={[1.08, 2.1, 0.4]} />
            <meshStandardMaterial color="#203635" metalness={0.25} roughness={0.6} />
          </mesh>
          <LabDistanceLOD near={(
            <group>
              {[-0.255, 0.255].map((x) => (
                <group key={x}>
                  <mesh position={[x, 1.12, 0.205]}>
                    <boxGeometry args={[0.495, 1.88, 0.014]} />
                    <meshStandardMaterial color="#3c504b" metalness={0.18} roughness={0.55} />
                  </mesh>
                  <mesh position={[x - Math.sign(x) * 0.16, 1.12, 0.23]}>
                    <boxGeometry args={[0.012, 0.32, 0.025]} />
                    <meshStandardMaterial color="#a29c81" metalness={0.75} roughness={0.3} />
                  </mesh>
                </group>
              ))}
            </group>
          )} />
        </group>
      ))}
      {[-1.55, 1.55].map((x) => (
        <group key={x} position={[x, room.heightM - 0.18, -0.1]}>
          <mesh>
            <boxGeometry args={[1.8, 0.04, 0.34]} />
            <meshStandardMaterial color="#304b46" metalness={0.6} roughness={0.4} />
          </mesh>
          <mesh position={[0, -0.025, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <planeGeometry args={[1.68, 0.26]} />
            <meshBasicMaterial color="#e7eee0" toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
