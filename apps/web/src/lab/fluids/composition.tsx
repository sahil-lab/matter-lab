import { Fragment, useMemo } from 'react';
import type { ReactNode } from 'react';
import { Quaternion as ThreeQuaternion, Vector3 } from 'three';
import type {
  ApparatusDefinition, ApparatusDefinitionReader, ApparatusInstance, RuntimeSnapshot, UUID, Vec3M,
} from '@matterlab/contracts';
import { TransferStream } from './TransferStream';
import { VesselLiquid } from './VesselLiquid';
import type { VesselLiquidProps } from './VesselLiquid';
import type { TransferPresentation } from './transfers';
import { transferPathSupported } from './transfers';
import { fluidScope } from './types';
import type { FluidVisualSettings, StirringState } from './types';

export function connectedStirring(snapshot: RuntimeSnapshot, vesselId: UUID): StirringState {
  const vessel = snapshot.scene.apparatus.find((instance) => instance.id === vesselId);
  if (!vessel) return undefined;
  const controls = snapshot.scene.connections.filter((connection) =>
    connection.enabled && connection.kind === 'CONTROL' && connection.to.instanceId === vesselId);
  const sources = controls.flatMap((connection) => {
    const source = snapshot.scene.apparatus.find((instance) => instance.id === connection.from.instanceId);
    return source?.stationId === vessel.stationId && source.capabilities.includes('STIRRING') ? [source] : [];
  });
  if (sources.length !== 1) return undefined;
  return snapshot.apparatusStates[sources[0]!.id]?.stirring;
}

export interface VesselFluidSlotProps {
  readonly snapshot: RuntimeSnapshot;
  readonly instance: ApparatusInstance;
  readonly definition: ApparatusDefinition;
  readonly settings?: FluidVisualSettings;
  readonly indicatorId?: string;
  readonly onStatus?: VesselLiquidProps['onStatus'];
}

export function VesselFluidSlot({ snapshot, instance, definition, settings, indicatorId, onStatus }: VesselFluidSlotProps) {
  const scope = fluidScope(snapshot, instance.stationId);
  if (!scope || !definition.vesselCalibration) return null;
  return <VesselLiquid definition={definition} instance={instance} scope={scope}
    contents={snapshot.scene.containerStates[instance.id]} observations={snapshot.observations}
    stirring={connectedStirring(snapshot, instance.id)} indicatorId={indicatorId}
    settings={settings} onStatus={onStatus} />;
}

export interface FluidTransferPath {
  readonly connectionId: UUID;
  readonly stationId: UUID;
  readonly sourceInstanceId: UUID;
  readonly receiverInstanceId: UUID;
  readonly sourceM: Vec3M;
  readonly receiverM: Vec3M;
  readonly supported: boolean;
}

export function fluidTransferPaths(snapshot: RuntimeSnapshot, definitions: ApparatusDefinitionReader): readonly FluidTransferPath[] {
  const instances = new Map(snapshot.scene.apparatus.map((instance) => [instance.id, instance]));
  const paths: FluidTransferPath[] = [];
  const worldPoint = (instance: ApparatusInstance, localM: Vec3M): Vec3M => {
    const point = new Vector3(...localM).applyQuaternion(new ThreeQuaternion(...instance.transform.quaternion));
    point.add(new Vector3(...instance.transform.positionM));
    return [point.x, point.y, point.z];
  };
  for (const edge of snapshot.scene.connections) {
    if (!edge.enabled || edge.kind !== 'FLUID') continue;
    const source = instances.get(edge.from.instanceId);
    const receiver = instances.get(edge.to.instanceId);
    if (!source || !receiver || source.stationId !== receiver.stationId) continue;
    const sourceSocket = definitions.getDefinition(source.definitionId)?.sockets.find((socket) => socket.id === edge.from.socketId && socket.kind === 'FLUID');
    const receiverSocket = definitions.getDefinition(receiver.definitionId)?.sockets.find((socket) => socket.id === edge.to.socketId && socket.kind === 'FLUID');
    if (!sourceSocket || !receiverSocket) continue;
    const sourceM = worldPoint(source, sourceSocket.localTransform.positionM);
    const receiverM = worldPoint(receiver, receiverSocket.localTransform.positionM);
    paths.push({
      connectionId: edge.id, stationId: source.stationId, sourceInstanceId: source.id,
      receiverInstanceId: receiver.id, sourceM, receiverM,
      supported: transferPathSupported(sourceM, receiverM),
    });
  }
  return paths;
}

