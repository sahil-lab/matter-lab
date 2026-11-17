/**
 * Computes the placed transform of every apparatus instance in the demo scene: the shared vertical
 * slice (shared contract §6, step 1-2 — bench, stand, clamp, burette, stirrer, flask, bottle, pH
 * probe), plus a second station showing more of the P1 library in use (a support ring + funnel, a
 * graduated cylinder, a lab jack + balance, a dropper, a second dip sensor sharing the flask's
 * mouth). Pure data — no React, no rendering — so `demo/ApparatusShowcaseScene.tsx` and any future
 * test can both consume it, and so a reviewer can see the whole assembly's socket math in one place.
 */
import {
  BALANCE_STANDARD,
  BEAKER_250ML_LOW_FORM,
  BURETTE_50ML_CLASS_A,
  BURETTE_CLAMP_BOSS_HEAD,
  CONICAL_FLASK_250ML,
  DROPPER_STANDARD,
  FUNNEL_STANDARD,
  GRADUATED_CYLINDER_100ML,
  LAB_JACK_STANDARD,
  MAGNETIC_STIRRER_COMPACT,
  PH_PROBE_COMBINATION,
  REAGENT_BOTTLE_250ML,
  RETORT_STAND_600MM,
  SUPPORT_RING_STANDARD,
  THERMOMETER_STANDARD,
  WORKBENCH_STANDARD,
} from '../definitions';
import { computeAttachmentPlacement, evaluateSocketCompatibility } from '../sockets';
import { applyTransformToPoint, composeTransforms, invertTransform } from '../transforms';
import type { ApparatusDefinition, SocketDefinition, Transform } from '../types';
import { IDENTITY_TRANSFORM } from '../types';

function requireSocket(def: ApparatusDefinition, id: string): SocketDefinition {
  const socket = def.sockets.find((s) => s.id === id);
  if (!socket) throw new Error(`${def.id} has no socket "${id}"`);
  return socket;
}

/** The world (x, z) offset, in a 'planar' surface socket's own local XY plane, that places a point
 * at `targetWorldXZ` — the inverse of what `computeAttachmentPlacement`'s 'planar' branch applies.
 * Used so the stirrer (and the flask on top of it) can be positioned under the burette's tip
 * without hand-deriving the surface socket's rotation convention a second time. */
function planarOffsetForWorldXZ(surfaceWorldTransform: Transform, targetWorldXZ: readonly [number, number]): [number, number] {
  const inverse = invertTransform(surfaceWorldTransform);
  const [localX, localY] = applyTransformToPoint(inverse, [targetWorldXZ[0], surfaceWorldTransform.positionM[1], targetWorldXZ[1]]);
  return [localX, localY];
}

export interface PlacedInstance {
  readonly id: string;
  readonly definition: ApparatusDefinition;
  readonly transform: Transform;
}

export interface SocketCheckResult {
  readonly label: string;
  readonly compatible: boolean;
  readonly reason: string;
}

export interface VerticalSliceAssembly {
  readonly instances: readonly PlacedInstance[];
  readonly checks: readonly SocketCheckResult[];
}

