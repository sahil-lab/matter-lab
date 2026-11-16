import type { Observation, ObservationRecord } from '@matterlab/contracts';
import { extent } from 'd3-array';
import { scaleLinear } from 'd3-scale';
import { line } from 'd3-shape';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { formatNumber, SERIES_COLORS } from '../../ui/charts';
import { Segmented } from '../../ui/kit';
import { LabEvidenceBadge } from './ObservationReadout';
import { observationDisplay, observationInScope, titrationPlotData } from './observations';
import type { ObservationScope, TitrationPlotData, TitrationPlotPoint } from './observations';
import { LabButton, LabStateNotice } from './primitives';

const OBSERVATION_TYPES: readonly Observation['type'][] = ['PH', 'VOLUME', 'TEMPERATURE', 'CONCENTRATION', 'INDICATOR', 'MASS'];

function TitrationPlot({ data }: { data: TitrationPlotData }) {
  const id = useId();
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    if (!host.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(Math.max(240, Math.floor(entry.contentRect.width))); });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const samples = data.series.flatMap((series) => series.points.filter((point): point is TitrationPlotPoint => point !== null));
  if (!samples.length) return <div ref={host}><LabStateNotice status="empty" compact title="No paired pH samples">A delivered-volume plot needs the exact transfer context stamped by the runtime. Receiver volume is never used as a substitute.</LabStateNotice></div>;
  const [xMin, xMax] = extent(samples, (point) => point.deliveredVolumeL) as [number, number];
  const [yMin, yMax] = extent(samples, (point) => point.pH) as [number, number];
  const height = 178;
  const left = 48, right = 16, top = 20, bottom = 35;
  const x = scaleLinear().domain(xMin === xMax ? [Math.min(0, xMin), xMax + Math.max(Math.abs(xMax) * .1, .001)] : [xMin, xMax]).range([left, width - right]).nice();
  const padY = yMin === yMax ? .5 : (yMax - yMin) * .08;
  const y = scaleLinear().domain([yMin - padY, yMax + padY]).range([height - bottom, top]).nice();
  const path = line<TitrationPlotPoint | null>().defined((point) => point !== null).x((point) => x(point!.deliveredVolumeL)).y((point) => y(point!.pH));
  return (
    <div ref={host} className="mlab-titration-plot">
      <svg width={width} height={height} role="img" aria-labelledby={`${id}-title ${id}-description`}>
        <title id={`${id}-title`}>Recorded pH against delivered volume in milliliters</title>
        <desc id={`${id}-description`}>Only supplied, paired model-calculated or reference-measured samples are plotted. Straight lines join recorded samples, not additional evaluations. Missing samples break the line. Use the table for keyboard access and exact units.</desc>
        {y.ticks(4).map((value) => <g key={`y-${value}`}><line className="mlab-plot-grid" x1={left} x2={width - right} y1={y(value)} y2={y(value)} /><text className="mlab-plot-tick" x={left - 8} y={y(value)} dy=".32em" textAnchor="end">{formatNumber(value, 4)}</text></g>)}
        {x.ticks(Math.max(2, Math.floor((width - left) / 80))).map((value) => <g key={`x-${value}`}><line className="mlab-plot-axis" x1={x(value)} x2={x(value)} y1={height - bottom} y2={height - bottom + 4} /><text className="mlab-plot-tick" x={x(value)} y={height - bottom + 16} textAnchor="middle">{formatNumber(value * 1000, 4)}</text></g>)}
        <line className="mlab-plot-axis" x1={left} x2={width - right} y1={height - bottom} y2={height - bottom} />
        <text className="mlab-plot-label" x={8} y={12}>pH</text><text className="mlab-plot-label" x={(left + width - right) / 2} y={height - 2} textAnchor="middle">Delivered volume / mL</text>
        {data.series.map((series, index) => <g key={series.key}>
          <path d={path(series.points) ?? ''} fill="none" stroke={SERIES_COLORS[index % SERIES_COLORS.length]} strokeWidth={1.5} strokeDasharray={index % 2 ? '5 3' : undefined} />
          {series.points.map((point, pointIndex) => point && <circle key={`${point.record.id}-${pointIndex}`} cx={x(point.deliveredVolumeL)} cy={y(point.pH)} r={2.2} fill={SERIES_COLORS[index % SERIES_COLORS.length]}><title>{formatNumber(point.deliveredVolumeL, 9)} L; pH {formatNumber(point.pH, 9)}; {series.methodId}</title></circle>)}
        </g>)}
      </svg>
      <ul className="mlab-plot-legend">{data.series.map((series, index) => <li key={series.key}><span style={{ borderColor: SERIES_COLORS[index % SERIES_COLORS.length], borderStyle: index % 2 ? 'dashed' : 'solid' }} />{series.methodId}<LabEvidenceBadge evidence={series.evidence} /><small title={`${series.sourceInstanceId} → ${series.receiverInstanceId}`}>{series.sourceInstanceId.slice(0, 8)} → {series.receiverInstanceId.slice(0, 8)}</small></li>)}</ul>
      <p className="mlab-caption">{data.sampleCount} supplied samples. Lines are guides between observations, not a prediction. L → mL is display conversion only.</p>
    </div>
  );
}

export interface ObservationTimelineProps {
  readonly records: readonly ObservationRecord[];
  readonly scope: ObservationScope;
  readonly status?: 'ready' | 'loading' | 'offline' | 'error' | 'unsupported';
  readonly statusMessage?: string;
  readonly onSelect?: (recordId: string) => void;
  readonly selectedId?: string | null;
  readonly maxPlotSamples?: number;
  readonly defaultView?: 'plot' | 'table';
}

