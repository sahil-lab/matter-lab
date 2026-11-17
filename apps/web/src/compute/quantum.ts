import { getElement, sortedAtoms } from '@matterlab/core';
import type { AtomId, Scene, Vec3 } from '@matterlab/core';
import type { QmInput, ScfResult } from '@matterlab/quantum';
import { create } from 'zustand';
import { DENSITY_COLOR, PHASE_NEGATIVE, PHASE_POSITIVE, SCALE_DENSITY, SCALE_PHASE, SCALE_POTENTIAL, SCALE_POTENTIAL_PLANE, hexToRgb, scaleTexels, srgbToLinear, vertexColors } from '../render/colormap';
import type { ColorScale } from '../render/colormap';
import { stageApi } from '../render/viewApi';
import type { StageCloud, StageSlice, StageSurface, StageVolume } from '../render/viewApi';
import { cancelJobsOfKind, runJob } from '../science/jobs';
import { UnsupportedSystem, fields, quantumSupport, quantumSystem, runScf } from '../science/quantum';
import { JobCancelledError } from '../science/rpc';
import type { CallOptions } from '../science/rpc';
import { notify, selectOnly } from '../state/actions';
import { lab } from '../state/store';
import type {
  CloudResponse,
  EspSurfaceResponse,
  FieldProgress,
  FieldSpec,
  GridRequest,
  MolecularSurfaceResponse,
  PointField,
  SliceResponse,
  SurfacePart,
  SurfaceResponse,
  VolumeResponse,
  Wavefunction,
} from '../workers/quantum.worker';
import { orbitalLabel } from './orbitals';
import type { ComputeProblem } from './store';

/** A finished Hartree-Fock calculation and the structure it was done for. */
export interface QuantumRecord {
  readonly id: string;
  readonly scene: Scene;
  /** Scene atom behind each atom of the calculation. */
  readonly atomIds: readonly AtomId[];
  readonly input: QmInput;
  readonly result: ScfResult;
  readonly elapsedMs: number;
}

export interface QuantumProgress {
  readonly phase: 'integrals' | 'scf' | 'properties';
  /** Fraction of the phase, 0..1. */
  readonly fraction: number;
  readonly iteration: number | null;
  /** hartree */
  readonly energy: number | null;
  readonly deltaEnergy: number | null;
}

export type FieldKind = 'off' | 'orbital' | 'density' | 'potential';
export type FieldStyle = 'surface' | 'cloud' | 'volume';
export type SliceField = 'density' | 'orbital' | 'potential';
export type SliceAxis = 'x' | 'y' | 'z' | 'atoms';
export type MolecularSurfaceKind = 'vdw' | 'sas';

export interface FieldSettings {
  readonly kind: FieldKind;
  readonly style: FieldStyle;
  /** Index of the molecular orbital shown. */
  readonly orbital: number;
  /** Isovalue of the orbital lobes, bohr^(-3/2). */
  readonly orbitalIso: number;
  /** Isovalue of the density surface, e/bohr^3. */
  readonly densityIso: number;
  /** Density isovalue of the surface the potential is mapped on, e/bohr^3. */
  readonly potentialIso: number;
  /** Half-width of the potential colour scale in hartree/e, or `null` to take it from the data. */
  readonly potentialRange: number | null;
  readonly opacity: number;
  /** Number of dots of a dot cloud. */
  readonly dots: number;
}

export interface SliceSettings {
  readonly enabled: boolean;
  readonly field: SliceField;
  readonly axis: SliceAxis;
  /** The three atoms that define the plane when `axis` is `atoms`. */
  readonly atoms: readonly AtomId[] | null;
  /** Displacement along the plane's normal, angstrom. */
  readonly offset: number;
  /** Remove the part of every surface in front of the plane. */
  readonly cut: boolean;
  readonly flipped: boolean;
}

export interface MolecularSettings {
  readonly enabled: boolean;
  readonly kind: MolecularSurfaceKind;
  readonly coloring: 'element' | 'plain';
  readonly opacity: number;
}

/** What the field display on stage is made of, for the legend and the read-outs. */
export interface FieldInfo {
  readonly kind: Exclude<FieldKind, 'off'>;
  readonly style: FieldStyle;
  readonly orbital: number | null;
  /** The isovalue of the surface on stage; `null` for a dot cloud. */
  readonly isoValue: number | null;
  readonly parts: ReadonlyArray<Pick<SurfacePart, 'sign' | 'area' | 'volume' | 'closed'> & { readonly triangles: number }>;
  /** angstrom */
  readonly gridSpacing: number;
  /** Potential on the surface, hartree/e. */
  readonly potentialMin: number | null;
  readonly potentialMax: number | null;
  /** Half-width of the colour scale in use, hartree/e. */
  readonly potentialRange: number | null;
  readonly dots: number | null;
  /** Electrons (density) or probability (orbital) inside the sampled box, as integrated on the grid. */
  readonly captured: number | null;
  readonly elapsedMs: number;
}

export type SliceScale =
  | { readonly kind: 'log'; readonly low: number; readonly high: number }
  | { readonly kind: 'symmetric'; readonly range: number };

