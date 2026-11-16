/**
 * Base solvent/solution tints: the color a liquid shows *before* any indicator dye is mixed in or
 * any pH-driven color change is applied (see `indicatorColor.ts`). These stand in for the handful
 * of common aqueous solutions used in the supported educational experiments (Section 1 of the
 * shared contract: acid-base titration, buffers, dilution, solubility, conductivity, simple
 * calorimetry). They are schematic colors for recognizable species, not a measurement of any
 * particular sample's absorbance, so every result here is ILLUSTRATIVE.
 *
 * `lab/fluids` never decides *which* tint applies — the species list comes from the authoritative
 * `ContainerContents.species` (Agent 06/07). This module only maps a known `speciesId` to a color a
 * reasonable lab photo would show.
 */
import type { Evidence } from '../contracts';

export interface LiquidTintResult {
  readonly colorHex: string;
  readonly evidence: Evidence;
  readonly note: string;
}

const WATER_CLEAR = '#eef6fb';

/**
 * Commonly recognized tints for a handful of visually distinctive species, keyed the way
 * `SpeciesAmount.speciesId` is expected to read (lowercase, hyphenated). Extend as Agent 06 lands
 * more species; an unlisted species id falls back to `genericAqueousTint`, not an invented color.
 */
const KNOWN_SPECIES_TINTS: Readonly<Record<string, { readonly colorHex: string; readonly note: string }>> = {
  'copper(ii)-sulfate': { colorHex: '#3E8FD6', note: 'Aqueous copper(II) sulfate is characteristically blue (hydrated Cu2+ complex).' },
  'potassium-permanganate': { colorHex: '#5B1E6E', note: 'Aqueous potassium permanganate is a deep, intense purple even at low concentration.' },
  'potassium-dichromate': { colorHex: '#E07B1A', note: 'Aqueous potassium dichromate is orange.' },
  'iron(iii)-chloride': { colorHex: '#C98A3A', note: 'Aqueous iron(III) chloride is yellow-brown/amber.' },
  'nickel(ii)-sulfate': { colorHex: '#6FC98A', note: 'Aqueous nickel(II) sulfate is green.' },
  'cobalt(ii)-chloride': { colorHex: '#D23F6B', note: 'Aqueous cobalt(II) chloride is pink/rose at typical dilution.' },
};

/**
 * Tint for a solution with no recognized distinctively-colored species: a faint, almost-colorless
 * blue-white, matching how dilute aqueous solutions actually look in a clear glass vessel (never
 * pure white, so the liquid still reads as a liquid against the glass).
 */
export function genericAqueousTint(): LiquidTintResult {
  return { colorHex: WATER_CLEAR, evidence: 'ILLUSTRATIVE', note: 'No recognized distinctively colored species; shown as a faint, near-colorless aqueous tint.' };
}

/**
 * Base tint for a container's liquid before any indicator is mixed in. Looks for the first
 * recognized distinctive species among `speciesIds` (as supplied by the authoritative container
 * contents) and falls back to the generic aqueous tint. Does not weigh concentration or mix
 * multiple colored species' tints — an acceptable simplification for a first implementation, noted
 * in `lab/fluids/README.md`.
 */
export function baseTintForSpecies(speciesIds: readonly string[]): LiquidTintResult {
  for (const id of speciesIds) {
    const known = KNOWN_SPECIES_TINTS[id];
    if (known) return { colorHex: known.colorHex, evidence: 'ILLUSTRATIVE', note: known.note };
  }
  return genericAqueousTint();
}
