/**
 * MATTER LAB — Astra lab shell: sample data for previews and the component gallery.
 *
 * Nothing in this file is a scientific result. It exists so the UI Agent 01 owns can be
 * demonstrated end-to-end before Agent 02 (environment), Agent 03 (apparatus), Agent 06
 * (chemistry solver) and Agent 07 (experiment runtime) are integrated. Every value is tagged
 * `'ILLUSTRATIVE'` and the shell shows a persistent "sample data" watermark whenever it is in use
 * (see `store.ts`'s `previewDemoData`); the default, true state of the running shell is
 * "disconnected", not this data. Do not import this module from anywhere that could present its
 * numbers as a real titration result.
 */
import type { ApparatusSummary, ExperimentScene, Observation, RunResult } from './contracts';

export const DEMO_STATION_A = 'a10a0000-0000-4000-8000-000000000001';
export const DEMO_STATION_B = 'a10a0000-0000-4000-8000-000000000002';

/**
 * The P0 vertical-slice equipment from the Agent 03 brief, plus a representative slice of the P1
 * library, as placeholder catalog entries. `thumbnailGlyph` names a `lucide-react` icon standing
 * in for Agent 03's real rendered thumbnails.
 */
export const DEMO_APPARATUS_CATALOG: readonly ApparatusSummary[] = [
  { definitionId: 'bench.standard', kind: 'BENCH', label: 'Workbench', category: 'Structure', shortDescription: 'The flat, collidable surface every station is built on.', dimensionsM: { width: 1.2, height: 0.9, depth: 0.6 }, thumbnailGlyph: 'Table2', vertical_slice: true },
  { definitionId: 'stand.retort', kind: 'STAND', label: 'Retort stand', category: 'Structure', shortDescription: 'A weighted base and vertical rod that clamps mount to.', dimensionsM: { width: 0.18, height: 0.6, depth: 0.18 }, thumbnailGlyph: 'Columns3', vertical_slice: true },
  { definitionId: 'clamp.burette', kind: 'CLAMP', label: 'Burette clamp', category: 'Structure', shortDescription: 'Mounts to a stand pole; holds one burette barrel at a fixed height.', dimensionsM: { width: 0.12, height: 0.06, depth: 0.1 }, thumbnailGlyph: 'Grip', vertical_slice: true },
  { definitionId: 'burette.graduated.50ml', kind: 'BURETTE', label: 'Graduated burette, 50 mL', category: 'Glassware', shortDescription: 'Stopcock-controlled titrant delivery with a meniscus reference line.', dimensionsM: { width: 0.02, height: 0.65, depth: 0.02 }, thumbnailGlyph: 'TestTubeDiagonal', vertical_slice: true },
  { definitionId: 'flask.conical.250ml', kind: 'FLASK', label: 'Conical flask, 250 mL', category: 'Glassware', shortDescription: 'The receiving vessel for the titrated aliquot.', dimensionsM: { width: 0.09, height: 0.13, depth: 0.09 }, thumbnailGlyph: 'FlaskConical', vertical_slice: true },
  { definitionId: 'bottle.reagent.500ml', kind: 'OTHER', label: 'Reagent bottle, 500 mL', category: 'Glassware', shortDescription: 'Stores a prepared solution for filling other containers.', dimensionsM: { width: 0.07, height: 0.17, depth: 0.07 }, thumbnailGlyph: 'PillBottle', vertical_slice: true },
  { definitionId: 'stirrer.magnetic', kind: 'STIRRER', label: 'Magnetic stirrer', category: 'Instruments', shortDescription: 'Keeps the receiving flask well-mixed during a transfer.', dimensionsM: { width: 0.14, height: 0.05, depth: 0.14 }, thumbnailGlyph: 'Magnet', vertical_slice: true },
  { definitionId: 'probe.ph', kind: 'PH_PROBE', label: 'pH probe', category: 'Instruments', shortDescription: 'Reads solver-computed pH from the container it is dipped into.', dimensionsM: { width: 0.012, height: 0.18, depth: 0.012 }, thumbnailGlyph: 'Gauge', vertical_slice: true },
  { definitionId: 'beaker.100ml', kind: 'BEAKER', label: 'Beaker, 100 mL', category: 'Glassware', shortDescription: 'General-purpose open container.', thumbnailGlyph: 'Beaker' },
  { definitionId: 'flask.volumetric.100ml', kind: 'FLASK', label: 'Volumetric flask, 100 mL', category: 'Glassware', shortDescription: 'Precise single-mark volume for preparing solutions.', thumbnailGlyph: 'FlaskRound' },
  { definitionId: 'pipette.volumetric.25ml', kind: 'PIPETTE', label: 'Volumetric pipette, 25 mL', category: 'Glassware', shortDescription: 'Delivers one precise, fixed volume.', thumbnailGlyph: 'Pipette' },
  { definitionId: 'cylinder.graduated.50ml', kind: 'OTHER', label: 'Graduated cylinder, 50 mL', category: 'Glassware', shortDescription: 'Approximate-volume measurement by reading the meniscus.', thumbnailGlyph: 'TestTube2' },
  { definitionId: 'funnel.standard', kind: 'OTHER', label: 'Funnel', category: 'Glassware', shortDescription: 'Guides liquid into a narrow opening without spilling.', thumbnailGlyph: 'Funnel' },
  { definitionId: 'ring.support', kind: 'OTHER', label: 'Support ring', category: 'Structure', shortDescription: 'Mounts to a stand pole to carry a funnel or wire gauze.', thumbnailGlyph: 'CircleDashed' },
  { definitionId: 'sensor.thermometer', kind: 'OTHER', label: 'Thermometer', category: 'Instruments', shortDescription: 'Reads solver-computed solution temperature.', thumbnailGlyph: 'Thermometer' },
  { definitionId: 'sensor.conductivity', kind: 'OTHER', label: 'Conductivity meter', category: 'Instruments', shortDescription: 'Reads solver-computed solution conductivity, where supported.', thumbnailGlyph: 'CircleGauge' },
  { definitionId: 'balance.precision', kind: 'BALANCE', label: 'Balance', category: 'Instruments', shortDescription: 'Mass readout for solids and tare-weighed liquids.', thumbnailGlyph: 'Scale' },
];

