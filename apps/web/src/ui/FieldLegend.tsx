import type { ReactNode } from 'react';
import { DENSITY_SCALE, orbitalLabel, quantumIsCurrent, useQuantum } from '../compute/quantum';
import type { SliceScale } from '../compute/quantum';
import { DENSITY_COLOR, PHASE_NEGATIVE, PHASE_POSITIVE, SCALE_DENSITY, SCALE_PHASE, SCALE_POTENTIAL, SCALE_POTENTIAL_PLANE, displayColor, hexToRgb, rgbToCss, scaleGradient } from '../render/colormap';
import type { ColorScale } from '../render/colormap';
import { useLab } from '../state/store';
import { EvidenceBadge } from './kit';

export const UNIT_DENSITY = (
  <>
    e/a<sub>0</sub>
    <sup>3</sup>
  </>
);
export const UNIT_ORBITAL = (
  <>
    a<sub>0</sub>
    <sup>−3/2</sup>
  </>
);
export const UNIT_POTENTIAL = (
  <>
    E<sub>h</sub>/e
  </>
);

/** A number for a legend: at most `digits` significant figures, with a true minus sign. */
export function legendNumber(value: number, digits = 2): string {
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  const text = magnitude >= 1e-3 && magnitude < 1e4 ? String(Number(value.toPrecision(digits))) : value.toExponential(Math.max(0, digits - 1)).replace('e-', '×10⁻').replace('e+', '×10');
  return text.replace('-', '−');
}

/** The colour a surface of this base colour has on screen where it faces the light. */
const swatch = (hex: string): string => rgbToCss(displayColor(hexToRgb(hex)));

function Swatch({ color, round }: { color: string; round?: boolean }) {
  return <i className="ml-swatch" data-round={round} style={{ background: swatch(color) }} />;
}

interface Tick {
  /** Position on the scale, 0..1. */
  readonly at: number;
  readonly label: string;
}

/** A colour scale with its values written under it. The colours are the ones the 3D view displays. */
function ScaleStrip({ scale, ticks, unit, testId }: { scale: ColorScale; ticks: readonly Tick[]; unit: ReactNode; testId: string }) {
  return (
    <span className="ml-scalestrip" data-testid={testId} data-scale={scale.id}>
      <span className="ml-scalestrip__bar" style={{ background: scaleGradient(scale) }}>
        {ticks.map((tick) => (
          <i key={tick.at} style={{ left: `${tick.at * 100}%` }} />
        ))}
      </span>
      <span className="ml-scalestrip__ticks ml-mono">
        {ticks.map((tick) => (
          <b key={tick.at} style={{ left: `${tick.at * 100}%` }} data-edge={tick.at === 0 ? 'start' : tick.at === 1 ? 'end' : undefined}>
            {tick.label}
          </b>
        ))}
      </span>
      <em className="ml-scalestrip__unit">{unit}</em>
    </span>
  );
}

function ticksFor(scale: SliceScale): Tick[] {
  if (scale.kind === 'symmetric') {
    return [
      { at: 0, label: `≤ ${legendNumber(-scale.range)}` },
      { at: 0.5, label: '0' },
      { at: 1, label: `≥ ${legendNumber(scale.range)}` },
    ];
  }
  const low = Math.log10(scale.low);
  const span = Math.log10(scale.high) - low;
  const last = Math.floor(low + span);
  const ticks: Tick[] = [];
  // Below the low end nothing is drawn; everything above the high end takes its colour.
  for (let exponent = Math.ceil(low); exponent <= last; exponent++) {
    ticks.push({ at: (exponent - low) / span, label: `${exponent === last ? '≥ ' : ''}${legendNumber(10 ** exponent, 1)}` });
  }
  return ticks;
}

/**
 * What the computed fields on stage mean: which quantity, at which value, in which unit and
 * colour, and how it was obtained. Shown between the top bars whenever a field is on stage.
 */
