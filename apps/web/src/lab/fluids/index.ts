/**
 * Public entry point for `lab/fluids` (Agent 05). Re-exports the shared-contract-shaped types
 * (`contracts.ts`), the R3F components Agents 02/04/07 compose a scene from, and the small set of
 * pure helpers (vessel profile builders, indicator/tint color mapping, quality resolution) another
 * agent is likely to need directly. Internal rendering details (lathe point conversion, meniscus
 * mesh building, droplet spawn bookkeeping) are intentionally left out of this barrel — they are
 * implementation details of the components above, not a contract another agent should depend on.
 */
export * from './contracts';

export {
  beakerProfile,
  buretteProfile,
  erlenmeyerFlaskProfile,
  heightForReadingML,
  heightForVolume,
  profilePointsUpTo,
  radiusAtHeight,
  readingML,
  reagentBottleProfile,
  volumeAtHeight,
} from './geometry/vesselProfile';

export { INDICATORS, blendLiquidColor, indicatorColorForPh, lerpHex } from './color/indicatorColor';
export type { IndicatorColorResult, IndicatorDef, IndicatorId, NamedIndicatorId } from './color/indicatorColor';
export { baseTintForSpecies, genericAqueousTint } from './color/liquidTint';
export type { LiquidTintResult } from './color/liquidTint';

export { FLUID_QUALITY, prefersReducedMotion, resolveFluidQuality, shouldAnimateSurface } from './quality/fluidQuality';
export type { FluidDeviceHints, FluidQualitySettings, FluidQualityTier } from './quality/fluidQuality';

export { dropletFallDurationS, dropletPositionAt } from './flow/dropletTiming';

export * from './components';
