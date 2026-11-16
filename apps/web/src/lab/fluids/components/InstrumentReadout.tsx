/**
 * A floating readout for a sensor/instrument (pH probe, thermometer, balance, ...), bound to a
 * single authoritative `Observation` (Agent 06/07). This component only formats and displays the
 * value it is given, including its evidence level — it never computes a reading itself.
 */
import { Html } from '@react-three/drei';
import type { Evidence, Observation } from '../contracts';
import { EVIDENCE_LABELS } from '../contracts';
import '../fluids.css';

export interface InstrumentReadoutProps {
  readonly observation: Observation | null | undefined;
  readonly position: readonly [number, number, number];
  readonly label?: string;
  readonly decimals?: number;
}

const EVIDENCE_BADGE_STYLE: Readonly<Record<Evidence, { readonly background: string; readonly color: string }>> = {
  REFERENCE_MEASURED: { background: '#1f8f6b', color: '#eafff5' },
  MODEL_CALCULATED: { background: '#2b7fb5', color: '#eaf6ff' },
  ILLUSTRATIVE: { background: '#5c6472', color: '#f1f3f6' },
  UNVERIFIED: { background: '#c98a1a', color: '#2b1b00' },
  UNSUPPORTED: { background: '#b5402b', color: '#ffecea' },
};

const TYPE_LABELS: Readonly<Record<Observation['type'], string>> = {
  PH: 'pH',
  TEMPERATURE: 'Temperature',
  VOLUME: 'Volume',
  CONCENTRATION: 'Concentration',
  INDICATOR: 'Indicator',
  MASS: 'Mass',
};

function formatQuantity(observation: Observation, decimals: number): string {
  const { value, unit, uncertainty } = observation.quantity;
  const uncertaintyText = uncertainty !== undefined ? ` \u00b1 ${uncertainty.toFixed(decimals)}` : '';
  return `${value.toFixed(decimals)}${uncertaintyText}${unit ? ` ${unit}` : ''}`;
}

export function InstrumentReadout({ observation, position, label, decimals = 2 }: InstrumentReadoutProps) {
  if (!observation) return null;
  const badge = EVIDENCE_BADGE_STYLE[observation.evidence];
  return (
    // `Html`'s own props besides `className`/`style`/`children` land on its Object3D wrapper, not
    // the DOM node (see @react-three/drei's Html.js) — so test hooks like `data-testid` go on this
    // inner element instead of on `<Html>` itself.
    <Html position={position} className="fluids-readout">
      <div data-testid="fluids-instrument-readout">
        <span className="fluids-readout__label">{label ?? TYPE_LABELS[observation.type]}</span>
        <span className="fluids-readout__value">{formatQuantity(observation, decimals)}</span>
        <span className="fluids-readout__evidence" style={{ background: badge.background, color: badge.color }}>
          {EVIDENCE_LABELS[observation.evidence]}
        </span>
      </div>
    </Html>
  );
}