export function FieldLegend() {
  const scene = useLab((s) => s.scene);
  const record = useQuantum((s) => s.record);
  const field = useQuantum((s) => s.field);
  const info = useQuantum((s) => s.fieldInfo);
  const sliceInfo = useQuantum((s) => s.sliceInfo);
  const sliceOn = useQuantum((s) => s.slice.enabled);
  const molecular = useQuantum((s) => s.molecular);
  const molecularInfo = useQuantum((s) => s.molecularInfo);
  const current = quantumIsCurrent(record, scene);

  const showField = current && info !== null && field.kind === info.kind;
  const showSlice = current && sliceOn && sliceInfo !== null;
  const showMolecular = molecular.enabled && molecularInfo !== null && molecularInfo.kind === molecular.kind;
  if (!showField && !showSlice && !showMolecular) return null;

  const orbitalName = (index: number) => `Orbital ${index + 1} · ${orbitalLabel(record!.result, index)}`;

  return (
    <div className="ml-panel ml-legend ml-legend--fields" data-testid="field-legend">
      {showField && (
        <div className="ml-legend__row" data-testid="legend-field">
          <EvidenceBadge level="computed" tipPos="bottom" />
          {info.kind === 'orbital' && info.style === 'surface' && (
            <>
              <span className="ml-legend__name">{orbitalName(info.orbital!)}</span>
              <span className="ml-legend__key">
                <Swatch color={PHASE_POSITIVE} /> ψ = +{legendNumber(info.isoValue!)}
              </span>
              <span className="ml-legend__key">
                <Swatch color={PHASE_NEGATIVE} /> ψ = −{legendNumber(info.isoValue!)}
              </span>
              <em className="ml-legend__unit">{UNIT_ORBITAL}</em>
            </>
          )}
          {info.kind === 'orbital' && info.style === 'cloud' && (
            <>
              <span className="ml-legend__name">{orbitalName(info.orbital!)}</span>
              <span className="ml-legend__key">
                <Swatch color={PHASE_POSITIVE} round /> ψ &gt; 0
              </span>
              <span className="ml-legend__key">
                <Swatch color={PHASE_NEGATIVE} round /> ψ &lt; 0
              </span>
              <span className="ml-legend__key">{info.dots!.toLocaleString('en-US')} dots drawn from |ψ|²</span>
            </>
          )}
          {info.kind === 'density' && info.style === 'surface' && (
            <>
              <span className="ml-legend__name">Electron density</span>
              <span className="ml-legend__key">
                <Swatch color={DENSITY_COLOR} /> ρ = {legendNumber(info.isoValue!)}
              </span>
              <em className="ml-legend__unit">{UNIT_DENSITY}</em>
            </>
          )}
          {info.kind === 'density' && info.style === 'cloud' && (
            <>
              <span className="ml-legend__name">Electron density</span>
              <span className="ml-legend__key">
                <Swatch color={DENSITY_COLOR} round /> {info.dots!.toLocaleString('en-US')} dots, {legendNumber(info.captured! / Math.max(1, info.dots!))} e each
              </span>
            </>
          )}
          {info.kind === 'potential' && (
            <>
              <span className="ml-legend__name">
                Electrostatic potential on ρ = {legendNumber(info.isoValue!)} {UNIT_DENSITY}
              </span>
              <ScaleStrip scale={SCALE_POTENTIAL} ticks={ticksFor({ kind: 'symmetric', range: info.potentialRange! })} unit={UNIT_POTENTIAL} testId="legend-potential-scale" />
            </>
          )}
        </div>
      )}
      {showSlice && (
        <div className="ml-legend__row" data-testid="legend-plane">
          <EvidenceBadge level="computed" tipPos="bottom" />
          <span className="ml-legend__name">
            Plane · {sliceInfo.field === 'density' ? 'electron density' : sliceInfo.field === 'orbital' ? orbitalName(sliceInfo.orbital!).toLowerCase() : 'electrostatic potential'}
          </span>
          <ScaleStrip
            scale={sliceInfo.field === 'density' ? SCALE_DENSITY : sliceInfo.field === 'orbital' ? SCALE_PHASE : SCALE_POTENTIAL_PLANE}
            ticks={ticksFor(sliceInfo.field === 'density' ? { kind: 'log', ...DENSITY_SCALE } : sliceInfo.scale)}
            unit={sliceInfo.field === 'density' ? UNIT_DENSITY : sliceInfo.field === 'orbital' ? UNIT_ORBITAL : UNIT_POTENTIAL}
            testId="legend-plane-scale"
          />
        </div>
      )}
      {showMolecular && (
        <div className="ml-legend__row" data-testid="legend-molecular">
          <EvidenceBadge level="rule-based" tipPos="bottom" />
          <span className="ml-legend__name">{molecularInfo.kind === 'sas' ? 'Solvent-accessible surface' : 'Van der Waals surface'}</span>
          <span className="ml-legend__key">{molecular.coloring === 'element' ? 'coloured by the element underneath' : 'one colour'}</span>
        </div>
      )}
      {(showField || showSlice) && (
        <div className="ml-legend__note">
          Hartree–Fock with a minimal basis (RHF/STO-3G), computed in this browser for the geometry shown.
          {showSlice ? ' The plane is unshaded, so its colours are exactly those of its scale; it is left out where the field is negligible.' : ''}
          {showField && info.kind === 'potential' ? ' Lighting varies the brightness of the surface; the hue carries the value.' : ''}
        </div>
      )}
    </div>
  );
}