/** A two-station scene: the vertical-slice titration assembly, plus a second, independent station. */
export function buildDemoScene(): ExperimentScene {
  const stirrer = 'a10a0000-0000-4000-8000-000000000103';
  const burette = 'a10a0000-0000-4000-8000-000000000102';
  const flask = 'a10a0000-0000-4000-8000-000000000104';
  return {
    id: 'a10a0000-0000-4000-8000-0000000000f0',
    revision: 7,
    schemaVersion: 1,
    stations: [
      { id: DEMO_STATION_A, name: 'Station A — HCl / NaOH titration' },
      { id: DEMO_STATION_B, name: 'Station B — independent setup' },
    ],
    apparatus: [
      { id: 'a10a0000-0000-4000-8000-000000000100', kind: 'BENCH', definitionId: 'bench.standard', transform: { positionM: [0, 0, 0], quaternion: [0, 0, 0, 1] }, revision: 1, config: {}, capabilities: [], stationId: DEMO_STATION_A },
      { id: 'a10a0000-0000-4000-8000-000000000101', kind: 'STAND', definitionId: 'stand.retort', transform: { positionM: [0.1, 0, 0], quaternion: [0, 0, 0, 1] }, revision: 1, config: {}, capabilities: ['MOUNT'], stationId: DEMO_STATION_A },
      { id: burette, kind: 'BURETTE', definitionId: 'burette.graduated.50ml', transform: { positionM: [0.1, 0.55, 0], quaternion: [0, 0, 0, 1] }, revision: 3, config: { capacityL: 0.05 }, capabilities: ['CONTAINER', 'FLOW_SOURCE', 'MOUNTABLE'], stationId: DEMO_STATION_A },
      { id: flask, kind: 'FLASK', definitionId: 'flask.conical.250ml', transform: { positionM: [0.1, 0.08, 0], quaternion: [0, 0, 0, 1] }, revision: 3, config: { capacityL: 0.25 }, capabilities: ['CONTAINER', 'FLOW_RECEIVER'], stationId: DEMO_STATION_A },
      { id: stirrer, kind: 'STIRRER', definitionId: 'stirrer.magnetic', transform: { positionM: [0.1, 0.02, 0], quaternion: [0, 0, 0, 1] }, revision: 1, config: { speedRpm: 300 }, capabilities: ['STIRRING', 'MOUNT'], stationId: DEMO_STATION_A },
      { id: 'a10a0000-0000-4000-8000-000000000105', kind: 'PH_PROBE', definitionId: 'probe.ph', transform: { positionM: [0.13, 0.1, 0], quaternion: [0, 0, 0, 1] }, revision: 2, config: {}, capabilities: ['PH_SENSOR', 'MOUNTABLE'], stationId: DEMO_STATION_A },
      { id: 'a10a0000-0000-4000-8000-000000000200', kind: 'BENCH', definitionId: 'bench.standard', transform: { positionM: [2, 0, 0], quaternion: [0, 0, 0, 1] }, revision: 1, config: {}, capabilities: [], stationId: DEMO_STATION_B },
    ],
    connections: [
      { id: 'a10a0000-0000-4000-8000-0000000000c1', from: { instanceId: 'a10a0000-0000-4000-8000-000000000101', socketId: 'pole-top' }, to: { instanceId: 'a10a0000-0000-4000-8000-000000000101', socketId: 'clamp-mount' }, kind: 'MECHANICAL', enabled: true },
      { id: 'a10a0000-0000-4000-8000-0000000000c2', from: { instanceId: burette, socketId: 'tip' }, to: { instanceId: flask, socketId: 'mouth' }, kind: 'FLUID', enabled: true },
    ],
    containerStates: {
      [burette]: { volumeL: 0.0312, species: [{ speciesId: 'NaOH(aq)', moles: 0.00312 }], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'strong-base-aqueous' },
      [flask]: { volumeL: 0.0438, species: [{ speciesId: 'Cl-(aq)', moles: 0.0025 }, { speciesId: 'Na+(aq)', moles: 0.00188 }], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'strong-acid-strong-base' },
    },
    simulationConfig: { methodId: 'strong-acid-strong-base-equilibrium', timeStepS: 0.1 },
  };
}

