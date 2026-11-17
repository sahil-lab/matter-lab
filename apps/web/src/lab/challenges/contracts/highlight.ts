/**
 * STUB CONTRACT — pending Agent 02 (3D environment/camera), Agent 03 (apparatus definitions) and
 * Agent 04 (interaction/editor highlight APIs).
 *
 * Agent 08's brief requires "context-sensitive hints that highlight actual objects and interactors
 * via Agents 02/03/04 APIs" without owning the 3D scene itself. This module defines the smallest
 * surface the hint engine needs: a way to say "highlight this instance/socket" or "highlight this
 * apparatus category in the palette" and get a disposer back, plus a label lookup for apparatus
 * kinds. Until the real APIs exist, `NULL_HIGHLIGHT_API` performs no visual highlighting (so the
 * app never pretends to point at a 3D object that isn't there) while `DEFAULT_APPARATUS_LABELS`
 * gives every hint caption a readable noun.
 */

import type { ApparatusKind, UUID } from '@matterlab/contracts';

export type HighlightTarget =
  /** A specific placed instance, optionally one of its sockets. */
  | { readonly kind: 'instance'; readonly instanceId: UUID; readonly socketId?: string }
  /** Nothing of this kind is placed yet; point at the apparatus library/palette entry instead. */
  | { readonly kind: 'paletteCategory'; readonly apparatusKind: ApparatusKind }
  /** A control surface on an already-placed instance, e.g. the stopcock handle. */
  | { readonly kind: 'control'; readonly instanceId: UUID; readonly controlId: string };

export interface HighlightOptions {
  /** `'pulse'` draws attention; `'outline'` is a calmer, persistent indicator for reduced-motion. */
  readonly style: 'pulse' | 'outline';
  readonly label?: string;
}

/**
 * Implemented by Agent 02/03/04's real highlight/focus APIs. `highlight` returns a disposer that
 * removes exactly the highlight it created, so callers never need to track IDs themselves.
 */
export interface HighlightApi {
  highlight(targets: readonly HighlightTarget[], options: HighlightOptions): () => void;
}

/** No-op until the real 3D highlight API is integrated — never fakes a pointer at geometry that may not exist. */
export const NULL_HIGHLIGHT_API: HighlightApi = {
  highlight: () => () => {},
};

/** Plain-English fallback labels so hint captions read naturally before Agent 03's registry lands. */
export const DEFAULT_APPARATUS_LABELS: Readonly<Record<ApparatusKind, string>> = {
  BENCH: 'workbench',
  STAND: 'retort stand',
  CLAMP: 'burette clamp',
  BURETTE: 'burette',
  FLASK: 'conical flask',
  BEAKER: 'beaker',
  PIPETTE: 'pipette',
  STIRRER: 'magnetic stirrer',
  PH_PROBE: 'pH probe',
  BALANCE: 'balance',
  OTHER: 'apparatus',
};

export interface ApparatusLabelLookup {
  labelFor(kind: ApparatusKind, definitionId?: string): string;
}

export const DEFAULT_APPARATUS_LABEL_LOOKUP: ApparatusLabelLookup = {
  labelFor: (kind) => DEFAULT_APPARATUS_LABELS[kind],
};