export function buildVerticalSliceAssembly(): VerticalSliceAssembly {
  const benchWorld = IDENTITY_TRANSFORM;
  const benchTop = requireSocket(WORKBENCH_STANDARD, 'top-surface');

  const standPlacement = computeAttachmentPlacement(benchWorld, benchTop, requireSocket(RETORT_STAND_600MM, 'base'), { planarOffsetM: [-0.3, -0.12] });
  const standWorld = standPlacement.childOrigin;

  const clampPlacement = computeAttachmentPlacement(standWorld, requireSocket(RETORT_STAND_600MM, 'pole'), requireSocket(BURETTE_CLAMP_BOSS_HEAD, 'boss-head'), {
    axialOffsetM: 0.5,
    yawOffsetDeg: 90,
  });
  const clampWorld = clampPlacement.childOrigin;

  const burettePlacement = computeAttachmentPlacement(clampWorld, requireSocket(BURETTE_CLAMP_BOSS_HEAD, 'jaw'), requireSocket(BURETTE_50ML_CLASS_A, 'barrel'));
  const buretteWorld = burettePlacement.childOrigin; // the burette's own origin is its delivery tip (see definitions/burette.ts)

  const benchTopWorld = composeTransforms(benchWorld, benchTop.transform);
  const stirrerOffset = planarOffsetForWorldXZ(benchTopWorld, [buretteWorld.positionM[0], buretteWorld.positionM[2]]);
  const stirrerPlacement = computeAttachmentPlacement(benchWorld, benchTop, requireSocket(MAGNETIC_STIRRER_COMPACT, 'base'), { planarOffsetM: stirrerOffset });
  const stirrerWorld = stirrerPlacement.childOrigin;

  const flaskPlacement = computeAttachmentPlacement(stirrerWorld, requireSocket(MAGNETIC_STIRRER_COMPACT, 'plate'), requireSocket(CONICAL_FLASK_250ML, 'base'));
  const flaskWorld = flaskPlacement.childOrigin;

  const bottlePlacement = computeAttachmentPlacement(benchWorld, benchTop, requireSocket(REAGENT_BOTTLE_250ML, 'base'), { planarOffsetM: [0.35, 0.15] });
  const bottleWorld = bottlePlacement.childOrigin;

  // The pH probe is positioned by proximity, not a rigid socket solve (mate: 'proximity' — see
  // `sockets.ts`'s module doc): dipped in from above, just inside the flask's mouth.
  const flaskMouth = requireSocket(CONICAL_FLASK_250ML, 'sensor-access');
  const flaskMouthWorld = composeTransforms(flaskWorld, flaskMouth.transform);
  const probeWorld: Transform = { positionM: [flaskMouthWorld.positionM[0] + 0.01, flaskMouthWorld.positionM[1] + 0.05, flaskMouthWorld.positionM[2]], quaternion: [0, 0, 0, 1] };
  // The flask's sensor-access declares `maxConnections: 2`, so a thermometer can share it with the
  // pH probe (two independent dip sensors in the same open vessel is realistic).
  const thermometerWorld: Transform = { positionM: [flaskMouthWorld.positionM[0] - 0.015, flaskMouthWorld.positionM[1] + 0.08, flaskMouthWorld.positionM[2]], quaternion: [0, 0, 0, 1] };

  // A second, independent station: a support ring (on its own stand) cradling a funnel, a
  // graduated cylinder, and a lab jack carrying a balance — demonstrating the 'flat-surface' role
  // reused a third and fourth way (a ring, a jack platform) beyond the bench and stirrer plate.
  const secondStandPlacement = computeAttachmentPlacement(benchWorld, benchTop, requireSocket(RETORT_STAND_600MM, 'base'), { planarOffsetM: [0.42, -0.14] });
  const secondStandWorld = secondStandPlacement.childOrigin;
  const ringPlacement = computeAttachmentPlacement(secondStandWorld, requireSocket(RETORT_STAND_600MM, 'pole'), requireSocket(SUPPORT_RING_STANDARD, 'boss-head'), {
    axialOffsetM: 0.2,
    yawOffsetDeg: 180,
  });
  const ringWorld = ringPlacement.childOrigin;
  // The funnel has no modeled rigid rest (see definitions/funnel.ts) — placed visually at the
  // ring's own cradling socket, by proximity, not a rigid attachment solve.
  const ringSurfaceWorld = composeTransforms(ringWorld, requireSocket(SUPPORT_RING_STANDARD, 'ring-surface').transform);
  const funnelWorld = ringSurfaceWorld;

  const cylinderPlacement = computeAttachmentPlacement(benchWorld, benchTop, requireSocket(GRADUATED_CYLINDER_100ML, 'base'), { planarOffsetM: [0.42, 0.22] });
  const cylinderWorld = cylinderPlacement.childOrigin;

  const jackPlacement = computeAttachmentPlacement(benchWorld, benchTop, requireSocket(LAB_JACK_STANDARD, 'base'), { planarOffsetM: [-0.05, 0.25] });
  const jackWorld = jackPlacement.childOrigin;
  // A lab jack's real job is raising/lowering whatever sits on its platform (a vessel, here) —
  // not a balance, which belongs directly on the bench (see the balance placement below). A small
  // beaker's footprint fits the jack's platform; the balance's does not.
  const jackBeakerPlacement = computeAttachmentPlacement(jackWorld, requireSocket(LAB_JACK_STANDARD, 'platform'), requireSocket(BEAKER_250ML_LOW_FORM, 'base'));
  const jackBeakerWorld = jackBeakerPlacement.childOrigin;

  const balancePlacement = computeAttachmentPlacement(benchWorld, benchTop, requireSocket(BALANCE_STANDARD, 'base'), { planarOffsetM: [-0.25, 0.25] });
  const balanceWorld = balancePlacement.childOrigin;

  // The dropper is handheld — no mechanical rest — placed visually resting against the bottle.
  const dropperWorld: Transform = { positionM: [bottleWorld.positionM[0] + 0.05, bottleWorld.positionM[1] + 0.02, bottleWorld.positionM[2]], quaternion: [0, 0, Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)] };

  const checks: SocketCheckResult[] = [
    describeCheck('Stand pole \u2194 Clamp boss-head', RETORT_STAND_600MM, 'pole', BURETTE_CLAMP_BOSS_HEAD, 'boss-head'),
    describeCheck('Clamp jaw \u2194 Burette barrel', BURETTE_CLAMP_BOSS_HEAD, 'jaw', BURETTE_50ML_CLASS_A, 'barrel'),
    describeCheck('Clamp jaw \u2194 pH probe shaft (second mount path)', BURETTE_CLAMP_BOSS_HEAD, 'jaw', PH_PROBE_COMBINATION, 'shaft-mount'),
    describeCheck('Stirrer plate \u2194 Flask base', MAGNETIC_STIRRER_COMPACT, 'plate', CONICAL_FLASK_250ML, 'base'),
    describeCheck('Flask mouth \u2194 Burette tip (fluid)', CONICAL_FLASK_250ML, 'mouth-inlet', BURETTE_50ML_CLASS_A, 'tip-outlet'),
    describeCheck('Flask mouth \u2194 pH probe (sensor)', CONICAL_FLASK_250ML, 'sensor-access', PH_PROBE_COMBINATION, 'sensor-tip'),
    describeCheck('Stand pole \u2194 Support ring boss-head', RETORT_STAND_600MM, 'pole', SUPPORT_RING_STANDARD, 'boss-head'),
    describeCheck('Lab jack platform \u2194 Beaker base', LAB_JACK_STANDARD, 'platform', BEAKER_250ML_LOW_FORM, 'base'),
    describeCheck('Dropper tip \u2194 Flask mouth (fluid, adding a reagent drop)', DROPPER_STANDARD, 'tip-outlet', CONICAL_FLASK_250ML, 'mouth-inlet'),
    describeCheck('INVALID: Stand pole \u2194 Burette barrel (wrong role)', RETORT_STAND_600MM, 'pole', BURETTE_50ML_CLASS_A, 'barrel'),
    describeCheck('INVALID: Stand base \u2194 Stirrer plate (footprint too large)', MAGNETIC_STIRRER_COMPACT, 'plate', RETORT_STAND_600MM, 'base'),
    describeCheck('INVALID: Lab jack platform \u2194 Balance base (footprint too large)', LAB_JACK_STANDARD, 'platform', BALANCE_STANDARD, 'base'),
    describeCheck('INVALID: Reagent bottle neck \u2194 Dropper tip (both are outlets)', REAGENT_BOTTLE_250ML, 'neck-outlet', DROPPER_STANDARD, 'tip-outlet'),
  ];

  const instances: PlacedInstance[] = [
    { id: 'bench', definition: WORKBENCH_STANDARD, transform: benchWorld },
    { id: 'stand', definition: RETORT_STAND_600MM, transform: standWorld },
    { id: 'clamp', definition: BURETTE_CLAMP_BOSS_HEAD, transform: clampWorld },
    { id: 'burette', definition: BURETTE_50ML_CLASS_A, transform: buretteWorld },
    { id: 'stirrer', definition: MAGNETIC_STIRRER_COMPACT, transform: stirrerWorld },
    { id: 'flask', definition: CONICAL_FLASK_250ML, transform: flaskWorld },
    { id: 'bottle', definition: REAGENT_BOTTLE_250ML, transform: bottleWorld },
    { id: 'probe', definition: PH_PROBE_COMBINATION, transform: probeWorld },
    { id: 'thermometer', definition: THERMOMETER_STANDARD, transform: thermometerWorld },
    { id: 'second-stand', definition: RETORT_STAND_600MM, transform: secondStandWorld },
    { id: 'ring', definition: SUPPORT_RING_STANDARD, transform: ringWorld },
    { id: 'funnel', definition: FUNNEL_STANDARD, transform: funnelWorld },
    { id: 'cylinder', definition: GRADUATED_CYLINDER_100ML, transform: cylinderWorld },
    { id: 'jack-beaker', definition: BEAKER_250ML_LOW_FORM, transform: jackBeakerWorld },
    { id: 'jack', definition: LAB_JACK_STANDARD, transform: jackWorld },
    { id: 'balance', definition: BALANCE_STANDARD, transform: balanceWorld },
    { id: 'dropper', definition: DROPPER_STANDARD, transform: dropperWorld },
  ];

  return { instances, checks };
}

function describeCheck(label: string, defA: ApparatusDefinition, socketIdA: string, defB: ApparatusDefinition, socketIdB: string): SocketCheckResult {
  const result = evaluateSocketCompatibility({ definition: defA, socket: requireSocket(defA, socketIdA) }, { definition: defB, socket: requireSocket(defB, socketIdB) });
  return { label, compatible: result.compatible, reason: result.reason };
}