/**
 * A synthetic monotonic curve for preview purposes only: a generic logistic function with an
 * arbitrary inflection and no acid/base equilibrium math anywhere in it (no Ka, Kb, or
 * Henderson–Hasselbalch term). It must never be read as a titration calculation — it is only
 * shaped like one so the HUD and chart have something plausible-looking to lay out around.
 */
function illustrativeSamplePh(deliveredMl: number, equivalenceMl: number): number {
  const span = 2.2;
  const low = 1.6;
  const high = 12.6;
  const t = (deliveredMl - equivalenceMl) / span;
  const sigmoid = 1 / (1 + Math.exp(-t));
  return Math.min(high, Math.max(low, low + (high - low) * sigmoid));
}

/** `count` observations of delivered volume and illustrative pH, evenly spaced to `uptoMl`. */
export function buildDemoObservations(uptoMl: number, count: number, equivalenceMl = 25, endpointMl = equivalenceMl + 0.18): Observation[] {
  const observations: Observation[] = [];
  // Includes the exact equivalence and endpoint volumes among the sampled points, so the chart's
  // markers always land on an actually-plotted point instead of falling between two samples.
  const volumesMl = [...Array.from({ length: count + 1 }, (_, i) => (uptoMl * i) / count), equivalenceMl, endpointMl].sort((a, b) => a - b);
  volumesMl.forEach((ml, i) => {
    const timeS = i * 2.5;
    observations.push({ type: 'VOLUME', timeS, quantity: { value: ml / 1000, unit: 'L' }, evidence: 'ILLUSTRATIVE', methodId: 'sample-preview', sourceIds: ['sample-preview'] });
    observations.push({ type: 'PH', timeS, quantity: { value: illustrativeSamplePh(ml, equivalenceMl), unit: 'pH' }, evidence: 'ILLUSTRATIVE', methodId: 'sample-preview', sourceIds: ['sample-preview'] });
  });
  return observations;
}

export function buildDemoRunResult(observations: readonly Observation[], equivalenceMl = 25, endpointMl = equivalenceMl + 0.18): RunResult {
  return {
    runId: 'a10a0000-0000-4000-8000-0000000000e1',
    status: 'SUCCEEDED',
    methodId: 'sample-preview',
    methodVersion: '0.0.0-preview',
    inputHash: 'preview',
    observations,
    warnings: ['This run is sample preview data for the Agent 01 component gallery — it is not a scientific result.'],
    assumptions: ['Illustrative logistic curve, not an equilibrium solution.', 'Ideal dilute solution would be assumed by a real run.'],
    solverDiagnostics: { equivalenceVolumeL: equivalenceMl / 1000, endpointVolumeL: endpointMl / 1000 },
  };
}
