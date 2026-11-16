import { describe, expect, it } from 'vitest';
import { marchingCubes, meshStatistics } from '../src/index';
import type { GridSpec, IsoMesh } from '../src/index';
import { ambiguousFaces, buildCase, CENTRE_VERTEX } from '../src/mesh/marchingCubes';
import { validationReporter } from './helpers/report';

const record = validationReporter('marching-cubes');

function sampleField(grid: GridSpec, f: (x: number, y: number, z: number) => number): Float32Array {
  const [nx, ny, nz] = grid.dims;
  const values = new Float32Array(nx * ny * nz);
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        values[ix + nx * (iy + ny * iz)] = f(grid.origin[0] + ix * grid.spacing[0], grid.origin[1] + iy * grid.spacing[1], grid.origin[2] + iz * grid.spacing[2]);
      }
    }
  }
  return values;
}

function cubeGrid(halfWidth: number, spacing: number): GridSpec {
  const n = Math.round((2 * halfWidth) / spacing) + 1;
  return { origin: [-halfWidth, -halfWidth, -halfWidth], spacing: [spacing, spacing, spacing], dims: [n, n, n] };
}

/** Smallest dot product between unit vertex normals / geometric triangle normals and a reference direction field. */
function orientation(mesh: IsoMesh, outward: (x: number, y: number, z: number) => [number, number, number]) {
  let minVertexDot = Infinity;
  let maxNormalLengthError = 0;
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    const [ox, oy, oz] = outward(mesh.positions[3 * v], mesh.positions[3 * v + 1], mesh.positions[3 * v + 2]);
    const nx = mesh.normals[3 * v];
    const ny = mesh.normals[3 * v + 1];
    const nz = mesh.normals[3 * v + 2];
    minVertexDot = Math.min(minVertexDot, nx * ox + ny * oy + nz * oz);
    maxNormalLengthError = Math.max(maxNormalLengthError, Math.abs(Math.hypot(nx, ny, nz) - 1));
  }
  let minFaceDot = Infinity;
  for (let k = 0; k < mesh.indices.length; k += 3) {
    const [a, b, c] = [mesh.indices[k] * 3, mesh.indices[k + 1] * 3, mesh.indices[k + 2] * 3];
    const p = mesh.positions;
    const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const w = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const length = Math.hypot(n[0], n[1], n[2]);
    if (length < 1e-9) continue; // zero-area triangles have no orientation
    const [ox, oy, oz] = outward((p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3);
    minFaceDot = Math.min(minFaceDot, (n[0] * ox + n[1] * oy + n[2] * oz) / length);
  }
  return { minVertexDot, minFaceDot, maxNormalLengthError };
}

