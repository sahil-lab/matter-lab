import { parseExperimentScene } from '@matterlab/contracts';
import type { ExperimentScene, Station, UUID } from '@matterlab/contracts';

/** Draft creation starts a new run; it is not a hidden mutation or time reversal of a live runtime. */
export function addStationToDraft(scene: ExperimentScene, station: Station): ExperimentScene {
  return parseExperimentScene({ ...scene, stations: [...scene.stations, station] });
}
export function duplicateExperimentScene(scene: ExperimentScene, newId: () => UUID): ExperimentScene {
  const original = parseExperimentScene(scene);
  const ids = new Map<UUID, UUID>();
  for (const id of [original.id, ...original.stations.map((station) => station.id),
    ...original.apparatus.map((instance) => instance.id), ...original.connections.map((edge) => edge.id)]) ids.set(id, newId());
  return parseExperimentScene({
    ...original, id: ids.get(original.id), revision: 0,
    stations: original.stations.map((station) => ({ ...station, id: ids.get(station.id) })),
    apparatus: original.apparatus.map((instance) => ({
      ...instance, id: ids.get(instance.id), stationId: ids.get(instance.stationId), revision: 0,
    })),
    connections: original.connections.map((edge) => ({
      ...edge, id: ids.get(edge.id),
      from: { ...edge.from, instanceId: ids.get(edge.from.instanceId) },
      to: { ...edge.to, instanceId: ids.get(edge.to.instanceId) },
    })),
    containerStates: Object.fromEntries(Object.entries(original.containerStates).map(([id, contents]) => [ids.get(id), contents])),
  });
}
