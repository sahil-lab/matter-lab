/**
 * PROVISIONAL STUB — owned by Agent 06 ("Scientific Simulation Engineer") per
 * `Agent_06_Scientific_Chemistry_and_Titration_Engine.md`, whose real solver lives in
 * `services/science/titration/**` (Python, RDKit/xTB/PySCF-adjacent). That service is not reachable
 * from `apps/web` yet (see `docs/architecture.md`: "The web application does not call the
 * service."), so this file implements only the ideal strong-acid/strong-base closed-form equation
 * — the exact system the shared contract's vertical slice calls for (Section 6: "25.00 mL, 0.100
 * mol/L HCl ... 0.100 mol/L NaOH ... equivalence at 25.00 mL and pH approximately 7") — so Agent 04
 * can exercise placement → fill → valve → transfer → pH → plot end to end.
 *
 * This is a real, correct equation for the stated ideal case (charge balance + water autoionization
 * for a monoprotic strong acid/strong base mixture), not a fitted curve or random walk. It is
 * intentionally narrow: anything outside the known strong-electrolyte list is refused as
 * `UNSUPPORTED` rather than guessed. Every result is labeled `UNVERIFIED` (never `MODEL_CALCULATED`)
 * because Agent 06 has not reviewed it. Replace this file with a call into the real service when
 * Agent 07/09 wire up `services/science/titration`.
 */

export const KW_298K = 1.0e-14;
export const SUPPORTED_TEMPERATURE_K = 298.15;

export interface SpeciesAmountLike {
  readonly speciesId: string;
  readonly moles: number;
}

export type PhResult = { readonly supported: true; readonly pH: number } | { readonly supported: false; readonly reason: string };

/** Fully dissociating 1:1 strong electrolytes the stub recognises. Anything else is `UNSUPPORTED`. */
const STRONG_ACIDS: ReadonlySet<string> = new Set(['HCl', 'HNO3', 'HBr', 'HI']);
const STRONG_BASES: ReadonlySet<string> = new Set(['NaOH', 'KOH']);

/**
 * pH of a well-mixed solution of monoprotic strong acid(s)/base(s) in water, from charge balance
 * ([H+] + [cation] = [OH-] + [anion]) and water autoionization ([H+][OH-] = Kw). Solved as the
 * positive root of H+ - Kw/H+ = netAcidConcentration, branching to avoid catastrophic cancellation
 * when the net concentration is large and negative (excess base).
 */
export function computeStrongAcidBasePh(species: readonly SpeciesAmountLike[], volumeL: number, temperatureK: number): PhResult {
  if (!(volumeL > 0)) return { supported: false, reason: 'The container has no volume.' };
  if (Math.abs(temperatureK - SUPPORTED_TEMPERATURE_K) > 0.5) {
    return { supported: false, reason: `This stub only covers ${SUPPORTED_TEMPERATURE_K} K; Kw temperature dependence is pending Agent 06.` };
  }
  let acidMoles = 0;
  let baseMoles = 0;
  for (const s of species) {
    if (s.moles < 0) return { supported: false, reason: `Species "${s.speciesId}" has negative moles.` };
    if (STRONG_ACIDS.has(s.speciesId)) acidMoles += s.moles;
    else if (STRONG_BASES.has(s.speciesId)) baseMoles += s.moles;
    else return { supported: false, reason: `Species "${s.speciesId}" is outside the stub's strong acid/base list; pending Agent 06's validated solver.` };
  }
  const net = (acidMoles - baseMoles) / volumeL;
  const kw = KW_298K;
  let hPlus: number;
  if (net >= 0) {
    hPlus = (net + Math.sqrt(net * net + 4 * kw)) / 2;
  } else {
    const n = -net;
    const oh = (n + Math.sqrt(n * n + 4 * kw)) / 2;
    hPlus = kw / oh;
  }
  if (!(hPlus > 0) || !Number.isFinite(hPlus)) return { supported: false, reason: 'The stub model could not resolve a stable hydrogen ion concentration for this input.' };
  return { supported: true, pH: -Math.log10(hPlus) };
}

export function isKnownStrongElectrolyte(speciesId: string): boolean {
  return STRONG_ACIDS.has(speciesId) || STRONG_BASES.has(speciesId);
}
