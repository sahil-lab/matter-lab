import {
  createGrid,
  evaluateDensityAtPoints,
  evaluateDensityGrid,
  evaluateEspAtPoints,
  evaluateOrbitalAtPoints,
  evaluateOrbitalGrid,
  marchingCubes,
  meshStatistics,
  runRhf,
} from '@matterlab/quantum';
import type { GridSpec, IsoMesh, QmInput, ScfIteration, ScfResult } from '@matterlab/quantum';
import { serve, transferring } from '../science/rpc';

type Triple = readonly [number, number, number];

export interface ScfRequest {
  readonly input: QmInput;
  readonly maxBasisFunctions?: number;
}

export interface ScfProgress {
  readonly phase: 'integrals' | 'scf' | 'properties';
  /** Fraction of the phase completed, 0..1. */
  readonly fraction: number;
  /** The iteration just completed, when the report is about one. */
  readonly iteration?: ScfIteration;
}

/** A converged wavefunction and the system it belongs to. `id` names it for the worker's cache. */
export interface Wavefunction {
  readonly id: string;
  readonly result: ScfResult;
  readonly input: QmInput;
}

/** A scalar field that can be sampled on a grid. */
export type FieldSpec = { readonly kind: 'density' } | { readonly kind: 'orbital'; readonly index: number };
/** A scalar field that can be sampled at arbitrary points. */
export type PointField = FieldSpec | { readonly kind: 'esp' };

export interface GridRequest {
  /** angstrom */
  readonly spacing: number;
  /** angstrom */
  readonly padding: number;
  readonly maxPoints: number;
}

/** One connected set of triangles: the surface around the positive or the negative region. */
export interface SurfacePart {
  readonly sign: 1 | -1;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  /** angstrom squared */
  readonly area: number;
  /** angstrom cubed; meaningful only when `closed` */
  readonly volume: number;
  /** False when the surface runs into the edge of the sampled box. */
  readonly closed: boolean;
}

export interface FieldProgress {
  readonly stage: 'field' | 'surface' | 'potential';
  readonly fraction: number;
}

export interface SurfaceRequest {
  readonly wavefunction: Wavefunction;
  readonly field: FieldSpec;
  /** Positive. Density in e/bohr^3, orbital amplitude in bohr^(-3/2). */
  readonly isoValue: number;
  readonly grid: GridRequest;
}

export interface SurfaceResponse {
  readonly parts: SurfacePart[];
  readonly grid: GridSpec;
  /** Extremes of the field on the grid. */
  readonly fieldMin: number;
  readonly fieldMax: number;
  readonly elapsedMs: number;
}

export interface VolumeRequest {
  readonly wavefunction: Wavefunction;
  readonly field: FieldSpec;
  readonly grid: GridRequest;
}

export interface VolumeResponse {
  /** Scalar field in its scientific unit, indexed x + nx * (y + ny * z). */
  readonly values: Float32Array;
  readonly grid: GridSpec;
  readonly min: number;
  readonly max: number;
  readonly elapsedMs: number;
}

export interface EspSurfaceRequest {
  readonly wavefunction: Wavefunction;
  /** Density isovalue of the surface the potential is mapped on, e/bohr^3. */
  readonly isoValue: number;
  readonly grid: GridRequest;
  /** The grid is coarsened until the surface has no more vertices than this. */
  readonly maxVertices: number;
}

export interface EspSurfaceResponse {
  readonly part: SurfacePart;
  /** Electrostatic potential at every vertex, hartree per elementary charge. */
  readonly potential: Float32Array;
  readonly min: number;
  readonly max: number;
  readonly grid: GridSpec;
  readonly elapsedMs: number;
}

export interface SliceRequest {
  readonly wavefunction: Wavefunction;
  readonly field: PointField;
  /** Centre of the rectangle, angstrom. */
  readonly center: Triple;
  /** Unit vectors spanning the plane. */
  readonly u: Triple;
  readonly v: Triple;
  /** Size along u and v, angstrom. */
  readonly width: number;
  readonly height: number;
  readonly columns: number;
  readonly rows: number;
}

export interface SliceResponse {
  /** Value at column c and row r is `values[c + columns * r]`; column 0 is at -width/2 along u, row 0 at -height/2 along v. */
  readonly values: Float32Array;
  readonly columns: number;
  readonly rows: number;
  readonly min: number;
  readonly max: number;
  readonly elapsedMs: number;
}