export interface SliceInfo {
  readonly field: SliceField;
  readonly orbital: number | null;
  readonly scale: SliceScale;
  /** Extremes of the field on the plane, in the field's own unit. */
  readonly min: number;
  readonly max: number;
  readonly center: Vec3;
  readonly normal: Vec3;
  /** angstrom */
  readonly width: number;
  readonly height: number;
  readonly columns: number;
  readonly rows: number;
  /** How far the plane can usefully be moved along its normal. */
  readonly offsetRange: readonly [number, number];
}

export interface MolecularInfo {
  readonly kind: MolecularSurfaceKind;
  /** angstrom */
  readonly probe: number;
  /** angstrom squared */
  readonly area: number;
  /** angstrom cubed */
  readonly volume: number;
  readonly closed: boolean;
  readonly gridSpacing: number;
  readonly atoms: number;
}

interface QuantumState {
  readonly running: boolean;
  readonly progress: QuantumProgress | null;
  readonly record: QuantumRecord | null;
  readonly problem: ComputeProblem | null;

  readonly field: FieldSettings;
  readonly fieldBusy: boolean;
  readonly fieldProgress: FieldProgress | null;
  readonly fieldInfo: FieldInfo | null;
  readonly fieldError: string | null;

  readonly slice: SliceSettings;
  readonly sliceBusy: boolean;
  readonly sliceInfo: SliceInfo | null;
  readonly sliceError: string | null;

  readonly molecular: MolecularSettings;
  readonly molecularBusy: boolean;
  readonly molecularInfo: MolecularInfo | null;
  readonly molecularError: string | null;
}

/** Radius of a water-sized probe, the customary choice for a solvent-accessible surface. */
export const PROBE_RADIUS = 1.4;
/** Largest structure a molecular surface is offered for. */
export const MOLECULAR_SURFACE_ATOM_LIMIT = 6000;
/** Density range of the cutting plane's logarithmic scale, e/bohr^3. */
export const DENSITY_SCALE = { low: 1e-3, high: 1 } as const;

export const ISO_LIMITS = {
  orbital: { min: 0.005, max: 0.3 },
  density: { min: 0.0005, max: 0.5 },
  potential: { min: 0.0005, max: 0.05 },
} as const;

export const useQuantum = create<QuantumState>()(() => ({
  running: false,
  progress: null,
  record: null,
  problem: null,

  field: { kind: 'off', style: 'surface', orbital: 0, orbitalIso: 0.05, densityIso: 0.02, potentialIso: 0.002, potentialRange: null, opacity: 0.62, dots: 40000 },
  fieldBusy: false,
  fieldProgress: null,
  fieldInfo: null,
  fieldError: null,

  slice: { enabled: false, field: 'density', axis: 'z', atoms: null, offset: 0, cut: false, flipped: false },
  sliceBusy: false,
  sliceInfo: null,
  sliceError: null,

  molecular: { enabled: false, kind: 'vdw', coloring: 'element', opacity: 0.55 },
  molecularBusy: false,
  molecularInfo: null,
  molecularError: null,
}));

const set = useQuantum.setState;
const get = useQuantum.getState;

/** True while the structure on screen is the one the calculation was done for. */
export function quantumIsCurrent(record: QuantumRecord | null, scene: Scene): record is QuantumRecord {
  return record !== null && record.scene === scene;
}

export function currentRecord(): QuantumRecord | null {
  const state = lab.get();
  const record = get().record;
  return state.workspace === 'architect' && quantumIsCurrent(record, state.scene) ? record : null;
}

export { orbitalLabel };

/** The smallest "round" number that is at least `x`, so that a scale ends on a readable value. */
export function niceCeil(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  const exponent = Math.floor(Math.log10(x));
  const mantissa = x / 10 ** exponent;
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m >= mantissa - 1e-9) ?? 10;
  return Number((step * 10 ** exponent).toPrecision(3));
}

// ---------- running the calculation ----------

let recordCounter = 0;
/** Set once the user has chosen what to show, so a new calculation does not override that choice. */
let fieldChosen = false;

