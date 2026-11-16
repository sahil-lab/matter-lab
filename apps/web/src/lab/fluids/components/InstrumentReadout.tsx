/**
 * A floating readout for a sensor/instrument (pH probe, thermometer, balance, ...), bound to a
 * single authoritative `Observation` (Agent 06/07). This component only formats and displays the
 * value it is given, including its evidence level — it never computes a reading itself. Rendered as
 * a billboarded text sprite (see `TextSprite`/`materials/textSprite.ts`), not drei's `<Html>`.
 */
import type { Evidence, Observation } from '../contracts';
import { EVIDENCE_LABELS } from '../contracts';
import { TextSprite } from './TextSprite';

export interface InstrumentReadoutProps {
  readonly observation: Observation | null | undefined;
  readonly position: readonly [number, number, number];
  readonly label?: string;
  readonly decimals?: number;
}

/** Text color coding the evidence level carries, mirroring the badge colors the brief asks every shown value to carry. */
const EVIDENCE_TEXT_COLOR: Readonly<Record<Evidence, string>> = {
  REFERENCE_MEASURED: '#5fe3b3',
  MODEL_CALCULATED: '#7ec3f2',
  ILLUSTRATIVE: '#c7cdd6',
  UNVERIFIED: '#f0b84a',
  UNSUPPORTED: '#f2897a',
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
  return (
    <TextSprite
      position={position}
      anchor={[0.5, 0]}
      pixelsPerMeter={4200}
      backgroundColor="rgba(8, 13, 24, 0.68)"
      lines={[
        { text: label ?? TYPE_LABELS[observation.type], color: '#9fb1c4', fontWeight: 500 },
        { text: formatQuantity(observation, decimals), color: '#ffffff', fontWeight: 700 },
        { text: EVIDENCE_LABELS[observation.evidence], color: EVIDENCE_TEXT_COLOR[observation.evidence], fontWeight: 600 },
      ]}
    />
  );
}