export interface CloudRequest {
  readonly wavefunction: Wavefunction;
  readonly field: FieldSpec;
  readonly grid: GridRequest;
  /** Number of dots. */
  readonly count: number;
  readonly seed: number;
}

export interface CloudResponse {
  /** xyz triples, angstrom. */
  readonly positions: Float32Array;
  /** Sign of the orbital at each dot; `null` for the density. */
  readonly signs: Int8Array | null;
  /**
   * What the sampled box holds: electrons for the density, probability (0..1) for one orbital,
   * as integrated on the grid.
   */
  readonly captured: number;
  readonly grid: GridSpec;
  readonly elapsedMs: number;
}

export interface MolecularSurfaceRequest {
  /** xyz triples, angstrom. */
  readonly centers: Float32Array;
  /** One radius per atom, angstrom. */
  readonly radii: Float32Array;
  /** Radius of the probe sphere rolled over the atoms; 0 gives the van der Waals surface. */
  readonly probe: number;
  readonly spacing: number;
  readonly maxPoints: number;
}

export interface MolecularSurfaceResponse {
  readonly part: SurfacePart;
  /** For every vertex, the atom whose sphere it lies on. */
  readonly atomOfVertex: Uint32Array;
  readonly grid: GridSpec;
  readonly elapsedMs: number;
}

const ANGSTROM_TO_BOHR = 1 / 0.529177210903;

// ---------- sampled fields, remembered between requests ----------

interface SampledField {
  readonly key: string;
  readonly grid: GridSpec;
  readonly values: Float32Array;
  readonly min: number;
  readonly max: number;
  /** The field on a logarithmic scale, made when a surface is first extracted. */
  logarithmic?: Float32Array;
}

/**
 * Densities and orbitals fall off exponentially, by a factor of two to four from one grid point
 * to the next in the outer regions. Placing a surface by linear interpolation of such values puts
 * it visibly off, in terraces that follow the grid. On a logarithmic scale the same fields are
 * nearly linear, so surfaces are extracted from log(rho) and from a signed logarithm of the
 * orbital amplitude. Both maps are strictly increasing, so the surface is the same one.
 */
const DENSITY_FLOOR = 1e-12;
const AMPLITUDE_SOFTENING = 1e-4;

const logarithmic = {
  density: (value: number): number => Math.log(Math.max(value, DENSITY_FLOOR) / DENSITY_FLOOR),
  orbital: (value: number): number => Math.sign(value) * Math.log1p(Math.abs(value) / AMPLITUDE_SOFTENING),
};

function isosurface(field: SampledField, kind: 'density' | 'orbital', isoValue: number): IsoMesh {
  const scale = logarithmic[kind];
  if (!field.logarithmic) {
    const values = new Float32Array(field.values.length);
    for (let i = 0; i < values.length; i++) values[i] = scale(field.values[i]!);
    field.logarithmic = values;
  }
  return marchingCubes(field.logarithmic, field.grid, scale(isoValue));
}

/** The last few fields, newest first: moving an isovalue slider must not recompute the field. */
const sampled: SampledField[] = [];
const REMEMBERED = 3;

function sampleField(wavefunction: Wavefunction, field: FieldSpec, request: GridRequest, onProgress: (fraction: number) => void): SampledField {
  const key = [wavefunction.id, field.kind, field.kind === 'orbital' ? field.index : '', request.spacing, request.padding, request.maxPoints].join('|');
  const known = sampled.findIndex((entry) => entry.key === key);
  if (known >= 0) {
    const [entry] = sampled.splice(known, 1);
    sampled.unshift(entry!);
    return entry!;
  }
  const { result, input } = wavefunction;
  const grid = createGrid(input.atoms, request);
  const values =
    field.kind === 'density' ? evaluateDensityGrid(result, input, grid, onProgress) : evaluateOrbitalGrid(result, input, field.index, grid, onProgress);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const entry: SampledField = { key, grid, values, min, max };
  sampled.unshift(entry);
  sampled.length = Math.min(sampled.length, REMEMBERED);
  return entry;
}

function surfacePart(mesh: IsoMesh, sign: 1 | -1): SurfacePart {
  const statistics = meshStatistics(mesh);
  return { sign, positions: mesh.positions, normals: mesh.normals, indices: mesh.indices, area: statistics.area, volume: Math.abs(statistics.volume), closed: statistics.closed };
}