/** Runs restricted Hartree-Fock (STO-3G) on the structure in the Architect. */
export async function runQuantum(): Promise<void> {
  const state = lab.get();
  if (state.workspace !== 'architect' || get().running) return;
  const scene = state.scene;
  if (scene.atoms.size === 0) {
    notify('info', 'There is nothing to calculate yet');
    return;
  }
  const system = quantumSystem(scene);
  const support = quantumSupport(scene, system);
  if (!support.supported) {
    set({ problem: { title: 'This structure is outside what the quantum engine can treat.', details: support.reasons, atomIds: support.unsupportedAtoms } });
    if (support.unsupportedAtoms.length > 0) selectOnly(support.unsupportedAtoms);
    return;
  }
  set({ running: true, progress: null, problem: null });
  const started = performance.now();
  try {
    const result = await runJob(
      { kind: 'quantum', title: 'Electronic structure', detail: `RHF/STO-3G · ${support.nBasis} basis functions · ${support.nElectrons} electrons` },
      ({ signal, report }) =>
        runScf(system.input, {
          signal,
          onProgress: (progress) => {
            const previous = get().progress;
            const next: QuantumProgress = {
              phase: progress.phase,
              fraction: progress.fraction,
              iteration: progress.iteration?.iteration ?? (progress.phase === 'integrals' ? null : (previous?.iteration ?? null)),
              energy: progress.iteration?.energy ?? (progress.phase === 'integrals' ? null : (previous?.energy ?? null)),
              deltaEnergy: progress.iteration?.deltaEnergy ?? (progress.phase === 'integrals' ? null : (previous?.deltaEnergy ?? null)),
            };
            set({ progress: next });
            if (next.phase === 'integrals') report(0.7 * next.fraction, `integrals ${Math.round(next.fraction * 100)} %`);
            else if (next.phase === 'scf') report(null, next.iteration ? `iteration ${next.iteration}` : 'self-consistent field');
            else report(0.97, 'properties');
          },
        }),
    );
    const record: QuantumRecord = { id: `scf-${++recordCounter}`, scene, atomIds: system.atomIds, input: system.input, result, elapsedMs: performance.now() - started };
    set({ running: false, progress: null, record });
    if (lab.get().scene !== scene || lab.get().workspace !== 'architect') {
      notify('info', 'The calculation finished for an earlier structure', 'The structure was edited while it ran, so the result is not shown.');
      return;
    }
    const orbital = Math.min(result.nBasis - 1, Math.max(0, fieldChosen ? get().field.orbital : result.homoIndex));
    // The first result puts the highest occupied orbital on stage; after that the user's choice stands.
    set((s) => ({ field: { ...s.field, orbital, kind: fieldChosen ? s.field.kind : 'orbital' } }));
    refreshAll();
    if (!result.converged) {
      notify('warning', 'The calculation did not converge', 'The numbers shown belong to the last iteration and should not be trusted.');
    }
  } catch (error) {
    if (error instanceof JobCancelledError) {
      set({ running: false, progress: null });
      return;
    }
    const problem: ComputeProblem =
      error instanceof UnsupportedSystem
        ? { title: 'This structure is outside what the quantum engine can treat.', details: error.reasons, atomIds: [] }
        : { title: 'The calculation failed', details: [error instanceof Error ? error.message : String(error)], atomIds: [] };
    set({ running: false, progress: null, problem });
  }
}

export function cancelQuantum(): void {
  cancelJobsOfKind('quantum');
}

export function dismissQuantumProblem(): void {
  set({ problem: null });
}

// ---------- what is on stage ----------

/** A queue that only ever keeps the newest request: slider movements must not pile up. */
function latestOnly(): (task: () => Promise<void>) => void {
  let running = false;
  let waiting: (() => Promise<void>) | null = null;
  return (task) => {
    if (running) {
      waiting = task;
      return;
    }
    running = true;
    void (async () => {
      let next: (() => Promise<void>) | null = task;
      while (next) {
        const current = next;
        waiting = null;
        try {
          await current();
        } catch {
          // Each task reports its own failure.
        }
        next = waiting;
      }
      running = false;
    })();
  };
}

const fieldQueue = latestOnly();
const sliceQueue = latestOnly();
const molecularQueue = latestOnly();

const FIELD_GRID: GridRequest = { spacing: 0.14, padding: 3.2, maxPoints: 700_000 };
const POTENTIAL_GRID: GridRequest = { spacing: 0.18, padding: 3.0, maxPoints: 500_000 };
/** The potential is evaluated at every vertex of its surface; at up to 0.2 ms each this bounds the wait to about three seconds. */
const POTENTIAL_MAX_VERTICES = 14000;

/**
 * Longest side, in samples, of a cutting plane that shows the electrostatic potential. One point
 * costs between 0.015 ms (water) and 0.2 ms (the largest systems the engine accepts), as measured
 * in the browser, so the resolution is chosen to keep the wait near two and a half seconds.
 */
function potentialPlaneSamples(nBasis: number, aspect: number): number {
  const millisecondsPerPoint = Math.min(0.2, 0.0028 * nBasis);
  const points = Math.min(40_000, 2500 / millisecondsPerPoint);
  return Math.round(Math.min(200, Math.max(84, Math.sqrt(points * Math.max(aspect, 1 / aspect)))));
}

interface FieldData {
  /** Everything the worker's answer depends on. */
  readonly key: string;
  readonly recordId: string;
  readonly kind: Exclude<FieldKind, 'off'>;
  readonly style: FieldStyle;
  readonly orbital: number | null;
  readonly isoValue: number | null;
  readonly surface?: SurfaceResponse;
  readonly potential?: EspSurfaceResponse;
  readonly cloud?: CloudResponse;
  readonly volume?: VolumeResponse;
}

let fieldData: FieldData | null = null;
/** The field last sampled, to tell a quick re-meshing from a new evaluation. */
let sampledKey = '';
let potentialColors: { readonly source: Float32Array; readonly range: number; readonly colors: Float32Array } | null = null;

interface SliceFrame {
  readonly center: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  readonly normal: Vec3;
  readonly width: number;
  readonly height: number;
  readonly offsetRange: readonly [number, number];
}

interface SliceData {
  readonly key: string;
  readonly recordId: string;
  readonly field: SliceField;
  readonly orbital: number | null;
  readonly frame: SliceFrame;
  readonly response: SliceResponse;
}

let sliceData: SliceData | null = null;
let slicePlaced: { readonly source: Float32Array; readonly scaleKey: string; readonly positions: Float32Array } | null = null;
const scaleTexelCache = new Map<string, Uint8Array>();

interface MolecularData {
  readonly key: string;
  readonly scene: Scene;
  readonly kind: MolecularSurfaceKind;
  readonly response: MolecularSurfaceResponse;
  /** Linear-light element colour of every vertex. */
  readonly elementColors: Float32Array;
}

