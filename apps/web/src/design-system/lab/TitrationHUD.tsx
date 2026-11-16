import type { Evidence, ObservationRecord, UUID } from '@matterlab/contracts';
import { ChevronDown, FileQuestion } from 'lucide-react';
import { formatNumber } from '../../ui/charts';
import { LabEvidenceBadge, ObservationReadout } from './ObservationReadout';
import { canDisplayObservation, observationInScope } from './observations';
import type { ObservationAvailability, ObservationScope } from './observations';
import { LabButton, LabTag } from './primitives';

export interface LabMilestone {
  readonly state: 'unknown' | 'pending' | 'reached' | 'unsupported';
  readonly detail?: string;
  readonly evidence?: Evidence;
}

export interface TitrationHUDProps {
  readonly scope: ObservationScope;
  readonly ph?: Readonly<ObservationRecord> | null;
  readonly remaining?: Readonly<ObservationRecord> | null;
  readonly sourceInstanceId?: UUID;
  readonly status?: 'ready' | 'loading' | 'empty' | 'offline' | 'error' | 'unsupported';
  readonly statusMessage?: string;
  readonly indicator?: Readonly<ObservationRecord> | null;
  readonly indicatorLabel?: string;
  readonly equivalence?: LabMilestone;
  readonly endpoint?: LabMilestone;
  readonly onExplain?: () => void;
}

function Milestone({ name, value, blocked }: { name: string; value?: LabMilestone; blocked: boolean }) {
  const state = blocked ? 'unsupported' : value?.state ?? 'unknown';
  return <div className="mlab-milestone"><span>{name}</span><LabTag tone={state === 'reached' ? 'success' : state === 'unsupported' ? 'warm' : 'neutral'}>{state === 'unknown' ? 'Not reported' : state}</LabTag>{!blocked && value?.detail && <p>{value.detail}</p>}{!blocked && value?.evidence && <LabEvidenceBadge evidence={value.evidence} />}</div>;
}

export function TitrationHUD({ scope, ph, remaining, sourceInstanceId, status = 'ready', statusMessage, indicator, indicatorLabel, equivalence, endpoint, onExplain }: TitrationHUDProps) {
  const availability: ObservationAvailability = status === 'ready' ? 'current' : status === 'offline' ? 'stale' : status;
  const phRecord = ph && observationInScope(ph, scope) && ph.observation.type === 'PH' ? ph : null;
  const observation = phRecord?.observation ?? null;
  const expectedSource = sourceInstanceId ?? observation?.titration?.sourceInstanceId;
  const remainingRecord = remaining && observationInScope(remaining, { runId: scope.runId, stationId: scope.stationId, epoch: scope.epoch }) && remaining.observation.type === 'VOLUME' &&
    (expectedSource === undefined || remaining.observation.apparatusId === expectedSource) ? remaining : null;
  const supported = canDisplayObservation(observation, availability);
  const transfer = supported ? observation?.titration : undefined;
  const delivered = transfer && Number.isFinite(transfer.deliveredVolumeL) && transfer.deliveredVolumeL >= 0 &&
    (expectedSource === undefined || transfer.sourceInstanceId === expectedSource) &&
    (observation?.apparatusId === undefined || transfer.receiverInstanceId === observation.apparatusId) ? transfer.deliveredVolumeL : null;
  const blocked = availability === 'unsupported' || availability === 'error' || availability === 'loading' || availability === 'empty' || !supported;
  const indicatorObservation = indicator && observationInScope(indicator, scope) && indicator.observation.type === 'INDICATOR' &&
    indicator.sequence === phRecord?.sequence && indicator.observation.timeS === observation?.timeS &&
    indicator.observation.methodId === observation?.methodId && canDisplayObservation(indicator.observation, availability) ? indicator.observation : null;
  const indicatorState = indicatorObservation?.indicatorState;
  const colorValid = !blocked && indicatorState?.colorSrgb.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1);
  const color = colorValid && indicatorState ? `rgb(${indicatorState.colorSrgb.map((channel) => `${channel * 100}%`).join(' ')})` : undefined;
  return (
    <section className="mlab-titration-hud" aria-label="Titration observations" data-state={status}>
      <header><span className="mlab-eyebrow">TITRATION / OBSERVED</span><LabTag tone={status === 'ready' ? 'neutral' : 'warm'}>{status === 'offline' ? 'Cached · offline' : status === 'ready' ? 'Ledger' : status}</LabTag>{onExplain && <LabButton icon size="sm" aria-label="Explain titration observations" onClick={onExplain}><FileQuestion /></LabButton>}</header>
      <div className="mlab-hud-metrics">
        <ObservationReadout label="pH" observation={observation} availability={availability} compact />
        <section className="mlab-readout" data-available={delivered !== null} data-compact="true" aria-label="Delivered volume at pH sample">
          <div className="mlab-eyebrow">Delivered</div>
          <div className="mlab-readout__value"><output>{delivered === null ? '—' : formatNumber(delivered, 6)}</output>{delivered !== null && <span>L</span>}</div>
          <p className="mlab-caption">{delivered === null ? 'No paired transfer sample' : 'At this pH sample'}</p>
        </section>
        <ObservationReadout label="Burette remaining" observation={remainingRecord?.observation} availability={availability} compact />
      </div>
      {statusMessage && <p className="mlab-hud-message" role="status">{statusMessage}</p>}
      <details className="mlab-hud-details">
        <summary><span>Endpoint, indicator & sources</span><ChevronDown aria-hidden="true" /></summary>
        <div className="mlab-hud-detail-body">
          <div className="mlab-indicator"><span className="mlab-indicator__swatch" style={color ? { background: color } : undefined} aria-hidden="true" /><span><strong>{indicatorLabel ?? indicatorObservation?.indicatorId ?? 'Indicator not supplied'}</strong><small>{color ? 'Solver-provided color / illustrative' : 'No supported color observation'}</small></span>{colorValid && indicatorState && <LabEvidenceBadge evidence={indicatorState.colorEvidence} />}</div>
          <Milestone name="Equivalence" value={equivalence} blocked={blocked} />
          <Milestone name="Endpoint" value={endpoint} blocked={blocked} />
          <p className="mlab-caption">An indicator endpoint is not the stoichiometric equivalence point. Neither is inferred here from the pH or the rendered color.</p>
          {observation && <div className="mlab-readout__provenance"><p>Method / {observation.methodId}{observation.methodVersion ? ` · ${observation.methodVersion}` : ''}</p><p>Sources / {observation.sourceIds.length ? observation.sourceIds.join(', ') : 'Not supplied'}</p><p>Run / {scope.runId} · epoch {scope.epoch}</p>{observation.quantity.uncertainty === undefined && <p>Uncertainty was not supplied by the source.</p>}</div>}
          {remainingRecord && <div className="mlab-readout__provenance"><p>Remaining-volume method / {remainingRecord.observation.methodId}</p><p>Remaining-volume sources / {remainingRecord.observation.sourceIds.length ? remainingRecord.observation.sourceIds.join(', ') : 'Not supplied'}</p></div>}
          {colorValid && indicatorState && <div className="mlab-readout__provenance"><p>Indicator sources / {indicatorState.sourceIds.length ? indicatorState.sourceIds.join(', ') : 'Not supplied'}</p></div>}
        </div>
      </details>
    </section>
  );
}