const radial = (x: number, y: number, z: number): [number, number, number] => {
  const r = Math.hypot(x, y, z);
  return [x / r, y / r, z / r];
};

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('marching cubes case generation', () => {
  it('triangulates all 256 corner patterns and every resolution of their ambiguous faces into locally manifold patches', () => {
    let cases = 0;
    let casesWithCentreVertex = 0;
    let maxTriangles = 0;
    // Faces through a cube edge, derived independently of the implementation: edge = 4 * axis + k,
    // where bits 0 and 1 of k are the low corner's coordinates along the two other axes.
    const facesOf = (edge: number): number[] => {
      const axis = edge >> 2;
      const others = [0, 1, 2].filter((a) => a !== axis);
      return others.map((a, i) => a * 2 + (((edge & 3) >> i) & 1));
    };
    const shareFace = (a: number, b: number): boolean => a < CENTRE_VERTEX && b < CENTRE_VERTEX && facesOf(a).some((f) => facesOf(b).includes(f));

    for (let mask = 0; mask < 256; mask++) {
      const ambiguous = ambiguousFaces(mask);
      for (let connect = 0; connect < 64; connect++) {
        if ((connect & ~ambiguous) !== 0) continue;
        cases++;
        const { triangles, centreLoops } = buildCase(mask, connect);
        expect(triangles.length % 3).toBe(0);
        maxTriangles = Math.max(maxTriangles, triangles.length / 3);
        if (centreLoops.length > 0) casesWithCentreVertex++;

        // Edges crossed by the surface are exactly those whose two corners differ.
        const crossed = new Set<number>();
        for (let edge = 0; edge < 12; edge++) {
          const axis = edge >> 2;
          let low = -1;
          let seen = 0;
          for (let corner = 0; corner < 8; corner++) {
            if (corner & (1 << axis)) continue;
            if (seen++ === (edge & 3)) low = corner;
          }
          if (((mask >> low) & 1) !== ((mask >> (low | (1 << axis))) & 1)) crossed.add(edge);
        }
        expect(new Set(Array.from(triangles).filter((id) => id < CENTRE_VERTEX))).toEqual(crossed);

        const directed = new Map<string, number>();
        for (let k = 0; k < triangles.length; k += 3) {
          for (let e = 0; e < 3; e++) {
            const key = `${triangles[k + e]}>${triangles[k + ((e + 1) % 3)]}`;
            directed.set(key, (directed.get(key) ?? 0) + 1);
          }
        }
        for (const [key, count] of directed) {
          const [from, to] = key.split('>').map(Number);
          const reverse = directed.get(`${to}>${from}`) ?? 0;
          expect(count).toBe(1);
          if (shareFace(from, to)) {
            // A side lying in a cube face is completed by the neighbouring cube, so it must be used
            // exactly once here; this also rules out diagonals and triangles lying flat in a face.
            expect(reverse).toBe(0);
          } else {
            // An interior side is shared by two triangles of this cube with opposite directions.
            expect(reverse).toBe(1);
          }
        }
      }
    }
    record('case-table', { cases, casesWithCentreVertex, maxTrianglesPerCube: maxTriangles });
    expect(cases).toBeGreaterThan(256);
  });

  it('leaves the 0 and 255 patterns empty and treats complementary single-corner patterns with opposite winding', () => {
    expect(buildCase(0, 0).triangles.length).toBe(0);
    expect(buildCase(255, 0).triangles.length).toBe(0);
    const one = Array.from(buildCase(1, 0).triangles);
    const complement = Array.from(buildCase(254, 0).triangles);
    expect(one.length).toBe(3);
    expect([...complement].sort()).toEqual([...one].sort());
    // Same three edges, opposite cyclic order.
    const rotations = (t: number[]) => [t.join(), [t[1], t[2], t[0]].join(), [t[2], t[0], t[1]].join()];
    expect(rotations(one)).not.toContain(complement.join());
    expect(rotations([one[0], one[2], one[1]])).toContain(complement.join());
  });
});

