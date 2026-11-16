import { bisectLeft } from 'd3-array';
import { scaleLinear, scaleLog } from 'd3-scale';
import { line } from 'd3-shape';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react';

/** Series colours: the interface palette first, then hues that stay apart for common colour-vision deficiencies. */
export const SERIES_COLORS = ['#55E2D1', '#FFB66B', '#8C92FC', '#FF8791', '#74E3A6', '#7FB4FF', '#F7D774', '#F2A2D8'];
/** Dash patterns repeat the distinction that colour makes, for readers who cannot rely on colour. */
const SERIES_DASHES = ['', '6 3', '2 3', '8 3 2 3', '', '6 3', '2 3', '8 3 2 3'];

const SUPERSCRIPT: Readonly<Record<string, string>> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };

function superscript(text: string | number): string {
  return String(text)
    .split('')
    .map((c) => SUPERSCRIPT[c] ?? c)
    .join('');
}

/**
 * Formats a number for a read-out: plain digits in the everyday range, powers of ten outside it,
 * to the given number of significant figures.
 */
export function formatNumber(value: number, significant = 3): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e-3 && magnitude < 1e5) return String(Number(value.toPrecision(significant)));
  const [mantissa, exponent] = value.toExponential(significant - 1).split('e') as [string, string];
  return `${Number(mantissa)}×10${superscript(Number(exponent))}`;
}

/** Typesets a unit written in plain text: "cm3 molecule-1 s-1" becomes "cm³ molecule⁻¹ s⁻¹". */
export function formatUnit(unit: string): string {
  return unit.replace(/([A-Za-zµ)])(-?\d+)/g, (_, head: string, power: string) => `${head}${superscript(power)}`);
}

/** Seconds as a readable duration: "35 ms", "12.4 s", "3.2 min", "1.6 h". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const s = Math.abs(seconds);
  if (s === 0) return '0 s';
  if (s < 1e-6) return `${formatNumber(seconds * 1e9)} ns`;
  if (s < 1e-3) return `${formatNumber(seconds * 1e6)} µs`;
  if (s < 1) return `${formatNumber(seconds * 1e3)} ms`;
  if (s < 120) return `${formatNumber(seconds)} s`;
  if (s < 7200) return `${formatNumber(seconds / 60)} min`;
  if (s < 172800) return `${formatNumber(seconds / 3600)} h`;
  if (s < 3.156e7 * 2) return `${formatNumber(seconds / 86400)} d`;
  return `${formatNumber(seconds / 3.15576e7)} yr`;
}

function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(300);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(160, Math.floor(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * The power of ten to take out of an axis, so that its tick labels stay short: an axis that runs
 * to 8×10¹¹ is labelled 0 to 8 in units of 10¹¹, the way printed scientific figures do it.
 */
function axisExponent(low: number, high: number): number {
  const largest = Math.max(Math.abs(low), Math.abs(high));
  if (!(largest > 0) || (largest >= 1e-2 && largest < 1e4)) return 0;
  return Math.floor(Math.log10(largest));
}

const tickText = (value: number, exponent: number): string => String(Number((value / 10 ** exponent).toPrecision(6))).replace('-', '−');

/** "quantity / 10ⁿ unit", the conventional way to label an axis whose numbers are pure. */
function axisTitle(label: string, unit: string | undefined, exponent: number, note = ''): string {
  const factor = exponent !== 0 ? `10${superscript(exponent)}` : '';
  const divisor = [factor, unit ? formatUnit(unit) : ''].filter(Boolean).join(' ');
  return `${label}${divisor ? ` / ${divisor}` : ''}${note}`;
}

export interface ChartSeries {
  readonly id: string;
  readonly label: ReactNode;
  /** Plain-text name for the accessible description. */
  readonly name: string;
  readonly values: ArrayLike<number>;
  readonly color?: string;
}

const TOP = 26;
const RIGHT = 14;
const BOTTOM = 34;
/** Width of one character of the tick font. */
const TICK_CHAR = 6.1;
/** Space left of the tick labels. The axis title is written above the plot, so it needs none. */
const TICK_ROOM = 12;

