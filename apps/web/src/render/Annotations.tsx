import { measurePoints } from '@matterlab/core';
import type { Vec3 } from '@matterlab/core';
import { Html, Line } from '@react-three/drei';
import { useLab } from '../state/store';

/** Formats a measurement the way it is shown everywhere in the app. */
export function formatMeasurement(value: number, unit: 'Å' | '°'): string {
  return unit === 'Å' ? `${value.toFixed(3)} Å` : `${value.toFixed(1)}°`;
}

const BISECTOR_OFFSET = 0.8;

/**
 * Where a measurement's label sits: mid-bond for a distance, inside the angle (a short way along
 * its bisector) for an angle, mid-axis for a dihedral. Distances are nudged up and dihedrals down
 * on screen, so labels that share a bond do not sit on top of each other.
 */
function labelPlacement(points: readonly Vec3[]): { anchor: Vec3; shift: number } {
  if (points.length === 3) {
    const [a, b, c] = points as [Vec3, Vec3, Vec3];
    const unit = (from: Vec3, to: Vec3): Vec3 => {
      const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
      const length = Math.hypot(d[0], d[1], d[2]) || 1;
      return [d[0] / length, d[1] / length, d[2] / length];
    };
    const u = unit(b, a);
    const v = unit(b, c);
    const bisector: Vec3 = [u[0] + v[0], u[1] + v[1], u[2] + v[2]];
    const length = Math.hypot(bisector[0], bisector[1], bisector[2]);
    // A straight angle has no bisector; the label then sits on the vertex.
    if (length < 1e-3) return { anchor: b, shift: 14 };
    const k = BISECTOR_OFFSET / length;
    return { anchor: [b[0] + bisector[0] * k, b[1] + bisector[1] * k, b[2] + bisector[2] * k], shift: 0 };
  }
  const [p, q] = points.length === 4 ? [points[1]!, points[2]!] : [points[0]!, points[1]!];
  return { anchor: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2], shift: points.length === 4 ? 13 : -13 };
}

/** Measurement overlays: a dashed line through the measured atoms and a label with the value. */
export function Annotations() {
  const measurements = useLab((s) => s.measurements);
  const scene = useLab((s) => s.scene);

  return (
    <>
      {measurements.map((m) => {
        const points: Vec3[] = [];
        for (const id of m.atoms) {
          const atom = scene.atoms.get(id);
          if (atom) points.push(atom.position);
        }
        const result = points.length === m.atoms.length ? measurePoints(points) : null;
        if (!result) return null;
        const { anchor, shift } = labelPlacement(points);
        return (
          <group key={m.id}>
            <Line
              points={points as Vec3[] as [number, number, number][]}
              color="#ffb66b"
              lineWidth={1.6}
              dashed
              dashSize={0.14}
              gapSize={0.09}
              depthTest={false}
              transparent
              opacity={0.95}
              renderOrder={20}
              toneMapped={false}
            />
            <Html position={anchor as [number, number, number]} center zIndexRange={[4, 0]} style={{ pointerEvents: 'none' }}>
              <div className="ml-tag" style={shift ? { transform: `translateY(${shift}px)` } : undefined}>
                {formatMeasurement(result.value, result.unit)}
              </div>
            </Html>
          </group>
        );
      })}
    </>
  );
}