describe('marching cubes on analytic fields', () => {
  const radius = 1;

  it.each([
    { label: 'spacing R/10', spacing: 0.1, tolerance: 0.01 },
    { label: 'spacing R/20', spacing: 0.05, tolerance: 0.0025 },
  ])('recovers the area and volume of a sphere ($label) as a closed manifold', ({ label, spacing, tolerance }) => {
    const grid = cubeGrid(1.6, spacing);
    // f = 1.5 - r, isovalue 0.5: inside (f > 0.5) is the ball r < 1.
    const mesh = marchingCubes(
      sampleField(grid, (x, y, z) => 1.5 - Math.hypot(x, y, z)),
      grid,
      0.5,
    );
    const stats = meshStatistics(mesh);
    const areaError = stats.area / (4 * Math.PI * radius ** 2) - 1;
    const volumeError = stats.volume / ((4 / 3) * Math.PI * radius ** 3) - 1;
    const facing = orientation(mesh, radial);
    record(`sphere/${label}`, { vertices: stats.vertexCount, triangles: stats.triangleCount, areaError, volumeError, ...facing });

    expect(stats.closed).toBe(true);
    expect(stats.boundaryEdges).toBe(0);
    expect(stats.nonManifoldEdges).toBe(0);
    expect(stats.inconsistentEdges).toBe(0);
    expect(stats.eulerCharacteristic).toBe(2);
    expect(Math.abs(areaError)).toBeLessThan(tolerance);
    expect(Math.abs(volumeError)).toBeLessThan(tolerance);
    // Outward orientation: positive enclosed volume, normals and triangle windings along +r.
    expect(stats.volume).toBeGreaterThan(0);
    expect(facing.minVertexDot).toBeGreaterThan(0.99);
    expect(facing.minFaceDot).toBeGreaterThan(0.9);
    expect(facing.maxNormalLengthError).toBeLessThan(1e-6);
  });

  it('welds vertices: no two vertices share a position and each lies on the isosurface', () => {
    const grid = cubeGrid(1.6, 0.1);
    // The centre is shifted off the grid so that the surface does not pass exactly through grid
    // points (there, vertices of different grid edges legitimately coincide in space).
    const centre = [0.0137, -0.0271, 0.0393];
    const mesh = marchingCubes(
      sampleField(grid, (x, y, z) => 1.5 - Math.hypot(x - centre[0], y - centre[1], z - centre[2])),
      grid,
      0.5,
    );
    const seen = new Set<string>();
    let worstRadius = 0;
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      const p = [mesh.positions[3 * v], mesh.positions[3 * v + 1], mesh.positions[3 * v + 2]];
      seen.add(p.join(','));
      worstRadius = Math.max(worstRadius, Math.abs(Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]) - radius));
    }
    expect(seen.size).toBe(mesh.positions.length / 3);
    // Linear interpolation of 1.5 - r along a grid edge is exact only along radial edges.
    expect(worstRadius).toBeLessThan(0.1 ** 2);
    // A closed triangle mesh has E = 3F/2, so V - F/2 = 2.
    expect(mesh.positions.length / 3 - mesh.indices.length / 6).toBe(2);
  });

  it('encloses the region below a negative isovalue with outward normals', () => {
    const grid = cubeGrid(1.6, 0.1);
    // g = r - 1.5, isovalue -0.5: inside (g < -0.5) is again the ball r < 1.
    const mesh = marchingCubes(
      sampleField(grid, (x, y, z) => Math.hypot(x, y, z) - 1.5),
      grid,
      -0.5,
    );
    const stats = meshStatistics(mesh);
    const facing = orientation(mesh, radial);
    expect(stats.closed).toBe(true);
    expect(stats.inconsistentEdges).toBe(0);
    expect(stats.volume).toBeGreaterThan(0);
    expect(Math.abs(stats.volume / ((4 / 3) * Math.PI) - 1)).toBeLessThan(0.01);
    expect(facing.minVertexDot).toBeGreaterThan(0.99);
    expect(facing.minFaceDot).toBeGreaterThan(0.9);
  });

  it('gives the two lobes of a p-like field with +c and -c, each closed and outward oriented', () => {
    const grid = cubeGrid(3, 0.1);
    const values = sampleField(grid, (x, y, z) => x * Math.exp(-(x * x + y * y + z * z)));
    const positive = marchingCubes(values, grid, 0.2);
    const negative = marchingCubes(values, grid, -0.2);
    const sp = meshStatistics(positive);
    const sn = meshStatistics(negative);
    expect(sp.closed && sn.closed).toBe(true);
    expect(sp.eulerCharacteristic).toBe(2);
    expect(sn.eulerCharacteristic).toBe(2);
    expect(sp.volume).toBeGreaterThan(0);
    expect(sn.volume).toBeGreaterThan(0);
    expect(Math.abs(sp.volume - sn.volume) / sp.volume).toBeLessThan(1e-6);
    const xs = (mesh: IsoMesh) => Array.from({ length: mesh.positions.length / 3 }, (_, v) => mesh.positions[3 * v]);
    expect(Math.min(...xs(positive))).toBeGreaterThan(0);
    expect(Math.max(...xs(negative))).toBeLessThan(0);
  });

  it('handles anisotropic spacing and an offset origin', () => {
    const grid: GridSpec = { origin: [3.2, -5.1, 0.7], spacing: [0.07, 0.11, 0.13], dims: [48, 32, 28] };
    const centre: [number, number, number] = [3.2 + 0.07 * 23.4, -5.1 + 0.11 * 15.3, 0.7 + 0.13 * 13.2];
    const mesh = marchingCubes(
      sampleField(grid, (x, y, z) => 1.5 - Math.hypot(x - centre[0], y - centre[1], z - centre[2])),
      grid,
      0.5,
    );
    const stats = meshStatistics(mesh);
    const facing = orientation(mesh, (x, y, z) => radial(x - centre[0], y - centre[1], z - centre[2]));
    record('sphere/anisotropic', { areaError: stats.area / (4 * Math.PI) - 1, volumeError: stats.volume / ((4 / 3) * Math.PI) - 1, ...facing });
    expect(stats.closed).toBe(true);
    expect(stats.eulerCharacteristic).toBe(2);
    expect(Math.abs(stats.area / (4 * Math.PI) - 1)).toBeLessThan(0.02);
    expect(Math.abs(stats.volume / ((4 / 3) * Math.PI) - 1)).toBeLessThan(0.02);
    expect(facing.minVertexDot).toBeGreaterThan(0.98);
  });

  it('finds the right topology for a torus and for two separate spheres', () => {
    const grid = cubeGrid(2, 0.08);
    const torus = marchingCubes(
      sampleField(grid, (x, y, z) => 0.4 - Math.hypot(Math.hypot(x, y) - 1.2, z)),
      grid,
      0,
    );
    const torusStats = meshStatistics(torus);
    expect(torusStats.closed).toBe(true);
    expect(torusStats.inconsistentEdges).toBe(0);
    expect(torusStats.eulerCharacteristic).toBe(0);
    // Volume 2 pi^2 R r^2, area 4 pi^2 R r.
    expect(Math.abs(torusStats.volume / (2 * Math.PI ** 2 * 1.2 * 0.4 ** 2) - 1)).toBeLessThan(0.02);
    expect(Math.abs(torusStats.area / (4 * Math.PI ** 2 * 1.2 * 0.4) - 1)).toBeLessThan(0.02);

    const two = marchingCubes(
      sampleField(grid, (x, y, z) => Math.max(0.5 - Math.hypot(x - 1, y, z), 0.5 - Math.hypot(x + 1, y, z))),
      grid,
      0,
    );
    const twoStats = meshStatistics(two);
    expect(twoStats.closed).toBe(true);
    expect(twoStats.eulerCharacteristic).toBe(4);
  });
});

