/**
 * Provisional PBR materials, keyed by the `materialSlot` names `geometry/**` builders emit.
 *
 * These exist so the component demo and other agents have *something* reasonable to look at —
 * Agent 05 owns glass/liquid shaders and Agent 01 owns the final visual-design tokens, and either
 * is expected to replace or restyle these. Nothing here is final art direction.
 */
import { DoubleSide } from 'three';

export type MaterialSpec =
  | { readonly kind: 'physical'; readonly props: Record<string, unknown> }
  | { readonly kind: 'standard'; readonly props: Record<string, unknown> };

const GLASS: MaterialSpec = {
  // Plain alpha transparency rather than physical `transmission`: transmission needs a proper
  // environment map to look glass-like at all (without one it renders as a flat, foggy white) and
  // is comparatively expensive, so a simple tinted, low-opacity material is the safer provisional
  // default — Agent 05's real glass/liquid shader is expected to replace this outright.
  kind: 'physical',
  props: { color: '#bfe4ea', roughness: 0.08, metalness: 0, transparent: true, opacity: 0.32, clearcoat: 0.5, side: DoubleSide },
};

const FROSTED_GLASS: MaterialSpec = {
  kind: 'physical',
  props: { color: '#eef6f5', roughness: 0.25, metalness: 0, transparent: true, opacity: 0.55, side: DoubleSide },
};

const BRUSHED_STEEL: MaterialSpec = { kind: 'standard', props: { color: '#9aa5b1', roughness: 0.35, metalness: 0.85 } };
const DARK_STEEL: MaterialSpec = { kind: 'standard', props: { color: '#43484f', roughness: 0.4, metalness: 0.6 } };
const RUBBER_PAD: MaterialSpec = { kind: 'standard', props: { color: '#1f2227', roughness: 0.85, metalness: 0 } };
const PTFE_PLASTIC: MaterialSpec = { kind: 'standard', props: { color: '#e8e3da', roughness: 0.45, metalness: 0 } };
const PTFE_PLASTIC_DARK: MaterialSpec = { kind: 'standard', props: { color: '#d3cdbf', roughness: 0.4, metalness: 0 } };
const WOOD_TOP: MaterialSpec = { kind: 'standard', props: { color: '#8a6a46', roughness: 0.55, metalness: 0 } };
const BOTTLE_CAP: MaterialSpec = { kind: 'standard', props: { color: '#2b4a6b', roughness: 0.5, metalness: 0 } };
const INSTRUMENT_BODY: MaterialSpec = { kind: 'standard', props: { color: '#2b2f36', roughness: 0.45, metalness: 0.3 } };
const CERAMIC_PLATE: MaterialSpec = { kind: 'standard', props: { color: '#e7e7e2', roughness: 0.3, metalness: 0.1 } };
const DARK_PLASTIC: MaterialSpec = { kind: 'standard', props: { color: '#15171b', roughness: 0.5, metalness: 0.2 } };
const PROBE_SHAFT: MaterialSpec = { kind: 'standard', props: { color: '#2d3339', roughness: 0.4, metalness: 0.1 } };

const MATERIAL_BY_SLOT: Readonly<Record<string, MaterialSpec>> = {
  glass: GLASS,
  'probe-bulb': FROSTED_GLASS,
  'stand-metal': BRUSHED_STEEL,
  'clamp-metal': BRUSHED_STEEL,
  'clamp-jaw-pad': RUBBER_PAD,
  'stopcock-body': PTFE_PLASTIC,
  'stopcock-key': PTFE_PLASTIC_DARK,
  'bench-top': WOOD_TOP,
  'bench-leg': DARK_STEEL,
  'cap-plastic': BOTTLE_CAP,
  'stirrer-body': INSTRUMENT_BODY,
  'stirrer-plate': CERAMIC_PLATE,
  'stirrer-knob': DARK_PLASTIC,
  'probe-shaft': PROBE_SHAFT,
  'probe-head': DARK_PLASTIC,
};

const FALLBACK: MaterialSpec = { kind: 'standard', props: { color: '#8892a0', roughness: 0.5, metalness: 0.1 } };

/** Looks up a provisional material for a geometry group's `materialSlot`. Never throws — an
 * unrecognized slot (e.g. from a future plugin definition) gets a neutral fallback instead of
 * blocking the asset from rendering at all. */
export function materialSpecForSlot(materialSlot: string): MaterialSpec {
  return MATERIAL_BY_SLOT[materialSlot] ?? FALLBACK;
}
