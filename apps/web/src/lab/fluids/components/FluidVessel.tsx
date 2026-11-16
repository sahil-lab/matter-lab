/**
 * Composes the glass shell, liquid fill, graduation marks and an optional instrument readout into
 * one consumable vessel for Agents 02/04/07 — the main public surface of `lab/fluids`. It owns no
 * apparatus transform: the caller places this component's local origin at the vessel's own base
 * socket (e.g. a `<group position=... quaternion=...>` driven by `ApparatusInstance.transform`).
 */
import type { ContainerContents, Observation, VesselProfile } from '../contracts';
import type { FluidQualitySettings } from '../quality/fluidQuality';
import { readingML } from '../geometry/vesselProfile';
import { DropletStream } from './DropletStream';
import type { DropletStreamProps } from './DropletStream';
import { GlassVessel } from './GlassVessel';
import { GraduationMarks } from './GraduationMarks';
import { InstrumentReadout } from './InstrumentReadout';
import { LiquidBody } from './LiquidBody';

export interface FluidVesselProps {
  readonly profile: VesselProfile;
  /** Authoritative container contents; `null`/`undefined` renders the vessel empty. */
  readonly contents: ContainerContents | null | undefined;
  /** Final composited liquid color (base tint blended with any indicator reading). */
  readonly colorHex: string;
  readonly quality: FluidQualitySettings;
  /** 0 = still, 1 = vigorously stirred/swirled. Purely decorative. */
  readonly agitation?: number;
  readonly reducedMotion?: boolean;
  readonly showGraduations?: boolean;
  /** Optional outflow to visualize as a droplet stream leaving this vessel (e.g. a burette's tip). */
  readonly outflow?: DropletStreamProps['outflow'];
  readonly outflowResetSignal?: number;
  readonly probeObservation?: Observation | null;
  readonly probePositionM?: readonly [number, number, number];
  /** Optional body tint, e.g. the amber of a UV-protective reagent bottle. Omit for clear glass. */
  readonly glassTintHex?: string;
  /** Observability hook (e.g. for tests): called with the graduation's rendered current-reading value, or `null` when there is none. */
  readonly onCurrentReadingRendered?: (value: number | null) => void;
}

export function FluidVessel({
  profile,
  contents,
  colorHex,
  quality,
  agitation,
  reducedMotion,
  showGraduations = true,
  outflow,
  outflowResetSignal,
  probeObservation,
  probePositionM,
  glassTintHex,
  onCurrentReadingRendered,
}: FluidVesselProps) {
  const volumeL = contents?.volumeL ?? 0;
  const currentReadingML = profile.graduation ? readingML(profile, volumeL) : undefined;

  return (
    <group>
      <GlassVessel profile={profile} quality={quality} tintHex={glassTintHex} />
      <LiquidBody profile={profile} volumeL={volumeL} colorHex={colorHex} quality={quality} agitation={agitation} reducedMotion={reducedMotion} />
      {showGraduations && <GraduationMarks profile={profile} currentReadingML={currentReadingML} onCurrentReadingRendered={onCurrentReadingRendered} />}
      {outflow !== undefined && <DropletStream outflow={outflow} colorHex={colorHex} quality={quality} resetSignal={outflowResetSignal} />}
      {probeObservation && probePositionM && <InstrumentReadout observation={probeObservation} position={probePositionM} />}
    </group>
  );
}
