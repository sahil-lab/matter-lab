/**
 * Every scientific value MATTER LAB shows carries an evidence level, so a schematic can never be
 * mistaken for a measurement and a heuristic can never be mistaken for a simulation.
 */
export type EvidenceLevel =
  /** Curated reference or experimental data with a cited source. */
  | 'reference'
  /** Output of a named calculation that actually ran; method and settings are recorded. */
  | 'computed'
  /** Result of a deterministic textbook rule or heuristic. Not a simulation. */
  | 'rule-based'
  /** Schematic visual aid. Conveys an idea, not data. */
  | 'illustrative'
  /** Exactly as entered by the user; not validated. */
  | 'user-input'
  /** The available engines cannot evaluate this system. */
  | 'unsupported';

export const EVIDENCE_LEVELS: Readonly<Record<EvidenceLevel, { label: string; description: string }>> = {
  reference: {
    label: 'Reference data',
    description: 'Taken from a cited reference dataset or published measurement.',
  },
  computed: {
    label: 'Computed',
    description: 'Produced by a real calculation. The method, settings and limitations are recorded.',
  },
  'rule-based': {
    label: 'Rule-based',
    description: 'Derived from a textbook rule or heuristic. It is an estimate, not a simulation.',
  },
  illustrative: {
    label: 'Illustrative',
    description: 'A schematic to aid understanding. It does not represent measured or computed data.',
  },
  'user-input': {
    label: 'User input',
    description: 'Exactly as entered. It has not been validated.',
  },
  unsupported: {
    label: 'Unsupported',
    description: 'No available engine can evaluate this system, so no result is shown.',
  },
};

export interface Citation {
  readonly authors?: string;
  readonly title: string;
  /** Journal, publisher or dataset name. */
  readonly source?: string;
  readonly year?: number;
  readonly doi?: string;
  readonly url?: string;
}

export interface Provenance {
  /** The dataset or engine that produced the value. */
  readonly source: string;
  readonly version?: string;
  readonly citations?: readonly Citation[];
  readonly url?: string;
  /** ISO date on which an external source was retrieved. */
  readonly retrieved?: string;
  readonly license?: string;
  readonly notes?: string;
}

/** A number with its unit, how far to trust it, and where it came from. */
export interface Quantity {
  readonly value: number;
  readonly unit: string;
  /** One standard uncertainty in the same unit, when the source states one. */
  readonly uncertainty?: number;
  readonly evidence: EvidenceLevel;
  readonly provenance?: Provenance;
}

/** Lifecycle shared by every asynchronous calculation, local worker or remote service alike. */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unsupported';

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled', 'unsupported'];