const buffersOf = (parts: readonly SurfacePart[]): ArrayBufferLike[] => parts.flatMap((part) => [part.positions.buffer, part.normals.buffer, part.indices.buffer]);

function throttle<T>(report: (value: T) => void, everyMs = 50): (value: T, force?: boolean) => void {
  let last = 0;
  return (value, force = false) => {
    const now = performance.now();
    if (!force && now - last < everyMs) return;
    last = now;
    report(value);
  };
}

/** Deterministic pseudo-random numbers in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cells whose centre lies this close (angstrom) to a nucleus with a core are subdivided for dot clouds. */
const CORE_RADIUS = 0.45;
const SUBDIVISIONS = 5;
const SUBCELLS = SUBDIVISIONS ** 3;
const EMPTY_SUBCELLS = new Float32Array(0);
/** Centre of sub-cell `s` along one axis, measured from the cell centre in units of the cell size. */
const subOffset = (s: number): number => (s + 0.5) / SUBDIVISIONS - 0.5;

/**
 * Hartree-Fock calculations and everything derived from their wavefunctions, in a thread of their
 * own, together with the purely geometric molecular surfaces that share the meshing code.
 */
const methods = {
  scf(request: ScfRequest, progress: (value: ScfProgress) => void): ScfResult {
    const report = throttle(progress, 40);
    return runRhf(request.input, {
      ...(request.maxBasisFunctions !== undefined ? { maxBasisFunctions: request.maxBasisFunctions } : {}),
      onPhase: (phase, fraction) => report({ phase, fraction }, fraction >= 1),
      onIteration: (iteration) => progress({ phase: 'scf', fraction: 0, iteration }),
    });
  },

  /** The isosurface of the density, or the two lobes of an orbital at +c and -c. */
  surface(request: SurfaceRequest, progress: (value: FieldProgress) => void): SurfaceResponse {
    const started = performance.now();
    if (!(request.isoValue > 0)) throw new RangeError('The isovalue must be positive.');
    const report = throttle(progress);
    const field = sampleField(request.wavefunction, request.field, request.grid, (fraction) => report({ stage: 'field', fraction }));
    progress({ stage: 'surface', fraction: 0 });
    const signs: Array<1 | -1> = request.field.kind === 'orbital' ? [1, -1] : [1];
    const parts = signs
      .map((sign) => surfacePart(isosurface(field, request.field.kind, sign * request.isoValue), sign))
      .filter((part) => part.indices.length > 0);
    return transferring({ parts, grid: field.grid, fieldMin: field.min, fieldMax: field.max, elapsedMs: performance.now() - started }, buffersOf(parts));
  },

  volume(request: VolumeRequest, progress: (value: FieldProgress) => void): VolumeResponse {
    const started = performance.now();
    const report = throttle(progress);
    const field = sampleField(request.wavefunction, request.field, request.grid, (fraction) => report({ stage: 'field', fraction }));
    // The worker retains the original samples for subsequent surface/volume requests.
    const values = field.values.slice();
    return transferring({ values, grid: field.grid, min: field.min, max: field.max, elapsedMs: performance.now() - started }, [values.buffer]);
  },

  /** A density isosurface with the electrostatic potential evaluated at each of its vertices. */
  espSurface(request: EspSurfaceRequest, progress: (value: FieldProgress) => void): EspSurfaceResponse {
    const started = performance.now();
    if (!(request.isoValue > 0)) throw new RangeError('The isovalue must be positive.');
    const report = throttle(progress);
    const { wavefunction } = request;
    let gridRequest = request.grid;
    let field = sampleField(wavefunction, { kind: 'density' }, gridRequest, (fraction) => report({ stage: 'field', fraction }));
    let mesh = isosurface(field, 'density', request.isoValue);
    // The potential costs far more per point than the density, so the surface is kept to a bounded number of vertices.
    for (let attempt = 0; attempt < 4 && mesh.positions.length / 3 > request.maxVertices; attempt++) {
      const ratio = Math.sqrt(mesh.positions.length / 3 / request.maxVertices);
      gridRequest = { ...gridRequest, spacing: Number((field.grid.spacing[0] * Math.max(1.06, ratio * 1.03)).toFixed(4)) };
      field = sampleField(wavefunction, { kind: 'density' }, gridRequest, (fraction) => report({ stage: 'field', fraction }));
      mesh = isosurface(field, 'density', request.isoValue);
    }
    const part = surfacePart(mesh, 1);
    progress({ stage: 'potential', fraction: 0 });
    const potential = evaluateEspAtPoints(wavefunction.result, wavefunction.input, part.positions, (fraction) => report({ stage: 'potential', fraction }));
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < potential.length; i++) {
      const value = potential[i]!;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    return transferring({ part, potential, min, max, grid: field.grid, elapsedMs: performance.now() - started }, [...buffersOf([part]), potential.buffer]);
  },

  /** A field on a rectangle in space, evaluated point by point (not interpolated from a grid). */
  slice(request: SliceRequest, progress: (value: FieldProgress) => void): SliceResponse {
    const started = performance.now();
    const { wavefunction, field, center, u, v, width, height, columns, rows } = request;
    if (!(columns >= 2 && rows >= 2)) throw new RangeError('A slice needs at least 2 x 2 points.');
    const points = new Float32Array(columns * rows * 3);
    for (let row = 0; row < rows; row++) {
      const b = (row / (rows - 1) - 0.5) * height;
      for (let column = 0; column < columns; column++) {
        const a = (column / (columns - 1) - 0.5) * width;
        const k = 3 * (column + columns * row);
        points[k] = center[0] + a * u[0] + b * v[0];
        points[k + 1] = center[1] + a * u[1] + b * v[1];
        points[k + 2] = center[2] + a * u[2] + b * v[2];
      }
    }
    const { result, input } = wavefunction;
    const report = throttle(progress);
    const values =
      field.kind === 'density'
        ? evaluateDensityAtPoints(result, input, points)
        : field.kind === 'orbital'
          ? evaluateOrbitalAtPoints(result, input, field.index, points)
          : evaluateEspAtPoints(result, input, points, (fraction) => report({ stage: 'potential', fraction }));
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < values.length; i++) {
      const value = values[i]!;
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    return transferring({ values, columns, rows, min, max, elapsedMs: performance.now() - started }, [values.buffer]);
  },

  /**
   * Dots drawn at random from the density (or from the square of an orbital): where the field is
   * larger there are proportionally more dots, and every dot stands for the same share of it.
   *
   * Each grid point stands for the cell around it. That is accurate wherever the field is smooth
   * on the scale of the grid, but not at the nuclei of heavier atoms, where the core density
   * peaks within a few hundredths of an angstrom: there a single sample can misjudge the content
   * of its cell several times over. Cells near such nuclei are therefore subdivided and sampled
   * 125 times each, which also places their dots at that finer resolution.
   */
  cloud(request: CloudRequest, progress: (value: FieldProgress) => void): CloudResponse {
    const started = performance.now();
    const report = throttle(progress);
    const { result, input } = request.wavefunction;
    const field = sampleField(request.wavefunction, request.field, request.grid, (fraction) => report({ stage: 'field', fraction }));
    const { values, grid } = field;
    const orbitalIndex = request.field.kind === 'orbital' ? request.field.index : null;
    const [nx, ny, nz] = grid.dims;
    const [hx, hy, hz] = grid.spacing;
    const [ox, oy, oz] = grid.origin;
    const share = (value: number): number => (orbitalIndex !== null ? value * value : Math.max(0, value));

    const weights = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) weights[i] = share(values[i]!);

    // Subdivide the cells around nuclei with a core (lithium onwards; hydrogen and helium are smooth enough).
    const refined = new Map<number, Float32Array>();
    const cells: number[] = [];
    for (const atom of input.atoms) {
      if (atom.z < 3) continue;
      const [ax, ay, az] = atom.position;
      const span = (centre: number, origin: number, h: number, n: number): [number, number] => [
        Math.max(0, Math.ceil((centre - CORE_RADIUS - origin) / h)),
        Math.min(n - 1, Math.floor((centre + CORE_RADIUS - origin) / h)),
      ];
      const [x0, x1] = span(ax, ox, hx, nx);
      const [y0, y1] = span(ay, oy, hy, ny);
      const [z0, z1] = span(az, oz, hz, nz);
      for (let iz = z0; iz <= z1; iz++) {
        for (let iy = y0; iy <= y1; iy++) {
          for (let ix = x0; ix <= x1; ix++) {
            const cell = ix + nx * (iy + ny * iz);
            if (refined.has(cell) || Math.hypot(ox + ix * hx - ax, oy + iy * hy - ay, oz + iz * hz - az) > CORE_RADIUS) continue;
            refined.set(cell, EMPTY_SUBCELLS);
            cells.push(cell);
          }
        }
      }
    }
    if (cells.length > 0) {
      const points = new Float32Array(cells.length * SUBCELLS * 3);
      cells.forEach((cell, c) => {
        const ix = cell % nx;
        const iy = Math.floor(cell / nx) % ny;
        const iz = Math.floor(cell / (nx * ny));
        for (let s = 0; s < SUBCELLS; s++) {
          const k = 3 * (c * SUBCELLS + s);
          points[k] = ox + (ix + subOffset(s % SUBDIVISIONS)) * hx;
          points[k + 1] = oy + (iy + subOffset(Math.floor(s / SUBDIVISIONS) % SUBDIVISIONS)) * hy;
          points[k + 2] = oz + (iz + subOffset(Math.floor(s / (SUBDIVISIONS * SUBDIVISIONS)))) * hz;
        }
      });
      const sampled = orbitalIndex !== null ? evaluateOrbitalAtPoints(result, input, orbitalIndex, points) : evaluateDensityAtPoints(result, input, points);
      cells.forEach((cell, c) => {
        const sub = sampled.subarray(c * SUBCELLS, (c + 1) * SUBCELLS);
        let sum = 0;
        for (let s = 0; s < SUBCELLS; s++) sum += share(sub[s]!);
        refined.set(cell, sub);
        weights[cell] = sum / SUBCELLS;
      });
    }

    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i]!;
    const count = total > 0 ? Math.max(0, Math.floor(request.count)) : 0;
    const positions = new Float32Array(count * 3);
    const signs = orbitalIndex !== null ? new Int8Array(count) : null;
    const random = mulberry32(request.seed);
    // Systematic sampling: one dot per equal share of the total, which spreads them evenly.
    let cell = 0;
    let before = 0;
    let cumulative = weights[0]!;
    for (let k = 0; k < count; k++) {
      const target = ((k + random()) / count) * total;
      while (cumulative < target && cell < weights.length - 1) {
        before = cumulative;
        cumulative += weights[++cell]!;
      }
      const ix = cell % nx;
      const iy = Math.floor(cell / nx) % ny;
      const iz = Math.floor(cell / (nx * ny));
      let fx = random() - 0.5;
      let fy = random() - 0.5;
      let fz = random() - 0.5;
      let value = values[cell]!;
      const sub = refined.get(cell);
      if (sub) {
        // Within a subdivided cell, the same share of the total picks the sub-cell: the cell's weight is the mean of its sub-cells.
        let remaining = (target - before) * SUBCELLS;
        let s = 0;
        while (s < SUBCELLS - 1 && remaining > share(sub[s]!)) remaining -= share(sub[s++]!);
        value = sub[s]!;
        fx = subOffset(s % SUBDIVISIONS) + fx / SUBDIVISIONS;
        fy = subOffset(Math.floor(s / SUBDIVISIONS) % SUBDIVISIONS) + fy / SUBDIVISIONS;
        fz = subOffset(Math.floor(s / (SUBDIVISIONS * SUBDIVISIONS))) + fz / SUBDIVISIONS;
      }
      positions[3 * k] = ox + (ix + fx) * hx;
      positions[3 * k + 1] = oy + (iy + fy) * hy;
      positions[3 * k + 2] = oz + (iz + fz) * hz;
      if (signs) signs[k] = value >= 0 ? 1 : -1;
    }
    const cellVolumeBohr = hx * hy * hz * ANGSTROM_TO_BOHR ** 3;
    return transferring({ positions, signs, captured: total * cellVolumeBohr, grid, elapsedMs: performance.now() - started }, [
      positions.buffer,
      ...(signs ? [signs.buffer] : []),
    ]);
  },

  /**
   * The surface of a union of spheres: with a probe radius of zero the van der Waals surface, with
   * a probe the surface traced by the centre of a probe sphere rolling over the atoms (the
   * solvent-accessible surface). Purely geometric; no electronic structure enters.
   */
  molecularSurface(request: MolecularSurfaceRequest, progress: (value: FieldProgress) => void): MolecularSurfaceResponse {
    const started = performance.now();
    const { centers, radii, probe } = request;
    const atoms = radii.length;
    if (atoms === 0 || centers.length !== atoms * 3) throw new RangeError('A molecular surface needs at least one atom, with one radius per atom.');
    let largest = 0;
    for (let i = 0; i < atoms; i++) largest = Math.max(largest, radii[i]! + probe);
    const qmAtoms = Array.from({ length: atoms }, (_, i) => ({ z: 1, position: [centers[3 * i]!, centers[3 * i + 1]!, centers[3 * i + 2]!] as const }));
    // The box must clear the surface by more than one cell, whatever spacing the point budget allows.
    let grid = createGrid(qmAtoms, { spacing: request.spacing, padding: largest + 3 * request.spacing, maxPoints: request.maxPoints });
    for (let attempt = 0; attempt < 3 && grid.spacing[0] > request.spacing * 1.001; attempt++) {
      grid = createGrid(qmAtoms, { spacing: grid.spacing[0], padding: largest + 3 * grid.spacing[0], maxPoints: request.maxPoints });
    }
    const [nx, ny, nz] = grid.dims;
    const [ox, oy, oz] = grid.origin;
    const h = grid.spacing[0];
    // Signed distance to the nearest sphere surface, positive inside; only needed near the surface.
    const margin = 2.5 * h;
    const values = new Float32Array(nx * ny * nz).fill(-margin);
    const report = throttle(progress);
    for (let i = 0; i < atoms; i++) {
      const cx = centers[3 * i]!;
      const cy = centers[3 * i + 1]!;
      const cz = centers[3 * i + 2]!;
      const radius = radii[i]! + probe;
      const reach = radius + margin;
      const x0 = Math.max(0, Math.ceil((cx - reach - ox) / h));
      const x1 = Math.min(nx - 1, Math.floor((cx + reach - ox) / h));
      const y0 = Math.max(0, Math.ceil((cy - reach - oy) / h));
      const y1 = Math.min(ny - 1, Math.floor((cy + reach - oy) / h));
      const z0 = Math.max(0, Math.ceil((cz - reach - oz) / h));
      const z1 = Math.min(nz - 1, Math.floor((cz + reach - oz) / h));
      for (let iz = z0; iz <= z1; iz++) {
        const dz = oz + iz * h - cz;
        for (let iy = y0; iy <= y1; iy++) {
          const dy = oy + iy * h - cy;
          const row = nx * (iy + ny * iz);
          for (let ix = x0; ix <= x1; ix++) {
            const dx = ox + ix * h - cx;
            const value = radius - Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (value > values[row + ix]!) values[row + ix] = value;
          }
        }
      }
      if ((i & 63) === 0) report({ stage: 'field', fraction: i / atoms });
    }
    progress({ stage: 'surface', fraction: 0 });
    const part = surfacePart(marchingCubes(values, grid, 0), 1);

    // Which atom's sphere each vertex lies on: the atom for which (radius - distance) is largest.
    const cell = largest + 1e-3;
    const bins = new Map<string, number[]>();
    const binOf = (x: number, y: number, z: number) => [Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell)] as const;
    for (let i = 0; i < atoms; i++) {
      const key = binOf(centers[3 * i]!, centers[3 * i + 1]!, centers[3 * i + 2]!).join(',');
      const bin = bins.get(key);
      if (bin) bin.push(i);
      else bins.set(key, [i]);
    }
    const vertices = part.positions.length / 3;
    const atomOfVertex = new Uint32Array(vertices);
    for (let k = 0; k < vertices; k++) {
      const x = part.positions[3 * k]!;
      const y = part.positions[3 * k + 1]!;
      const z = part.positions[3 * k + 2]!;
      const [bx, by, bz] = binOf(x, y, z);
      let best = 0;
      let bestValue = -Infinity;
      for (let ix = bx - 1; ix <= bx + 1; ix++) {
        for (let iy = by - 1; iy <= by + 1; iy++) {
          for (let iz = bz - 1; iz <= bz + 1; iz++) {
            const bin = bins.get(`${ix},${iy},${iz}`);
            if (!bin) continue;
            for (const i of bin) {
              const value = radii[i]! + probe - Math.hypot(x - centers[3 * i]!, y - centers[3 * i + 1]!, z - centers[3 * i + 2]!);
              if (value > bestValue) {
                bestValue = value;
                best = i;
              }
            }
          }
        }
      }
      atomOfVertex[k] = best;
    }
    return transferring({ part, atomOfVertex, grid, elapsedMs: performance.now() - started }, [...buffersOf([part]), atomOfVertex.buffer]);
  },
};

export type QuantumMethods = typeof methods;

serve(methods);