/**
 * A line chart of several series against one shared x axis. It can be scrubbed: pressing or
 * dragging in the plot reports the x value under the pointer, and `cursor` marks a position.
 */
export function LineChart({
  x,
  series,
  xLabel,
  xUnit,
  yLabel,
  yUnit,
  height = 190,
  logY = false,
  cursor,
  onScrub,
  testId,
}: {
  x: ArrayLike<number>;
  series: readonly ChartSeries[];
  /** Name of the quantity on each axis, and its unit in plain text ("cm3 molecule-1 s-1"). */
  xLabel: string;
  xUnit?: string;
  yLabel: string;
  yUnit?: string;
  height?: number;
  logY?: boolean;
  /** x position of the marker line, when one is shown. */
  cursor?: number | null;
  onScrub?: (x: number) => void;
  testId?: string;
}) {
  const [ref, width] = useWidth();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [hover, setHover] = useState<number | null>(null);
  const scrubbing = useRef(false);
  const n = x.length;
  const innerHeight = Math.max(10, height - TOP - BOTTOM);

  const plot = useMemo(() => {
    const visible = series.filter((s) => !hidden.has(s.id));
    const x0 = n > 0 ? x[0]! : 0;
    const x1 = n > 0 ? x[n - 1]! : 1;
    let low = Infinity;
    let high = -Infinity;
    for (const s of visible) {
      for (let i = 0; i < n; i++) {
        const v = s.values[i]!;
        if (!Number.isFinite(v) || (logY && v <= 0)) continue;
        if (v < low) low = v;
        if (v > high) high = v;
      }
    }
    if (!(high > -Infinity)) {
      low = logY ? 1 : 0;
      high = logY ? 10 : 1;
    }
    if (!logY) low = Math.min(0, low);
    if (high === low) high = low === 0 ? 1 : low + Math.abs(low) * 0.1;
    const yScale = logY ? scaleLog().domain([low, high]).range([innerHeight, 0]).nice() : scaleLinear().domain([low, high]).range([innerHeight, 0]).nice();
    const [yLow, yHigh] = yScale.domain() as [number, number];
    const yExponent = logY ? 0 : axisExponent(yLow, yHigh);
    const yTicks = (logY ? yScale.ticks(4).filter((t) => Number.isInteger(Math.log10(t))) : yScale.ticks(5)).map((value) => ({
      value,
      text: logY ? `10${superscript(Math.round(Math.log10(value)))}` : tickText(value, yExponent),
    }));
    const left = Math.max(30, TICK_ROOM + Math.max(1, ...yTicks.map((t) => t.text.length)) * TICK_CHAR);
    const innerWidth = Math.max(10, width - left - RIGHT);
    const xScale = scaleLinear()
      .domain([x0, x1 === x0 ? x0 + 1 : x1])
      .range([0, innerWidth]);
    const xExponent = axisExponent(x0, x1);
    const xTicks = xScale.ticks(Math.max(2, Math.floor(innerWidth / 62))).map((value) => ({ value, text: tickText(value, xExponent) }));
    const indices = Array.from({ length: n }, (_, i) => i);
    const paths = visible.map((s) => {
      const generator = line<number>()
        .defined((i) => Number.isFinite(s.values[i]!) && (!logY || s.values[i]! > 0))
        .x((i) => xScale(x[i]!))
        .y((i) => yScale(s.values[i]!));
      return { series: s, d: generator(indices) ?? '' };
    });
    return { visible, xScale, yScale, xTicks, yTicks, xExponent, yExponent, left, innerWidth, paths };
  }, [x, series, hidden, n, width, innerHeight, logY]);

  const { visible, xScale, yScale, xTicks, yTicks, left, innerWidth, paths } = plot;
  const colorOf = (s: ChartSeries) => s.color ?? SERIES_COLORS[series.indexOf(s) % SERIES_COLORS.length]!;
  const dashOf = (s: ChartSeries) => SERIES_DASHES[series.indexOf(s) % SERIES_DASHES.length]!;
  const xValues = useMemo(() => Array.from(x), [x]);

  const nearest = (value: number): number => {
    const i = bisectLeft(xValues, value);
    if (i <= 0) return 0;
    if (i >= n) return n - 1;
    return value - xValues[i - 1]! < xValues[i]! - value ? i - 1 : i;
  };
  const indexAt = (clientX: number, target: SVGElement): number => {
    const box = target.getBoundingClientRect();
    return nearest(xScale.invert(Math.min(innerWidth, Math.max(0, clientX - box.left))));
  };
  const onMove = (e: ReactPointerEvent<SVGRectElement>) => {
    if (n === 0) return;
    const i = indexAt(e.clientX, e.currentTarget);
    setHover(i);
    if (scrubbing.current) onScrub?.(x[i]!);
  };

  const hasCursor = cursor !== null && cursor !== undefined && n > 0;
  const marker = hover ?? (hasCursor ? nearest(cursor) : null);
  const xTitle = axisTitle(xLabel, xUnit, plot.xExponent);
  const yTitle = axisTitle(yLabel, yUnit, plot.yExponent, logY ? ' (log scale)' : '');

  return (
    <div ref={ref} className="ml-chart" data-testid={testId}>
      <svg width={width} height={height} role="img" aria-label={`${yTitle} against ${xTitle} for ${series.map((s) => s.name).join(', ')}`}>
        <g transform={`translate(${left} ${TOP})`}>
          {yTicks.map((t) => (
            <g key={t.value} transform={`translate(0 ${yScale(t.value)})`}>
              <line className="ml-chart__grid" x2={innerWidth} />
              <text className="ml-chart__tick" x={-8} dy="0.32em" textAnchor="end">
                {t.text}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <g key={t.value} transform={`translate(${xScale(t.value)} ${innerHeight})`}>
              <line className="ml-chart__axis" y2={4} />
              <text className="ml-chart__tick" y={16} textAnchor="middle">
                {t.text}
              </text>
            </g>
          ))}
          <line className="ml-chart__axis" y1={innerHeight} y2={innerHeight} x2={innerWidth} />
          <line className="ml-chart__axis" y2={innerHeight} />
          {paths.map((p) => (
            <path key={p.series.id} d={p.d} fill="none" stroke={colorOf(p.series)} strokeWidth={1.8} strokeDasharray={dashOf(p.series)} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hasCursor && <line className="ml-chart__cursor" x1={xScale(cursor)} x2={xScale(cursor)} y2={innerHeight} />}
          {hover !== null && (
            <g>
              <line className="ml-chart__hover" x1={xScale(x[hover]!)} x2={xScale(x[hover]!)} y2={innerHeight} />
              {visible.map((s) => {
                const v = s.values[hover]!;
                if (!Number.isFinite(v) || (logY && v <= 0)) return null;
                return <circle key={s.id} cx={xScale(x[hover]!)} cy={yScale(v)} r={3.2} fill={colorOf(s)} stroke="#0b1424" strokeWidth={1.2} />;
              })}
            </g>
          )}
          <rect
            width={innerWidth}
            height={innerHeight}
            fill="transparent"
            style={{ cursor: onScrub ? 'ew-resize' : 'crosshair', touchAction: 'none' }}
            onPointerDown={(e) => {
              if (!onScrub || n === 0) return;
              scrubbing.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              onScrub(x[indexAt(e.clientX, e.currentTarget)]!);
            }}
            onPointerMove={onMove}
            onPointerUp={(e) => {
              scrubbing.current = false;
              if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
            }}
            onPointerLeave={() => {
              if (!scrubbing.current) setHover(null);
            }}
          />
        </g>
        <text className="ml-chart__label" x={left + innerWidth / 2} y={height - 3} textAnchor="middle">
          {xTitle}
        </text>
        <text className="ml-chart__label" x={2} y={11}>
          {yTitle}
        </text>
      </svg>
      <div className="ml-chart__legend">
        {series.map((s) => {
          const off = hidden.has(s.id);
          const value = marker !== null ? s.values[marker] : undefined;
          return (
            <button
              key={s.id}
              type="button"
              aria-pressed={!off}
              data-off={off}
              title={off ? `Show ${s.name}` : `Hide ${s.name}`}
              onClick={() =>
                setHidden((current) => {
                  const next = new Set(current);
                  if (next.has(s.id)) next.delete(s.id);
                  else next.add(s.id);
                  return next;
                })
              }
            >
              <svg width="18" height="8" aria-hidden>
                <line x1="1" x2="17" y1="4" y2="4" stroke={colorOf(s)} strokeWidth="2" strokeDasharray={dashOf(s)} strokeLinecap="round" />
              </svg>
              <span>{s.label}</span>
              {value !== undefined && !off && <b>{formatNumber(value)}</b>}
            </button>
          );
        })}
        {marker !== null && n > 0 && (
          <span className="ml-chart__at">
            at {formatNumber(x[marker]!, 4)}
            {xUnit ? ` ${formatUnit(xUnit)}` : ''}
          </span>
        )}
      </div>
    </div>
  );
}

export interface EnergyLevel {
  readonly kind: 'reactants' | 'barrier' | 'products';
  /** A short name drawn under the level. */
  readonly label: string;
  readonly value: number;
}

/**
 * An energy-level diagram: one horizontal level per state, at its value on a shared scale. The
 * levels are data; the dashed lines that join them only guide the eye and carry no meaning.
 */
export function EnergyLevels({ levels, unit, quantityLabel, height = 180, testId }: { levels: readonly EnergyLevel[]; unit: string; quantityLabel: string; height?: number; testId?: string }) {
  const [ref, width] = useWidth();
  const top = 40;
  const bottom = 26;
  const innerHeight = Math.max(10, height - top - bottom);
  const values = levels.map((l) => l.value);
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const pad = (high - low || 1) * 0.14;
  const y = scaleLinear()
    .domain([low - pad, high + pad])
    .range([innerHeight, 0]);
  const ticks = y.ticks(5).map((value) => ({ value, text: tickText(value, 0) }));
  const left = Math.max(30, TICK_ROOM + Math.max(1, ...ticks.map((t) => t.text.length)) * TICK_CHAR);
  const innerWidth = Math.max(10, width - left - 12);
  const slot = innerWidth / Math.max(1, levels.length);
  const levelWidth = Math.min(92, slot * 0.6);
  const xOf = (i: number) => slot * (i + 0.5);
  const tone = (kind: EnergyLevel['kind']) => (kind === 'barrier' ? 'var(--energy)' : kind === 'products' ? 'var(--accent)' : 'var(--text)');
  const signed = (value: number) => (value === 0 ? '0' : `${value > 0 ? '+' : '−'}${formatNumber(Math.abs(value), 4)}`);

  return (
    <div ref={ref} className="ml-chart" data-testid={testId}>
      <svg width={width} height={height} role="img" aria-label={`${quantityLabel} levels: ${levels.map((l) => `${l.label} ${signed(l.value)} ${unit}`).join(', ')}`}>
        <g transform={`translate(${left} ${top})`}>
          {ticks.map((t) => (
            <g key={t.value} transform={`translate(0 ${y(t.value)})`}>
              <line className="ml-chart__grid" x2={innerWidth} />
              <text className="ml-chart__tick" x={-8} dy="0.32em" textAnchor="end">
                {t.text}
              </text>
            </g>
          ))}
          <line className="ml-chart__axis" y2={innerHeight} />
          {levels.slice(1).map((level, i) => (
            <line key={`join-${i}`} className="ml-chart__join" x1={xOf(i) + levelWidth / 2} y1={y(levels[i]!.value)} x2={xOf(i + 1) - levelWidth / 2} y2={y(level.value)} />
          ))}
          {levels.map((level, i) => (
            <g key={`${level.kind}-${i}`} transform={`translate(${xOf(i)} ${y(level.value)})`}>
              <line x1={-levelWidth / 2} x2={levelWidth / 2} stroke={tone(level.kind)} strokeWidth={2.6} strokeLinecap="round" />
              <text className="ml-chart__value" y={-7} textAnchor="middle" fill={tone(level.kind)}>
                {signed(level.value)}
              </text>
              <text className="ml-chart__tick" y={innerHeight - y(level.value) + 17} textAnchor="middle">
                {level.label}
              </text>
            </g>
          ))}
        </g>
        <text className="ml-chart__label" x={2} y={11}>
          {axisTitle(quantityLabel, unit, 0)}
        </text>
      </svg>
    </div>
  );
}