describe('marching cubes robustness', () => {
  it('stays a closed, consistently oriented manifold on noise, which exercises every ambiguous configuration', () => {
    const random = rng(12345);
    const n = 40;
    const grid: GridSpec = { origin: [0, 0, 0], spacing: [1, 1, 1], dims: [n, n, n] };
    const values = new Float32Array(n * n * n);
    for (let iz = 0; iz < n; iz++) {
      for (let iy = 0; iy < n; iy++) {
        for (let ix = 0; ix < n; ix++) {
          const boundary = ix === 0 || iy === 0 || iz === 0 || ix === n - 1 || iy === n - 1 || iz === n - 1;
          values[ix + n * (iy + n * iz)] = boundary ? -1 : random() * 2 - 1;
        }
      }
    }
    const summary: Record<string, unknown> = {};
    for (const iso of [0, 0.3, -0.3]) {
      const mesh = marchingCubes(values, grid, iso);
      const stats = meshStatistics(mesh);
      summary[`iso ${iso}`] = { triangles: stats.triangleCount, boundaryEdges: stats.boundaryEdges, nonManifoldEdges: stats.nonManifoldEdges, inconsistentEdges: stats.inconsistentEdges };
      expect(stats.triangleCount).toBeGreaterThan(10000);
      expect(stats.nonManifoldEdges).toBe(0);
      expect(stats.inconsistentEdges).toBe(0);
      // With iso >= 0 the boundary layer (-1) is outside, so the surface cannot reach the boundary.
      if (iso >= 0) expect(stats.boundaryEdges).toBe(0);
      expect(mesh.positions.every(Number.isFinite)).toBe(true);
      expect(mesh.normals.every(Number.isFinite)).toBe(true);
    }
    record('noise', summary);
  });

  it('encloses the same volume as the count of inside cells suggests for a blocky binary field', () => {
    const n = 24;
    const grid: GridSpec = { origin: [0, 0, 0], spacing: [0.5, 0.5, 0.5], dims: [n, n, n] };
    const inside = (ix: number, iy: number, iz: number): boolean => ix >= 6 && ix <= 15 && iy >= 8 && iy <= 13 && iz >= 5 && iz <= 17;
    const values = new Float32Array(n * n * n);
    for (let iz = 0; iz < n; iz++) for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) values[ix + n * (iy + n * iz)] = inside(ix, iy, iz) ? 1 : 0;
    const mesh = marchingCubes(values, grid, 0.5);
    const stats = meshStatistics(mesh);
    expect(stats.closed).toBe(true);
    expect(stats.eulerCharacteristic).toBe(2);
    // A box of 10 x 6 x 13 inside points: the surface sits half a cell outside the outermost points,
    // with chamfered edges and corners, so the volume lies between the two bounding boxes.
    const h = 0.5;
    expect(stats.volume).toBeGreaterThan(9 * 5 * 12 * h ** 3);
    expect(stats.volume).toBeLessThan(10 * 6 * 13 * h ** 3);
    expect(mesh.normals.every(Number.isFinite)).toBe(true);
  });

  it('ends at the grid boundary without creating non-manifold edges', () => {
    const grid = cubeGrid(1, 0.1);
    const mesh = marchingCubes(
      sampleField(grid, (x, y, z) => 1.5 - Math.hypot(x, y, z)),
      grid,
      0.3, // sphere of radius 1.2 pokes through the faces of the [-1, 1] box
    );
    const stats = meshStatistics(mesh);
    expect(stats.closed).toBe(false);
    expect(stats.boundaryEdges).toBeGreaterThan(0);
    expect(stats.nonManifoldEdges).toBe(0);
    expect(stats.inconsistentEdges).toBe(0);
  });

  it('copes with values equal to the isovalue, NaN and constant fields', () => {
    const grid: GridSpec = { origin: [0, 0, 0], spacing: [1, 1, 1], dims: [9, 9, 9] };
    // Integer-valued field whose isosurface passes exactly through grid points.
    const lattice = marchingCubes(
      sampleField(grid, (x, y, z) => 3 - Math.max(Math.abs(x - 4), Math.abs(y - 4), Math.abs(z - 4))),
      grid,
      1,
    );
    const latticeStats = meshStatistics(lattice);
    expect(latticeStats.closed).toBe(true);
    expect(latticeStats.inconsistentEdges).toBe(0);
    expect(lattice.positions.every(Number.isFinite)).toBe(true);
    expect(lattice.normals.every(Number.isFinite)).toBe(true);

    const withNaN = sampleField(grid, (x, y, z) => 3 - Math.hypot(x - 4, y - 4, z - 4));
    withNaN[4 + 9 * (4 + 9 * 4)] = Number.NaN;
    const nanMesh = marchingCubes(withNaN, grid, 1);
    expect(nanMesh.positions.every(Number.isFinite)).toBe(true);
    expect(nanMesh.normals.every(Number.isFinite)).toBe(true);
    expect(meshStatistics(nanMesh).nonManifoldEdges).toBe(0);

    const constant = new Float32Array(9 * 9 * 9).fill(2);
    expect(marchingCubes(constant, grid, 1).indices.length).toBe(0);
    expect(marchingCubes(constant, grid, 3).indices.length).toBe(0);
    expect(marchingCubes(constant, grid, 2).indices.length).toBe(0);
  });

  it('rejects inconsistent input and returns an empty mesh for degenerate grids', () => {
    const grid: GridSpec = { origin: [0, 0, 0], spacing: [1, 1, 1], dims: [4, 4, 4] };
    expect(() => marchingCubes(new Float32Array(63), grid, 0)).toThrow(RangeError);
    expect(() => marchingCubes(new Float32Array(64), grid, Number.NaN)).toThrow(RangeError);
    expect(() => marchingCubes(new Float32Array(64), { ...grid, spacing: [1, 0, 1] }, 0)).toThrow(RangeError);
    const flat: GridSpec = { origin: [0, 0, 0], spacing: [1, 1, 1], dims: [4, 4, 1] };
    const mesh = marchingCubes(new Float32Array(16).fill(1), flat, 0.5);
    expect(mesh.positions.length).toBe(0);
    expect(mesh.indices.length).toBe(0);
  });
});