let molecularData: MolecularData | null = null;

const wavefunctionOf = (record: QuantumRecord): Wavefunction => ({ id: record.id, result: record.result, input: record.input });

function fieldKey(record: QuantumRecord, field: FieldSettings): string {
  if (field.kind === 'potential') return `${record.id}|potential|${field.potentialIso}`;
  const which = field.kind === 'orbital' ? `orbital ${field.orbital}` : 'density';
  if (field.style === 'volume') return `${record.id}|${which}|volume`;
  return field.style === 'cloud' ? `${record.id}|${which}|cloud|${field.dots}` : `${record.id}|${which}|surface|${field.kind === 'orbital' ? field.orbitalIso : field.densityIso}`;
}

function texelsOf(scale: ColorScale): Uint8Array {
  let texels = scaleTexelCache.get(scale.id);
  if (!texels) {
    texels = scaleTexels(scale);
    scaleTexelCache.set(scale.id, texels);
  }
  return texels;
}

/** Half-width of the potential colour scale: the user's, or the largest magnitude on the surface, rounded up. */
function potentialRangeFor(settings: FieldSettings, response: EspSurfaceResponse | undefined): number {
  if (settings.potentialRange !== null) return settings.potentialRange;
  return response ? niceCeil(Math.max(Math.abs(response.min), Math.abs(response.max), 1e-6)) : 0.1;
}

function fieldSurfaces(): StageSurface[] {
  const data = fieldData;
  const record = currentRecord();
  const settings = get().field;
  if (!data || !record || data.recordId !== record.id || settings.kind !== data.kind) return [];
  if (data.surface) {
    return data.surface.parts.map((part) => ({
      id: part.sign > 0 ? 'field-positive' : 'field-negative',
      positions: part.positions,
      normals: part.normals,
      indices: part.indices,
      color: data.kind === 'density' ? DENSITY_COLOR : part.sign > 0 ? PHASE_POSITIVE : PHASE_NEGATIVE,
      opacity: settings.opacity,
      finish: 'glass',
    }));
  }
  if (data.potential) {
    const { part, potential } = data.potential;
    const range = potentialRangeFor(settings, data.potential);
    if (!potentialColors || potentialColors.source !== potential || potentialColors.range !== range) {
      potentialColors = {
        source: potential,
        range,
        colors: vertexColors(SCALE_POTENTIAL, potential.length, (i) => 0.5 + 0.5 * Math.min(1, Math.max(-1, potential[i]! / range))),
      };
    }
    return [{ id: 'field-potential', positions: part.positions, normals: part.normals, indices: part.indices, color: '#ffffff', colors: potentialColors.colors, opacity: settings.opacity, finish: 'matte' }];
  }
  return [];
}

function fieldCloud(): StageCloud | null {
  const data = fieldData;
  const record = currentRecord();
  const settings = get().field;
  if (!data?.cloud || !record || data.recordId !== record.id || settings.kind !== data.kind) return null;
  return {
    positions: data.cloud.positions,
    ...(data.cloud.signs ? { signs: data.cloud.signs } : {}),
    colorPositive: data.kind === 'density' ? DENSITY_COLOR : PHASE_POSITIVE,
    colorNegative: PHASE_NEGATIVE,
    // Small and faint, so that thousands of them read as a mist and the atoms stay visible through it.
    size: 0.022,
    opacity: 0.12 + settings.opacity * 0.6,
  };
}

function fieldVolume(): StageVolume | null {
  const data = fieldData;
  const record = currentRecord();
  const settings = get().field;
  if (!data?.volume || !record || data.recordId !== record.id || settings.kind !== data.kind || settings.style !== 'volume') return null;
  return {
    values: data.volume.values, dimensions: data.volume.grid.dims,
    origin: data.volume.grid.origin, spacing: data.volume.grid.spacing,
    referenceValue: settings.kind === 'orbital' ? settings.orbitalIso : settings.densityIso,
    colorPositive: settings.kind === 'orbital' ? PHASE_POSITIVE : DENSITY_COLOR, colorNegative: PHASE_NEGATIVE,
    opacity: settings.opacity,
  };
}

function molecularSurfaces(): StageSurface[] {
  const data = molecularData;
  const settings = get().molecular;
  const state = lab.get();
  if (!data || !settings.enabled || state.workspace !== 'architect' || data.scene !== state.scene || data.kind !== settings.kind) return [];
  const { part } = data.response;
  const byElement = settings.coloring === 'element';
  return [
    {
      id: 'molecular',
      positions: part.positions,
      normals: part.normals,
      indices: part.indices,
      color: '#9fb6d6',
      ...(byElement ? { colors: data.elementColors } : {}),
      opacity: settings.opacity,
      finish: byElement ? 'matte' : 'glass',
    },
  ];
}

