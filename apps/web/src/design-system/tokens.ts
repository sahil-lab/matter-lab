/**
 * MATTER LAB — Astra design tokens, mirrored for TypeScript (Agent 01: Creative Direction and UI).
 *
 * `tokens.css` is the source of truth for anything the stylesheet can express (colors, radii,
 * shadows). This file exists only for the values JavaScript itself needs to make decisions with —
 * breakpoints, numeric motion durations for imperative animation, and the evidence-level metadata
 * used by badges and legends throughout the lab UI. Keep the numbers below in step with
 * `tokens.css` by hand; there are only a handful and they change rarely.
 */

/** Breakpoints named after the acceptance-test viewports in the shared contract and Agent 01 brief. */
export const ASTRA_BREAKPOINTS = {
  /** Smallest supported laptop viewport; the shell must remain usable, not necessarily spacious. */
  compact: 1280,
  /** The shell should look deliberately composed, not merely "not broken", at and above this width. */
  laptop: 1366,
  desktop: 1920,
} as const;

/** Below this width both the library and inspector panels default to their collapsed rail, so the viewport keeps its share. */
export const ASTRA_PANEL_AUTOCOLLAPSE_WIDTH = ASTRA_BREAKPOINTS.compact;

/** Below this width the inspector (but not the library) defaults to collapsed; at and above, both default open. */
export const ASTRA_INSPECTOR_AUTOCOLLAPSE_WIDTH = 1700;

/** Milliseconds, mirroring the `--astra-duration-*` custom properties for imperative (non-CSS) motion. */
export const ASTRA_DURATION = {
  instant: 90,
  fast: 150,
  base: 240,
  slow: 420,
  cinematic: 900,
} as const;

export const ASTRA_EASE = {
  standard: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
  entrance: 'cubic-bezier(0.1, 0.9, 0.2, 1)',
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
  emphasized: 'cubic-bezier(0.3, 0, 0.1, 1)',
} as const;

/**
 * The shared contract's five-level evidence vocabulary (§3 `Evidence`), distinct from
 * `@matterlab/core`'s six-level `EvidenceLevel` used by the v1 Architect/Reactions/Vault. Lab
 * surfaces fed by Agent 06/07 observations use this one; never invent a value outside of it.
 */
export type AstraEvidence = 'REFERENCE_MEASURED' | 'MODEL_CALCULATED' | 'ILLUSTRATIVE' | 'UNVERIFIED' | 'UNSUPPORTED';

export interface AstraEvidenceMeta {
  readonly label: string;
  readonly description: string;
  /** CSS custom property (without `var()`) carrying this level's color. */
  readonly colorVar: string;
}

export const ASTRA_EVIDENCE_LEVELS: Readonly<Record<AstraEvidence, AstraEvidenceMeta>> = {
  REFERENCE_MEASURED: {
    label: 'Reference measured',
    description: 'A cited, measured reference value — not produced by this session\u2019s calculation.',
    colorVar: '--astra-evidence-reference',
  },
  MODEL_CALCULATED: {
    label: 'Model calculated',
    description: 'The output of a stated, validated model run on the current experiment state.',
    colorVar: '--astra-evidence-model',
  },
  ILLUSTRATIVE: {
    label: 'Illustrative',
    description: 'A schematic or sample value to aid understanding. It is not measured or computed data.',
    colorVar: '--astra-evidence-illustrative',
  },
  UNVERIFIED: {
    label: 'Unverified',
    description: 'Produced outside a reviewed, benchmarked path. Treat as provisional.',
    colorVar: '--astra-evidence-unverified',
  },
  UNSUPPORTED: {
    label: 'Unsupported',
    description: 'No validated model covers this configuration, so no scientific value is shown.',
    colorVar: '--astra-evidence-unsupported',
  },
};
