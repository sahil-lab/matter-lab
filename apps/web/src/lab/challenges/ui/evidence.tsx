import type { Evidence } from '../contracts';

const EVIDENCE_INFO: Readonly<Record<Evidence, { readonly label: string; readonly description: string }>> = {
  REFERENCE_MEASURED: { label: 'Reference measured', description: 'Taken from a cited reference measurement.' },
  MODEL_CALCULATED: { label: 'Model calculated', description: 'Produced by a stated calculation from validated inputs.' },
  ILLUSTRATIVE: { label: 'Illustrative', description: 'A schematic aid, not measured or computed data.' },
  UNVERIFIED: { label: 'Unverified', description: 'Not enough data yet to verify this value.' },
  UNSUPPORTED: { label: 'Unsupported', description: 'No available engine can evaluate this yet.' },
};

/** Shows the evidence level next to a value; never color alone — the label is always text. */
export function EvidenceTag({ level }: { level: Evidence }) {
  const info = EVIDENCE_INFO[level];
  return (
    <span className="lc-evidence" data-level={level} title={info.description}>
      {info.label}
    </span>
  );
}

export function formatMl(volumeL: number | null): string {
  return volumeL === null ? '\u2014' : (volumeL * 1000).toFixed(2);
}

export function formatPercent01(value01: number): string {
  return `${Math.round(value01 * 100)}%`;
}