export function ObservationTimeline({ records, scope, status = 'ready', statusMessage, onSelect, selectedId, maxPlotSamples = 2000, defaultView = 'plot' }: ObservationTimelineProps) {
  const [view, setView] = useState<'plot' | 'table'>(defaultView);
  const [filter, setFilter] = useState<Observation['type'] | 'all'>('all');
  const [page, setPage] = useState(0);
  const { runId, stationId, epoch, apparatusId } = scope;
  const scoped = useMemo(() => records.filter((record) => observationInScope(record, { runId, stationId, epoch, apparatusId })).sort((a, b) => b.sequence - a.sequence), [records, runId, stationId, epoch, apparatusId]);
  const visible = useMemo(() => filter === 'all' ? scoped : scoped.filter((record) => record.observation.type === filter), [scoped, filter]);
  const plot = useMemo(() => titrationPlotData(records, { runId, stationId, epoch, apparatusId }, maxPlotSamples), [records, runId, stationId, epoch, apparatusId, maxPlotSamples]);
  const pageCount = Math.max(1, Math.ceil(visible.length / 50));
  const shownPage = Math.min(page, pageCount - 1);
  useEffect(() => { setPage(0); }, [runId, stationId, epoch, apparatusId]);
  const currentResultsBlocked = status === 'unsupported' || status === 'error' || status === 'loading';
  return (
    <div className="mlab-observation-timeline">
      <header className="mlab-ledger-header">
        <Segmented<'plot' | 'table'> label="Observation view" value={view} onChange={setView} options={[{ value: 'plot', label: 'Titration plot' }, { value: 'table', label: 'Accessible ledger' }]} />
        <span className="mlab-caption">Epoch {epoch} · {scoped.length} observations</span>
        {view === 'table' && <label><span className="mlab-sr-only">Filter observation type</span><select value={filter} onChange={(event) => { setFilter(event.target.value as Observation['type'] | 'all'); setPage(0); }}><option value="all">All quantities</option>{OBSERVATION_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>}
      </header>
      {status !== 'ready' && <LabStateNotice status={status} compact>{statusMessage ?? (status === 'offline' ? 'Offline: this is previously recorded data, not a live reading or a confirmed remote save.' : status === 'loading' ? 'Waiting for the authoritative worker.' : 'No current numerical result is available. Existing ledger entries are historical, not a successful result of this operation.')}</LabStateNotice>}
      {view === 'plot' ? (
        <>
          {!currentResultsBlocked && <TitrationPlot data={plot} />}
          {!currentResultsBlocked && (plot.omitted > 0 || plot.truncated > 0) && <p className="mlab-caption mlab-plot-warning" role="status">{plot.omitted > 0 && `${plot.omitted} unpaired, unsupported or unverified pH samples are not plotted. `}{plot.truncated > 0 && `${plot.truncated} older samples are outside this plot window. `}All supplied records remain in the accessible ledger.</p>}
        </>
      ) : (
        <>
          {scoped.length > 0 && currentResultsBlocked && <p className="mlab-caption">Historical observations below are explicitly separated from the unsuccessful or unfinished current operation.</p>}
          {visible.length === 0 ? <LabStateNotice status="empty" compact title="No matching recorded observations">The ledger contains only the selected run, station and epoch. Previous resets and other stations are not mixed into this view.</LabStateNotice> :
            <div className="mlab-table-scroll" tabIndex={0} role="region" aria-label="Observation ledger table, scroll horizontally for provenance">
              <table className="mlab-ledger-table"><caption>Recorded observations in original units. Run {runId}; station {stationId}; epoch {epoch}. Latest first.</caption><thead><tr><th scope="col">Time / s</th><th scope="col">Quantity</th><th scope="col">Value / unit</th><th scope="col">Evidence</th><th scope="col">Method & sources</th></tr></thead><tbody>
                {visible.slice(shownPage * 50, shownPage * 50 + 50).map((record) => {
                  const observation = record.observation;
                  const display = observationDisplay(observation, currentResultsBlocked || status === 'offline' ? 'stale' : 'current');
                  return <tr key={record.id} data-selected={selectedId === record.id}>
                    <td>{formatNumber(observation.timeS, 6)}</td><th scope="row">{observation.type}</th>
                    <td>{onSelect ? <button type="button" aria-label={`Inspect ${observation.type} observation at ${formatNumber(observation.timeS, 6)} seconds`} onClick={() => onSelect(record.id)}>{display.value} {display.unit}</button> : <span>{display.value} {display.unit}</span>}{display.uncertainty !== null && <small>± {display.uncertainty} {display.unit}</small>}{!display.available && <small>{display.message}</small>}</td>
                    <td><LabEvidenceBadge evidence={observation.evidence} /></td>
                    <td><span>{observation.methodId}{observation.methodVersion ? ` · ${observation.methodVersion}` : ''}</span><small>{observation.sourceIds.length ? observation.sourceIds.join(', ') : 'No source IDs supplied'}</small></td>
                  </tr>;
                })}
              </tbody></table>
            </div>}
          <footer className="mlab-ledger-pagination"><span>{visible.length} records · page {shownPage + 1} of {pageCount}</span><LabButton icon size="sm" aria-label="Previous ledger page" disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)}><ArrowLeft /></LabButton><LabButton icon size="sm" aria-label="Next ledger page" disabled={shownPage + 1 >= pageCount} onClick={() => setPage(shownPage + 1)}><ArrowRight /></LabButton></footer>
        </>
      )}
    </div>
  );
}
