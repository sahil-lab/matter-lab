import type { Evidence, Observation } from '@matterlab/contracts';
import { observationDisplay } from './observations';
import type { ObservationAvailability } from './observations';
import { LabTag } from './primitives';
import type { LabTone } from './types';

export const LAB_EVIDENCE_LABELS: Readonly<Record<Evidence, { label: string; description: string; tone: LabTone }>> = {
  REFERENCE_MEASURED: { label: 'Reference measured', description: 'A measured value from the cited reference, at its stated conditions.', tone: 'success' },
  MODEL_CALCULATED: { label: 'Model calculated', description: 'Computed with the stated model and assumptions; not an experimental measurement.', tone: 'cool' },
  ILLUSTRATIVE: { label: 'Illustrative', description: 'An explanatory representation, not evidence of a measured chemical outcome.', tone: 'warm' },
  UNVERIFIED: { label: 'Unverified', description: 'No corresponding validated calculation or measured reference establishes this value.', tone: 'warm' },
  UNSUPPORTED: { label: 'Unsupported', description: 'The available model cannot support a numerical result for these conditions.', tone: 'warm' },
};

export function LabEvidenceBadge({ evidence }: { evidence: Evidence }) {
  const info = LAB_EVIDENCE_LABELS[evidence];
  return <span className="mlab-evidence" data-evidence={evidence} title={info.description}><LabTag tone={info.tone}>{info.label}</LabTag><span className="mlab-sr-only">. {info.description}</span></span>;
}

export interface ObservationReadoutProps {
  readonly label: string;
  readonly observation?: Readonly<Observation> | null;
  readonly availability?: ObservationAvailability;
  readonly compact?: boolean;
}

export function ObservationReadout({ label, observation, availability = 'current', compact = false }: ObservationReadoutProps) {
  const display = observationDisplay(observation, availability);
  return (
    <section className="mlab-readout" data-available={display.available} data-compact={compact} aria-label={label}>
      <div className="mlab-eyebrow">{label}</div>
      <div className="mlab-readout__value"><output aria-label={`${label}: ${display.available ? `${display.value} ${display.unit}` : display.message}`}>{display.value}</output>{display.unit && <span>{display.unit}</span>}</div>
      {display.uncertainty !== null && <div className="mlab-readout__uncertainty">± {display.uncertainty} {display.unit}</div>}
      <p className="mlab-caption">{display.message}</p>
      {observation && <LabEvidenceBadge evidence={observation.evidence} />}
      {!compact && observation && <div className="mlab-readout__provenance">
        <p>Method / {observation.methodId || 'Not supplied'}{observation.methodVersion ? ` · ${observation.methodVersion}` : ''}</p>
        <p>Sources / {observation.sourceIds.length ? observation.sourceIds.join(', ') : 'Not supplied'}</p>
        {display.available && display.uncertainty === null && <p>Uncertainty not supplied; display precision is not a confidence interval.</p>}
      </div>}
    </section>
  );
}
