/**
 * A small window onto the running harness for automated browser tests, mirroring `testApi.ts`'s
 * approach for the main application. Installed only by the harness entry point, never by the
 * production app bundle.
 */
import * as actions from '../environmentActions';
import { environment } from '../environmentStore';
import { cameraDirectorApi } from '../cameraDirectorApi';
import { layoutStations } from '../stations';
import { getHarnessDeviceInfo, harnessPerfMonitor } from './LabEnvironmentHarness';

export function installLabEnvironmentTestApi(): void {
  const api = {
    environment,
    actions,
    camera: cameraDirectorApi,
    device: getHarnessDeviceInfo,
    perf: () => harnessPerfMonitor().snapshot(),
    /** World positions of every station's slot, for assertions that do not want to re-derive the layout. */
    stationSlots: () =>
      layoutStations(environment.get().stations, environment.get().mode).map((slot) => ({
        id: slot.station.id,
        name: slot.station.name,
        index: slot.index,
        position: slot.origin.positionM,
        footprint: slot.footprintM,
      })),
  };
  (window as unknown as { __LAB_ENV__: typeof api }).__LAB_ENV__ = api;
}