function sliceOnStage(): StageSlice | null {
  const data = sliceData;
  const record = currentRecord();
  const info = get().sliceInfo;
  if (!data || !record || !info || data.recordId !== record.id || !get().slice.enabled) return null;
  const { values } = data.response;
  const scale = info.scale;
  const colorScale = data.field === 'density' ? SCALE_DENSITY : data.field === 'orbital' ? SCALE_PHASE : SCALE_POTENTIAL_PLANE;
  const scaleKey = scale.kind === 'log' ? `log ${scale.low} ${scale.high}` : `symmetric ${scale.range}`;
  if (!slicePlaced || slicePlaced.source !== values || slicePlaced.scaleKey !== scaleKey) {
    const positions = new Float32Array(values.length);
    if (scale.kind === 'log') {
      const low = Math.log10(scale.low);
      const span = Math.log10(scale.high) - low;
      for (let i = 0; i < values.length; i++) positions[i] = values[i]! > 0 ? Math.min(1, Math.max(0, (Math.log10(values[i]!) - low) / span)) : 0;
    } else {
      for (let i = 0; i < values.length; i++) {
        const value = values[i]!;
        // The potential is unbounded at a nucleus; anything beyond the scale takes its end colour.
        positions[i] = Number.isNaN(value) ? 0.5 : 0.5 + 0.5 * Math.min(1, Math.max(-1, value / scale.range));
      }
    }
    slicePlaced = { source: values, scaleKey, positions };
  }
  return {
    center: data.frame.center,
    u: data.frame.u,
    v: data.frame.v,
    width: data.frame.width,
    height: data.frame.height,
    positions: slicePlaced.positions,
    columns: data.response.columns,
    rows: data.response.rows,
    scale: texelsOf(colorScale),
    neutral: colorScale.diverging ? 0.5 : 0,
    contours: scale.kind === 'log' ? 2 * Math.round(Math.log10(scale.high / scale.low)) : 5,
  };
}

