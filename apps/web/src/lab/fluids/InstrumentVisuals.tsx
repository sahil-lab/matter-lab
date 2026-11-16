import { useLayoutEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { BufferGeometry, Group, LineBasicMaterial, LineSegments, Vector3 } from 'three';
import type { Vec3M, VesselCalibration } from '@matterlab/contracts';
import { calibratedGraduations } from './calibration';
import { formatInstrumentReading } from './observations';
import type { InstrumentReading, VesselReadings } from './observations';

const overlayStyle: CSSProperties = {
  display: 'grid', gap: '0.2rem', minWidth: '7rem', padding: '0.5rem 0.65rem',
  color: '#e8f4f3', background: 'rgba(12,24,30,0.92)', border: '1px solid #577575',
  borderRadius: '0.4rem', fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem',
  lineHeight: 1.4, pointerEvents: 'none', fontVariantNumeric: 'tabular-nums',
};

export function InstrumentOverlay({ reading }: { readonly reading: InstrumentReading }) {
  const observation = reading.record?.observation;
  return (
    <output className="lab-fluid-instrument" style={overlayStyle}
      aria-label={`${reading.label}: ${formatInstrumentReading(reading)}`}
      data-status={reading.status} data-evidence={observation?.evidence ?? 'UNSUPPORTED'}>
      <span>{reading.label}</span>
      <strong>{formatInstrumentReading(reading)}</strong>
      {reading.status === 'READY' && observation
        ? <small>{observation.evidence} · {observation.timeS.toFixed(2)} s<br />{observation.methodId}</small>
        : <small>{reading.reason ?? 'No current observation'}</small>}
    </output>
  );
}

export function InstrumentLabel({ reading, positionM }: {
  readonly reading: InstrumentReading;
  readonly positionM: Vec3M;
}) {
  return <Html position={[...positionM]} center zIndexRange={[8, 0]} style={{ pointerEvents: 'none' }}>
    <InstrumentOverlay reading={reading} />
  </Html>;
}

export function VesselVolumeOverlay({ readings }: { readonly readings: VesselReadings }) {
  return <output className="lab-fluid-volume" style={overlayStyle} aria-label="Authoritative liquid inventory">
    <span>{readings.remainingL === undefined ? 'Remaining —' : `Remaining ${(readings.remainingL * 1000).toFixed(2)} mL`}</span>
    {readings.deliveredL !== undefined && <span>Delivered {(readings.deliveredL * 1000).toFixed(2)} mL</span>}
    {readings.nominalScaleL !== undefined && readings.scaleReading === 'DELIVERED' &&
      <small>Nominal scale {(readings.nominalScaleL * 1000).toFixed(2)} mL<br />Scale zero assumes a full initial burette.</small>}
  </output>;
}

/** One local tick-mark mesh, not 501 draw calls. Optional: do not add it if the shell already has markings. */
export function VesselGraduations({ calibration }: { readonly calibration: VesselCalibration }) {
  const root = useRef<Group>(null);
  const marks = useMemo(() => calibratedGraduations(calibration), [calibration]);
  const invalidate = useThree((state) => state.invalidate);
  useLayoutEffect(() => {
    if (!marks.length) return;
    const parent = root.current!;
    const points: Vector3[] = [];
    for (const mark of marks) {
      const halfAngle = mark.major ? 0.6 : 0.32;
      const radius = mark.radiusM + 0.0003;
      for (let segment = 0; segment < 3; segment++) {
        for (const step of [segment, segment + 1]) {
          const angle = Math.PI / 2 - halfAngle + step / 3 * halfAngle * 2;
          points.push(new Vector3(radius * Math.cos(angle), mark.heightM, radius * Math.sin(angle)));
        }
      }
    }
    const geometry = new BufferGeometry().setFromPoints(points);
    const material = new LineBasicMaterial({ color: '#68858c', transparent: true, opacity: 0.9, depthWrite: false });
    const lines = new LineSegments(geometry, material);
    lines.name = 'calibrated-graduations';
    lines.renderOrder = 30;
    lines.raycast = () => {};
    parent.add(lines);
    invalidate();
    return () => { parent.remove(lines); geometry.dispose(); material.dispose(); };
  }, [marks, invalidate]);
  return <group ref={root} dispose={null} userData={{ units: 'm', evidence: calibration.evidence }} />;
}