export interface FluidTransferLayerProps {
  readonly snapshot: RuntimeSnapshot;
  readonly definitions: ApparatusDefinitionReader;
  readonly presentation: TransferPresentation;
  readonly stationId?: UUID;
  readonly settings?: FluidVisualSettings;
}

/** Add once at world level, outside the already-transformed apparatus models. */
export function FluidTransferLayer({ snapshot, definitions, presentation, stationId, settings }: FluidTransferLayerProps) {
  const paths = useMemo(() => fluidTransferPaths(snapshot, definitions), [snapshot, definitions]);
  return <group name="accepted-fluid-transfers" userData={{ evidence: 'ILLUSTRATIVE', units: 'm' }}>
    {paths.filter((path) => (!stationId || path.stationId === stationId) && path.supported).slice(0, 64).map((path) => {
      const scope = fluidScope(snapshot, path.stationId);
      return scope && <TransferStream key={path.connectionId} {...path}
        presentation={presentation} scope={scope} settings={settings} />;
    })}
  </group>;
}

export const FLUID_VISUAL_CASES = [
  { id: 'clear', requirement: 'Real unindicated contents; no indicatorState tint. Inspect against both light and dark backdrops.' },
  { id: 'tinted', requirement: 'Real supported PH and INDICATOR cohort from the same exact sequence; capture provenance.' },
  { id: 'burette-near-empty', requirement: 'A positive near-zero ledger volume and a separate zero-volume frame; no empty shell fill.' },
  { id: 'burette-full', requirement: 'Exactly capacity in the ledger; no meniscus/waves above the calibrated maximum.' },
  { id: 'transparent-overlap', requirement: 'Several authoritative vessels viewed close, mid-range, and during camera rotation.' },
  { id: 'stirring', requirement: 'An enabled CONTROL-linked authoritative stirrer, then pause, disable, low-power and reduced-motion frames.' },
  { id: 'endpoint-transition', requirement: 'Two actual solver indicator cohorts near endpoint; color follows exact records, never a pH threshold in visuals.' },
  { id: 'accepted-flow', requirement: 'Several accepted flows, then zero-accepted ADVANCE, closed valve, empty source, full receiver, pause/reset and new epoch.' },
  { id: 'unsupported-tilt', requirement: 'Non-upright apparatus: no invented horizontal/tilted fill; expose the unsupported status.' },
] as const;
export type FluidVisualCase = (typeof FLUID_VISUAL_CASES)[number]['id'];

export interface FluidRegressionFixtureProps extends FluidTransferLayerProps {
  readonly caseId: FluidVisualCase;
  /** Receives LOCAL children. The injected apparatus model applies instance.transform exactly once. */
  readonly renderVessel: (instance: ApparatusInstance, definition: ApparatusDefinition, children: ReactNode) => ReactNode;
  readonly indicatorId?: string;
}

/** Real-state composition fixture: no Canvas, bench, registry, chemistry, synthetic observations or runtime writer. */
export function FluidRegressionFixture({
  caseId, snapshot, definitions, presentation, renderVessel, stationId, settings, indicatorId,
}: FluidRegressionFixtureProps) {
  return <group name={`fluid-regression:${caseId}`} userData={{ units: 'm', fixture: true, caseId }}>
    {snapshot.scene.apparatus.filter((instance) => !stationId || instance.stationId === stationId).map((instance) => {
      const definition = definitions.getDefinition(instance.definitionId);
      if (!definition?.vesselCalibration) return null;
      return <Fragment key={instance.id}>{renderVessel(instance, definition,
        <VesselFluidSlot snapshot={snapshot} instance={instance} definition={definition} settings={settings} indicatorId={indicatorId} />)}
      </Fragment>;
    })}
    <FluidTransferLayer snapshot={snapshot} definitions={definitions} presentation={presentation} stationId={stationId} settings={settings} />
  </group>;
}