/** Puts on stage exactly what the current data and settings say, and nothing that has gone stale. */
function publish(): void {
  const slice = sliceOnStage();
  const settings = get().slice;
  stageApi.setSurfaces([...molecularSurfaces(), ...fieldSurfaces()]);
  stageApi.setCloud(fieldCloud());
  stageApi.setVolume(fieldVolume());
  stageApi.setSlice(slice);
  const frame = sliceData?.frame;
  stageApi.setCut(slice && frame && settings.cut ? { normal: settings.flipped ? (frame.normal.map((c) => -c) as unknown as Vec3) : frame.normal, point: frame.center } : null);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs a field request, as a listed job when it may take long enough to be worth cancelling. */
async function request<T>(tracked: boolean, title: string, detail: string, onProgress: (progress: FieldProgress) => void, call: (options: CallOptions<FieldProgress>) => Promise<T>): Promise<T> {
  if (!tracked) return call({ onProgress });
  return runJob({ kind: 'surface', title, detail }, ({ signal, report }) =>
    call({
      signal,
      onProgress: (progress) => {
        onProgress(progress);
        report(progress.fraction, progress.stage === 'potential' ? 'electrostatic potential' : progress.stage === 'surface' ? 'surface' : 'sampling the field');
      },
    }),
  );
}

function refreshField(): void {
  const record = currentRecord();
  const settings = get().field;
  if (!record || settings.kind === 'off') {
    if (get().fieldInfo || get().fieldError) set({ fieldInfo: null, fieldError: null });
    publish();
    return;
  }
  if (fieldData?.key === fieldKey(record, settings)) {
    // Only the appearance changed: no new computation.
    if (settings.kind === 'potential') {
      const range = potentialRangeFor(settings, fieldData.potential);
      if (get().fieldInfo?.potentialRange !== range) set((s) => ({ fieldInfo: s.fieldInfo ? { ...s.fieldInfo, potentialRange: range } : null }));
    }
    publish();
    return;
  }
  fieldQueue(async () => {
    const live = currentRecord();
    const field = get().field;
    if (!live || field.kind === 'off') return;
    const key = fieldKey(live, field);
    if (fieldData?.key === key) return;
    const wavefunction = wavefunctionOf(live);
    const orbital = field.kind === 'orbital' ? field.orbital : null;
    const spec: FieldSpec = field.kind === 'orbital' ? { kind: 'orbital', index: field.orbital } : { kind: 'density' };
    const name = field.kind === 'orbital' ? `Orbital ${field.orbital + 1} (${orbitalLabel(live.result, field.orbital)})` : field.kind === 'density' ? 'Electron density' : 'Electrostatic potential';
    const sampling = `${live.id}|${field.kind === 'potential' ? 'density-potential' : field.kind === 'orbital' ? `orbital ${field.orbital}` : 'density'}`;
    const tracked = field.kind === 'potential' || sampling !== sampledKey;
    const onProgress = (progress: FieldProgress) => set({ fieldProgress: progress });
    set({ fieldBusy: true, fieldProgress: null, fieldError: null });
    try {
      let data: FieldData;
      let info: FieldInfo;
      const base = { key, recordId: live.id, kind: field.kind, style: field.kind === 'potential' ? 'surface' : field.style, orbital } as const;
      if (field.kind === 'potential') {
        const response = await request(tracked, name, `mapped on the density surface ρ = ${field.potentialIso} e/a₀³`, onProgress, (options) =>
          fields.espSurface({ wavefunction, isoValue: field.potentialIso, grid: POTENTIAL_GRID, maxVertices: POTENTIAL_MAX_VERTICES }, options),
        );
        data = { ...base, isoValue: field.potentialIso, potential: response };
        info = {
          kind: 'potential',
          style: 'surface',
          orbital: null,
          isoValue: field.potentialIso,
          parts: [{ sign: 1, area: response.part.area, volume: response.part.volume, closed: response.part.closed, triangles: response.part.indices.length / 3 }],
          gridSpacing: response.grid.spacing[0],
          potentialMin: response.min,
          potentialMax: response.max,
          potentialRange: potentialRangeFor(field, response),
          dots: null,
          captured: null,
          elapsedMs: response.elapsedMs,
        };
      } else if (field.style === 'volume') {
        const response = await request(tracked, name, 'sampled volume', onProgress, (options) =>
          fields.volume({ wavefunction, field: spec, grid: { ...FIELD_GRID, spacing: 0.18, maxPoints: 500_000 } }, options));
        data = { ...base, isoValue: null, volume: response };
        info = {
          kind: field.kind, style: 'volume', orbital, isoValue: null, parts: [],
          gridSpacing: response.grid.spacing[0], potentialMin: null, potentialMax: null, potentialRange: null,
          dots: null, captured: null, elapsedMs: response.elapsedMs,
        };
      } else if (field.style === 'cloud') {
        const response = await request(tracked, name, `dot cloud of ${field.dots.toLocaleString('en-US')} dots`, onProgress, (options) =>
          fields.cloud({ wavefunction, field: spec, grid: FIELD_GRID, count: field.dots, seed: 20240229 }, options),
        );
        data = { ...base, isoValue: null, cloud: response };
        info = {
          kind: field.kind,
          style: 'cloud',
          orbital,
          isoValue: null,
          parts: [],
          gridSpacing: response.grid.spacing[0],
          potentialMin: null,
          potentialMax: null,
          potentialRange: null,
          dots: response.positions.length / 3,
          captured: response.captured,
          elapsedMs: response.elapsedMs,
        };
      } else {
        const isoValue = field.kind === 'orbital' ? field.orbitalIso : field.densityIso;
        const response = await request(tracked, name, 'isosurface', onProgress, (options) => fields.surface({ wavefunction, field: spec, isoValue, grid: FIELD_GRID }, options));
        data = { ...base, isoValue, surface: response };
        info = {
          kind: field.kind,
          style: 'surface',
          orbital,
          isoValue,
          parts: response.parts.map((part) => ({ sign: part.sign, area: part.area, volume: part.volume, closed: part.closed, triangles: part.indices.length / 3 })),
          gridSpacing: response.grid.spacing[0],
          potentialMin: null,
          potentialMax: null,
          potentialRange: null,
          dots: null,
          captured: null,
          elapsedMs: response.elapsedMs,
        };
      }
      sampledKey = sampling;
      if (currentRecord()?.id !== live.id) {
        set({ fieldBusy: false, fieldProgress: null });
        return;
      }
      fieldData = data;
      set({ fieldBusy: false, fieldProgress: null, fieldInfo: info });
      publish();
    } catch (error) {
      // A cancelled request ends its thread, and with it the fields that thread remembered.
      sampledKey = '';
      if (error instanceof JobCancelledError) {
        fieldData = null;
        set((s) => ({ fieldBusy: false, fieldProgress: null, fieldInfo: null, field: { ...s.field, kind: 'off' } }));
        publish();
        return;
      }
      set({ fieldBusy: false, fieldProgress: null, fieldError: describe(error) });
    }
  });
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const along = (a: Vec3, direction: Vec3, distance: number): Vec3 => [a[0] + direction[0] * distance, a[1] + direction[1] * distance, a[2] + direction[2] * distance];
const unit = (a: Vec3): Vec3 | null => {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length > 1e-6 ? [a[0] / length, a[1] / length, a[2] / length] : null;
};

/** Margin around the nuclei that a cutting plane covers, angstrom. */
const SLICE_MARGIN = 2.8;

const AXES: Readonly<Record<'x' | 'y' | 'z', { normal: Vec3; u: Vec3; v: Vec3 }>> = {
  x: { normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  y: { normal: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },
  z: { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
};

/** Where the cutting plane lies: through the middle of the molecule, or through three chosen atoms, moved by the offset. */
function sliceFrame(record: QuantumRecord, settings: SliceSettings): SliceFrame {
  const points = sortedAtoms(record.scene).map((atom) => atom.position);
  const low: [number, number, number] = [Infinity, Infinity, Infinity];
  const high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let k = 0; k < 3; k++) {
      low[k] = Math.min(low[k]!, p[k]!);
      high[k] = Math.max(high[k]!, p[k]!);
    }
  }
  const middle: Vec3 = [(low[0] + high[0]) / 2, (low[1] + high[1]) / 2, (low[2] + high[2]) / 2];
  let basis = settings.axis === 'atoms' ? null : AXES[settings.axis];
  let base = middle;
  if (settings.axis === 'atoms') {
    const chosen = (settings.atoms ?? []).map((id) => record.scene.atoms.get(id)?.position);
    const [a, b, c] = chosen;
    const normal = a && b && c ? unit(cross(minus(b, a), minus(c, a))) : null;
    const u = a && b ? unit(minus(b, a)) : null;
    if (a && normal && u) {
      basis = { normal, u, v: cross(normal, u) };
      // The point of the plane nearest the middle of the molecule.
      base = along(middle, normal, dot(minus(a, middle), normal));
    } else {
      basis = AXES.z;
    }
  }
  const { normal, u, v } = basis!;
  const center = along(base, normal, settings.offset);
  let halfU = 0;
  let halfV = 0;
  let below = 0;
  let above = 0;
  for (const p of points) {
    const d = minus(p, base);
    halfU = Math.max(halfU, Math.abs(dot(d, u)));
    halfV = Math.max(halfV, Math.abs(dot(d, v)));
    below = Math.min(below, dot(d, normal));
    above = Math.max(above, dot(d, normal));
  }
  return {
    center,
    u,
    v,
    normal,
    width: 2 * (halfU + SLICE_MARGIN),
    height: 2 * (halfV + SLICE_MARGIN),
    offsetRange: [below - 2, above + 2],
  };
}

function sliceKey(record: QuantumRecord, slice: SliceSettings, orbital: number): string {
  return [record.id, slice.field, slice.field === 'orbital' ? orbital : '', slice.axis, slice.axis === 'atoms' ? (slice.atoms ?? []).join(',') : '', slice.offset].join('|');
}

function sliceScale(field: SliceField, response: SliceResponse): SliceScale {
  if (field === 'density') return { kind: 'log', ...DENSITY_SCALE };
  if (field === 'orbital') return { kind: 'symmetric', range: niceCeil(Math.max(Math.abs(response.min), Math.abs(response.max), 1e-4)) };
  const settings = get().field;
  return { kind: 'symmetric', range: settings.potentialRange ?? get().fieldInfo?.potentialRange ?? 0.1 };
}

function refreshSlice(): void {
  const record = currentRecord();
  const settings = get().slice;
  if (!record || !settings.enabled) {
    if (get().sliceInfo || get().sliceError) set({ sliceInfo: null, sliceError: null });
    publish();
    return;
  }
  const orbital = Math.min(record.result.nBasis - 1, Math.max(0, get().field.orbital));
  if (sliceData?.key === sliceKey(record, settings, orbital)) {
    // The data stand; the colour scale of the potential may have been changed.
    const scale = sliceScale(sliceData.field, sliceData.response);
    const info = get().sliceInfo;
    if (info && JSON.stringify(info.scale) !== JSON.stringify(scale)) set({ sliceInfo: { ...info, scale } });
    publish();
    return;
  }
  sliceQueue(async () => {
    const live = currentRecord();
    const slice = get().slice;
    if (!live || !slice.enabled) return;
    const index = Math.min(live.result.nBasis - 1, Math.max(0, get().field.orbital));
    const key = sliceKey(live, slice, index);
    if (sliceData?.key === key) return;
    const frame = sliceFrame(live, slice);
    // The potential costs up to a hundred times more per point than the density, so its plane is sampled more coarsely.
    const longest = slice.field === 'potential' ? potentialPlaneSamples(live.result.nBasis, frame.width / frame.height) : 200;
    const scaleDown = longest / Math.max(frame.width, frame.height);
    const columns = Math.max(2, Math.round(frame.width * scaleDown));
    const rows = Math.max(2, Math.round(frame.height * scaleDown));
    const field: PointField = slice.field === 'orbital' ? { kind: 'orbital', index } : slice.field === 'density' ? { kind: 'density' } : { kind: 'esp' };
    set({ sliceBusy: true, sliceError: null });
    try {
      const response = await request(slice.field === 'potential', 'Electrostatic potential', `on a cutting plane, ${columns} × ${rows} points`, () => {}, (options) =>
        fields.slice({ wavefunction: wavefunctionOf(live), field, center: frame.center, u: frame.u, v: frame.v, width: frame.width, height: frame.height, columns, rows }, options),
      );
      if (currentRecord()?.id !== live.id) {
        set({ sliceBusy: false });
        return;
      }
      sliceData = { key, recordId: live.id, field: slice.field, orbital: slice.field === 'orbital' ? index : null, frame, response };
      set({
        sliceBusy: false,
        sliceInfo: {
          field: slice.field,
          orbital: slice.field === 'orbital' ? index : null,
          scale: sliceScale(slice.field, response),
          min: response.min,
          max: response.max,
          center: frame.center,
          normal: frame.normal,
          width: frame.width,
          height: frame.height,
          columns,
          rows,
          offsetRange: frame.offsetRange,
        },
      });
      publish();
    } catch (error) {
      if (error instanceof JobCancelledError) {
        sampledKey = '';
        sliceData = null;
        set((s) => ({ sliceBusy: false, sliceInfo: null, slice: { ...s.slice, enabled: false } }));
        publish();
        return;
      }
      set({ sliceBusy: false, sliceError: describe(error) });
    }
  });
}

function refreshMolecular(): void {
  const state = lab.get();
  const settings = get().molecular;
  const scene = state.scene;
  if (!settings.enabled || state.workspace !== 'architect' || scene.atoms.size === 0) {
    if (get().molecularInfo || get().molecularError) set({ molecularInfo: null, molecularError: null });
    publish();
    return;
  }
  if (molecularData && molecularData.scene === scene && molecularData.kind === settings.kind) {
    publish();
    return;
  }
  // The old surface belongs to another structure: off it goes, before the new one is ready.
  publish();
  if (scene.atoms.size > MOLECULAR_SURFACE_ATOM_LIMIT) {
    set({ molecularInfo: null, molecularError: `A molecular surface is offered for up to ${MOLECULAR_SURFACE_ATOM_LIMIT.toLocaleString('en-US')} atoms; this structure has ${scene.atoms.size.toLocaleString('en-US')}.` });
    return;
  }
  molecularQueue(async () => {
    const now = lab.get();
    const wanted = get().molecular;
    const target = now.scene;
    if (!wanted.enabled || now.workspace !== 'architect' || target.atoms.size === 0 || target.atoms.size > MOLECULAR_SURFACE_ATOM_LIMIT) return;
    if (molecularData && molecularData.scene === target && molecularData.kind === wanted.kind) return;
    const atoms = sortedAtoms(target);
    const centers = new Float32Array(atoms.length * 3);
    const radii = new Float32Array(atoms.length);
    atoms.forEach((atom, i) => {
      centers.set(atom.position, 3 * i);
      radii[i] = getElement(atom.protons).vdwRadius;
    });
    const probe = wanted.kind === 'sas' ? PROBE_RADIUS : 0;
    // Fine enough that the creases where two spheres meet stay crisp; coarser as the structure grows.
    const spacing = atoms.length <= 40 ? 0.1 : atoms.length <= 150 ? 0.13 : atoms.length <= 600 ? 0.2 : 0.3;
    set({ molecularBusy: true, molecularError: null });
    try {
      const response = await request(atoms.length > 500, 'Molecular surface', `${wanted.kind === 'sas' ? 'solvent-accessible' : 'van der Waals'} surface of ${atoms.length} atoms`, () => {}, (options) =>
        fields.molecularSurface({ centers, radii, probe, spacing, maxPoints: 4_000_000 }, options),
      );
      const linear = atoms.map((atom) => hexToRgb(getElement(atom.protons).color).map(srgbToLinear));
      const elementColors = new Float32Array(response.atomOfVertex.length * 3);
      for (let k = 0; k < response.atomOfVertex.length; k++) elementColors.set(linear[response.atomOfVertex[k]!]!, 3 * k);
      if (lab.get().scene !== target) {
        set({ molecularBusy: false });
        return;
      }
      molecularData = { key: `${wanted.kind}`, scene: target, kind: wanted.kind, response, elementColors };
      set({
        molecularBusy: false,
        molecularInfo: { kind: wanted.kind, probe, area: response.part.area, volume: response.part.volume, closed: response.part.closed, gridSpacing: response.grid.spacing[0], atoms: atoms.length },
      });
      publish();
    } catch (error) {
      if (error instanceof JobCancelledError) {
        sampledKey = '';
        set((s) => ({ molecularBusy: false, molecularInfo: null, molecular: { ...s.molecular, enabled: false } }));
        publish();
        return;
      }
      set({ molecularBusy: false, molecularError: describe(error) });
    }
  });
}

function refreshAll(): void {
  refreshField();
  refreshSlice();
  refreshMolecular();
}

// ---------- settings ----------

export function setField(change: Partial<FieldSettings>): void {
  fieldChosen = true;
  const record = get().record;
  set((s) => {
    const field = { ...s.field, ...change };
    if (record) field.orbital = Math.min(record.result.nBasis - 1, Math.max(0, Math.round(field.orbital)));
    return { field, fieldError: null };
  });
  refreshField();
  // The plane can show the orbital on stage, and shares the potential's colour scale.
  if (change.orbital !== undefined || change.potentialRange !== undefined || change.kind !== undefined) refreshSlice();
}

export function setSlice(change: Partial<SliceSettings>): void {
  set((s) => ({ slice: { ...s.slice, ...change }, sliceError: null }));
  refreshSlice();
}

/** Lays the cutting plane through the three selected atoms. */
export function sliceThroughSelection(): boolean {
  const selected = [...lab.get().selectedAtoms];
  if (selected.length !== 3) {
    notify('info', 'Select exactly three atoms', 'The plane is laid through the three atoms that are selected.');
    return false;
  }
  setSlice({ axis: 'atoms', atoms: selected, offset: 0, enabled: true });
  return true;
}

export function setMolecular(change: Partial<MolecularSettings>): void {
  set((s) => ({ molecular: { ...s.molecular, ...change }, molecularError: null }));
  refreshMolecular();
}

export function cancelFieldJobs(): void {
  cancelJobsOfKind('surface');
}

/** The numbers behind what is on stage, for tests: the potential at each surface vertex and the field on the plane. */
export function fieldSnapshot(): { potential: { positions: Float32Array; values: Float32Array } | null; slice: (SliceFrame & { values: Float32Array; columns: number; rows: number }) | null } {
  return {
    potential: fieldData?.potential ? { positions: fieldData.potential.part.positions, values: fieldData.potential.potential } : null,
    slice: sliceData ? { ...sliceData.frame, values: sliceData.response.values, columns: sliceData.response.columns, rows: sliceData.response.rows } : null,
  };
}

/** Keeps the stage honest: anything computed for another structure leaves it as soon as the structure changes. */
export function startQuantumWatch(): () => void {
  let timer = 0;
  const stop = lab.subscribe(
    (s) => [s.scene, s.workspace] as const,
    () => {
      refreshField();
      refreshSlice();
      // Stale surfaces go at once; the molecular surface is rebuilt when the editing pauses.
      publish();
      window.clearTimeout(timer);
      timer = window.setTimeout(refreshMolecular, 220);
    },
    { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] },
  );
  return () => {
    window.clearTimeout(timer);
    stop();
  };
}
