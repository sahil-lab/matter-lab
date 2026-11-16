/**
 * Readable markings for a graduated vessel (primarily the burette): major/minor tick lines drawn
 * at the real height each reading sits at (`heightForReadingML`, the exact inverse of the function
 * the numeric reading itself uses — see `geometry/vesselProfile.ts`), plus an HTML label for every
 * major tick and a highlighted current-reading tag. `currentReadingML` must come from the same
 * authoritative volume the liquid body renders; this component only places a marker at it.
 */
import { Html } from '@react-three/drei';
import { useEffect, useMemo } from 'react';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import type { VesselProfile } from '../contracts';
import { heightForReadingML, radiusAtHeight } from '../geometry/vesselProfile';
import '../fluids.css';

export interface GraduationMarksProps {
  readonly profile: VesselProfile;
  readonly currentReadingML?: number;
  readonly tickColor?: string;
}

interface Tick {
  readonly heightM: number;
  readonly radiusM: number;
  readonly major: boolean;
  readonly label?: string;
}

const MAJOR_TICK_LENGTH_M = 0.006;
const MINOR_TICK_LENGTH_M = MAJOR_TICK_LENGTH_M * 0.55;
const LABEL_GAP_M = 0.003;

function buildTicks(profile: VesselProfile): Tick[] {
  const g = profile.graduation;
  if (!g || g.minorStepML <= 0 || g.majorStepML <= 0) return [];
  const lo = Math.min(g.minML, g.maxML);
  const hi = Math.max(g.minML, g.maxML);
  const steps = Math.round((hi - lo) / g.minorStepML);
  const ticks: Tick[] = [];
  for (let i = 0; i <= steps; i++) {
    const ml = lo + i * g.minorStepML;
    const majorMultiple = (ml - lo) / g.majorStepML;
    const isMajor = Math.abs(majorMultiple - Math.round(majorMultiple)) < 1e-6;
    const heightM = heightForReadingML(profile, ml);
    ticks.push({ heightM, radiusM: radiusAtHeight(profile.points, heightM), major: isMajor, label: isMajor ? Math.round(ml).toString() : undefined });
  }
  return ticks;
}

export function GraduationMarks({ profile, currentReadingML, tickColor = '#12161d' }: GraduationMarksProps) {
  const ticks = useMemo(() => buildTicks(profile), [profile]);

  const geometry = useMemo(() => {
    const positions: number[] = [];
    for (const tick of ticks) {
      const len = tick.major ? MAJOR_TICK_LENGTH_M : MINOR_TICK_LENGTH_M;
      positions.push(tick.radiusM, tick.heightM, 0, tick.radiusM + len, tick.heightM, 0);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(positions, 3));
    return g;
  }, [ticks]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  const highlight = useMemo(() => {
    if (currentReadingML === undefined || !profile.graduation) return null;
    const heightM = heightForReadingML(profile, currentReadingML);
    return { heightM, radiusM: radiusAtHeight(profile.points, heightM) };
  }, [profile, currentReadingML]);

  if (!profile.graduation || ticks.length === 0) return null;

  return (
    <group>
      <lineSegments geometry={geometry}>
        <lineBasicMaterial color={tickColor} toneMapped={false} />
      </lineSegments>
      {ticks
        .filter((t): t is Tick & { label: string } => t.label !== undefined)
        .map((t) => (
          <Html key={t.heightM} position={[t.radiusM + MAJOR_TICK_LENGTH_M + LABEL_GAP_M, t.heightM, 0]} style={{ transform: 'translate(0, -50%)' }}>
            <span className="fluids-tick-label__text">{t.label}</span>
          </Html>
        ))}
      {highlight && currentReadingML !== undefined && (
        <Html position={[highlight.radiusM + MAJOR_TICK_LENGTH_M + LABEL_GAP_M, highlight.heightM, 0]} style={{ transform: 'translate(0, -50%)' }} zIndexRange={[100, 0]}>
          <span className="fluids-tick-label__text fluids-tick-label__text--current" data-testid="fluids-current-reading">
            {currentReadingML.toFixed(2)} mL
          </span>
        </Html>
      )}
    </group>
  );
}
