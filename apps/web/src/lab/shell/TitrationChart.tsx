import { scaleLinear } from 'd3-scale';
import { line as d3line } from 'd3-shape';
import { useMemo } from 'react';
import { StatePanel } from '../../design-system';
import type { TitrationPoint } from './contracts';

const MARGIN = { top: 10, right: 14, bottom: 22, left: 28 };

/**
 * A small, purpose-built pH-vs-delivered-volume plot (shared contract §6, step 5: "plot titration
 * pH vs delivered mL"). Deliberately not a generic multi-series chart — it draws exactly the
 * titration curve, the model's equivalence point and the observed endpoint, all supplied as props.
 * It never computes pH or volume; it only lays out points it is given.
 */
export function TitrationChart({
  points,
  equivalenceVolumeL,
  endpointVolumeL,
  cursorVolumeL,
  height = 132,
}: {
  points: readonly TitrationPoint[];
  equivalenceVolumeL: number | null;
  endpointVolumeL: number | null;
  cursorVolumeL: number | null;
  height?: number;
}) {
  const width = 420;
  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = height - MARGIN.top - MARGIN.bottom;

  const maxVolumeL = useMemo(() => {
    const candidates = [...points.map((p) => p.volumeL), equivalenceVolumeL ?? 0, endpointVolumeL ?? 0, 0.001];
    return Math.max(...candidates) * 1.08;
  }, [points, equivalenceVolumeL, endpointVolumeL]);

  const x = useMemo(() => scaleLinear().domain([0, maxVolumeL * 1000]).range([0, innerW]), [maxVolumeL, innerW]);
  const y = useMemo(() => scaleLinear().domain([0, 14]).range([innerH, 0]), [innerH]);

  const path = useMemo(() => {
    const generator = d3line<TitrationPoint>()
      .x((p) => x(p.volumeL * 1000))
      .y((p) => y(p.ph));
    return generator([...points].sort((a, b) => a.volumeL - b.volumeL)) ?? '';
  }, [points, x, y]);

  if (points.length === 0) {
    return <StatePanel kind="empty" title="No titration curve yet" detail="Points appear here as the burette delivers titrant and Agent 06 reports pH observations." />;
  }

  const yTicks = [0, 7, 14];
  const xTicks = x.ticks(4);

  return (
    <svg className="astra-titchart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="pH against delivered volume">
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {yTicks.map((t) => (
          <g key={t} transform={`translate(0,${y(t)})`}>
            <line x1={0} x2={innerW} className="astra-titchart__grid" />
            <text x={-8} dy="0.32em" textAnchor="end" className="astra-titchart__tick">
              {t}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={innerH + 16} textAnchor="middle" className="astra-titchart__tick">
            {t}
          </text>
        ))}
        <text x={innerW / 2} y={innerH + 20} textAnchor="middle" className="astra-titchart__axislabel">
          delivered volume (mL)
        </text>
        {equivalenceVolumeL !== null && (
          <g>
            <line x1={x(equivalenceVolumeL * 1000)} x2={x(equivalenceVolumeL * 1000)} y1={0} y2={innerH} className="astra-titchart__equivalence" />
            <text x={x(equivalenceVolumeL * 1000)} y={-2} textAnchor="middle" className="astra-titchart__marklabel">
              equivalence
            </text>
          </g>
        )}
        {endpointVolumeL !== null &&
          (() => {
            // Only drawn once the curve has actually been revealed at this volume — never
            // invents a pH for the endpoint marker from a fallback value.
            const endpointPoint = points.find((p) => Math.abs(p.volumeL - endpointVolumeL) < 1e-6);
            return endpointPoint ? <circle cx={x(endpointVolumeL * 1000)} cy={y(endpointPoint.ph)} r={4} className="astra-titchart__endpoint" /> : null;
          })()}
        {cursorVolumeL !== null && <line x1={x(cursorVolumeL * 1000)} x2={x(cursorVolumeL * 1000)} y1={0} y2={innerH} className="astra-titchart__cursor" />}
        <path d={path} className="astra-titchart__line" fill="none" />
      </g>
    </svg>
  );
}
