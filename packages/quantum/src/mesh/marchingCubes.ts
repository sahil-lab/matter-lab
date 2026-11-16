import type { GridSpec, IsoMesh } from '../types';

/**
 * Marching cubes (W. E. Lorensen and H. E. Cline, Comput. Graph. 21(4), 163 (1987)) with a
 * topologically consistent treatment of ambiguous cube faces (G. M. Nielson and B. Hamann, "The
 * asymptotic decider", Proc. IEEE Visualization '91, 83 (1991)).
 *
 * No hand-typed case table is used. For a given pattern of inside/outside corners the surface
 * crosses each cube face along one segment, or along two segments when the face is "ambiguous"
 * (its two inside corners are diagonally opposite). Joining the segments of the six faces end to
 * end gives closed loops around the cube, and each loop is triangulated. Because a face segment
 * depends only on the four values at the corners of that face, the two cubes sharing a face always
 * agree on it; every triangle edge lying on a cube face is therefore shared by exactly two
 * triangles and the mesh has no cracks. Ambiguous faces are resolved by the bilinear interpolant
 * of the four corner values (asymptotic decider): the inside corners are joined across the face
 * when the saddle value is inside. The triangulations are generated once per corner pattern (and
 * per resolution of its ambiguous faces) and cached.
 *
 * Conventions: corner c of a cube has offsets (c & 1, (c >> 1) & 1, (c >> 2) & 1) along x, y, z.
 * Edge e = 4 * axis + k runs along `axis` from corner EDGE_CORNER[e].
 */

const EDGE_CORNER = new Int8Array(12);
/** Edge joining two corners that differ in one bit: EDGE_BETWEEN[lowCorner * 3 + axis]. */
const EDGE_BETWEEN = new Int8Array(24).fill(-1);
/** Corners of each face, counter-clockwise when seen from outside the cube. */
const FACE_CORNER = new Int8Array(24);
/** FACE_EDGE[f * 4 + k] joins FACE_CORNER[f * 4 + k] and FACE_CORNER[f * 4 + (k + 1) % 4]. */
const FACE_EDGE = new Int8Array(24);
/** Bit f is set when edge e lies on face f. */
const EDGE_FACES = new Int8Array(12);
/** Bit f is set when face f is ambiguous for a corner mask. */
const AMBIGUOUS_FACES = new Uint8Array(256);

{
  for (let axis = 0; axis < 3; axis++) {
    let k = 0;
    for (let corner = 0; corner < 8; corner++) {
      if (corner & (1 << axis)) continue;
      EDGE_CORNER[axis * 4 + k] = corner;
      EDGE_BETWEEN[corner * 3 + axis] = axis * 4 + k;
      k++;
    }
  }
  for (let axis = 0; axis < 3; axis++) {
    const b = 1 << ((axis + 1) % 3);
    const c = 1 << ((axis + 2) % 3);
    const base = 1 << axis;
    // (axis, b, c) is a cyclic permutation of (x, y, z), so e_b x e_c = e_axis.
    FACE_CORNER.set([0, c, b | c, b], axis * 8); // low side, outward normal -e_axis
    FACE_CORNER.set([base, base | b, base | b | c, base | c], axis * 8 + 4); // high side, outward normal +e_axis
  }
  for (let face = 0; face < 6; face++) {
    for (let k = 0; k < 4; k++) {
      const c0 = FACE_CORNER[face * 4 + k];
      const c1 = FACE_CORNER[face * 4 + ((k + 1) % 4)];
      const diff = c0 ^ c1;
      const axis = diff === 1 ? 0 : diff === 2 ? 1 : 2;
      const edge = EDGE_BETWEEN[Math.min(c0, c1) * 3 + axis];
      FACE_EDGE[face * 4 + k] = edge;
      EDGE_FACES[edge] |= 1 << face;
    }
  }
  for (let mask = 0; mask < 256; mask++) {
    for (let face = 0; face < 6; face++) {
      const inside = (k: number): number => (mask >> FACE_CORNER[face * 4 + k]) & 1;
      if (inside(0) === inside(2) && inside(1) === inside(3) && inside(0) !== inside(1)) AMBIGUOUS_FACES[mask] |= 1 << face;
    }
  }
}

/** Midpoint of an edge in unit-cube coordinates; only used to choose between triangulations. */
function edgeMidpoint(edge: number): [number, number, number] {
  const corner = EDGE_CORNER[edge];
  const axis = edge >> 2;
  const point: [number, number, number] = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
  point[axis] = 0.5;
  return point;
}

function triangleArea(a: number, b: number, c: number): number {
  const pa = edgeMidpoint(a);
  const pb = edgeMidpoint(b);
  const pc = edgeMidpoint(c);
  const ux = pb[0] - pa[0];
  const uy = pb[1] - pa[1];
  const uz = pb[2] - pa[2];
  const vx = pc[0] - pa[0];
  const vy = pc[1] - pa[1];
  const vz = pc[2] - pa[2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/**
 * Triangulates a closed loop of edge vertices without adding vertices, keeping the loop's
 * orientation, and returns false when that is impossible under the following rule.
 *
 * A triangle side that is not a side of the loop (a "diagonal") must not join two vertices lying
 * on the same cube face. Such a diagonal would lie in that face, where the neighbouring cube may
 * create the very same edge, giving an edge shared by four triangles (this can only happen on
 * ambiguous faces, which carry four vertices). The rule also excludes triangles lying flat in a
 * face. Among the admissible triangulations the one with the smallest area (measured with the
 * vertices at the edge midpoints) is taken.
 */
function triangulateLoop(loop: readonly number[], out: number[]): boolean {
  const n = loop.length;
  if (n === 3) {
    out.push(loop[0], loop[1], loop[2]);
    return true;
  }
  const allowed = (i: number, j: number): boolean => j - i === 1 || (i === 0 && j === n - 1) || (EDGE_FACES[loop[i]] & EDGE_FACES[loop[j]]) === 0;
  const cost = new Float64Array(n * n);
  const split = new Int8Array(n * n).fill(-1);
  for (let span = 2; span < n; span++) {
    for (let i = 0; i + span < n; i++) {
      const j = i + span;
      let best = Infinity;
      let bestK = -1;
      if (allowed(i, j)) {
        for (let k = i + 1; k < j; k++) {
          const value = cost[i * n + k] + cost[k * n + j] + triangleArea(loop[i], loop[k], loop[j]);
          if (value < best) {
            best = value;
            bestK = k;
          }
        }
      }
      cost[i * n + j] = best;
      split[i * n + j] = bestK;
    }
  }
  if (cost[n - 1] === Infinity) return false;
  const emit = (i: number, j: number): void => {
    if (j - i < 2) return;
    const k = split[i * n + j];
    emit(i, k);
    out.push(loop[i], loop[k], loop[j]);
    emit(k, j);
  };
  emit(0, n - 1);
  return true;
}

/** Vertex ids from this value on denote the extra centre vertex of a loop rather than a cube edge. */
export const CENTRE_VERTEX = 12;

export interface CubeCase {
  /**
   * Vertex ids, three per triangle, counter-clockwise when seen from the outside region. Ids below
   * 12 are cube edges; id 12 + j is an extra vertex at the centre of the loop `centreLoops[j]`.
   */
  readonly triangles: Int8Array;
  /** Edge vertices of the loops that had to be triangulated as a fan around an extra centre vertex. */
  readonly centreLoops: readonly Int8Array[];
}

/**
 * Triangulation of the surface inside one cube for a corner mask, where bit c of `mask` is set
 * when corner c is inside and bit f of `connect` is set when the inside corners of ambiguous face
 * f are joined across that face.
 */
export function buildCase(mask: number, connect: number): CubeCase {
  const next = new Int8Array(12).fill(-1);
  for (let face = 0; face < 6; face++) {
    const inside = (k: number): boolean => ((mask >> FACE_CORNER[face * 4 + (k & 3)]) & 1) === 1;
    const ambiguous = (AMBIGUOUS_FACES[mask] >> face) & 1;
    for (let k = 0; k < 4; k++) {
      // Walking counter-clockwise (seen from outside the cube), a segment starts on the edge where
      // the walk enters the inside region and ends where it leaves it, which keeps the inside
      // region on the right of every segment and makes all loops consistently oriented.
      if (inside(k) || !inside(k + 1)) continue;
      let end: number;
      if (!ambiguous) {
        end = k + 1;
        while (inside(end + 1)) end++;
      } else if ((connect >> face) & 1) {
        end = k + 3; // cuts off the outside corner k
      } else {
        end = k + 1; // cuts off the inside corner k + 1
      }
      next[FACE_EDGE[face * 4 + k]] = FACE_EDGE[face * 4 + (end & 3)];
    }
  }

  const triangles: number[] = [];
  const centreLoops: Int8Array[] = [];
  const visited = new Uint8Array(12);
  for (let start = 0; start < 12; start++) {
    if (next[start] < 0 || visited[start]) continue;
    const loop: number[] = [];
    let edge = start;
    do {
      if (edge < 0 || visited[edge]) throw new Error(`Marching cubes: open surface loop for corner mask ${mask}.`);
      visited[edge] = 1;
      loop.push(edge);
      edge = next[edge];
    } while (edge !== start);
    if (!triangulateLoop(loop, triangles)) {
      // No admissible triangulation: fan around an extra vertex in the interior of the cube.
      const centre = CENTRE_VERTEX + centreLoops.length;
      centreLoops.push(Int8Array.from(loop));
      for (let k = 0; k < loop.length; k++) triangles.push(centre, loop[k], loop[(k + 1) % loop.length]);
    }
  }
  return { triangles: Int8Array.from(triangles), centreLoops };
}

const caseCache = new Map<number, CubeCase>();

function cubeCase(mask: number, connect: number): CubeCase {
  const key = mask | (connect << 8);
  let entry = caseCache.get(key);
  if (!entry) {
    entry = buildCase(mask, connect);
    caseCache.set(key, entry);
  }
  return entry;
}

/** Bit mask of the faces of a corner pattern whose two inside corners are diagonally opposite. */
export function ambiguousFaces(mask: number): number {
  return AMBIGUOUS_FACES[mask & 255];
}

const EMPTY_MESH: IsoMesh = { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0) };

/**
 * Extracts the isosurface `value = isoValue` of a scalar field sampled on a regular grid.
 *
 * - The enclosed ("inside") region is where the value is above `isoValue` when `isoValue >= 0`
 *   and below it when `isoValue < 0`, so the positive and the negative lobe of an orbital are
 *   obtained with +c and -c.
 * - Vertices lie on grid edges (linear interpolation) and each is created once and shared by all
 *   triangles around it; the mesh is a closed, consistently oriented manifold wherever the surface
 *   does not run into the boundary of the grid, where it simply ends (it is not capped).
 * - Triangles are wound counter-clockwise when seen from outside the enclosed region. Normals are
 *   the normalised field gradient (central differences, interpolated along the edge), oriented
 *   away from the enclosed region; where the gradient vanishes the area-weighted normal of the
 *   adjacent triangles is used instead.
 * - Positions are in the units of `grid` (angstrom for grids made by `createGrid`); `values` is
 *   indexed ix + dims[0] * (iy + dims[1] * iz). NaN values count as outside.
 *
 * Generic: nothing here is specific to quantum-chemical fields.
 */
export function marchingCubes(values: Float32Array, grid: GridSpec, isoValue: number): IsoMesh {
  const [nx, ny, nz] = grid.dims;
  for (let axis = 0; axis < 3; axis++) {
    if (!Number.isInteger(grid.dims[axis]) || grid.dims[axis] < 1) throw new RangeError('Grid dimensions must be positive integers.');
    if (!(grid.spacing[axis] > 0) || !Number.isFinite(grid.spacing[axis])) throw new RangeError('Grid spacing must be positive and finite.');
    if (!Number.isFinite(grid.origin[axis])) throw new RangeError('Grid origin must be finite.');
  }
  if (values.length !== nx * ny * nz) throw new RangeError(`Expected ${nx * ny * nz} grid values, got ${values.length}.`);
  if (!Number.isFinite(isoValue)) throw new RangeError('The isovalue must be a finite number.');
  if (nx < 2 || ny < 2 || nz < 2) return { positions: EMPTY_MESH.positions.slice(), normals: EMPTY_MESH.normals.slice(), indices: EMPTY_MESH.indices.slice() };

  const above = isoValue >= 0;
  const [ox, oy, oz] = grid.origin;
  const [hx, hy, hz] = grid.spacing;
  const strideY = nx;
  const strideZ = nx * ny;
  const stride = [1, strideY, strideZ];

  let positions = new Float32Array(3 * 1024);
  let normals = new Float32Array(3 * 1024);
  let needsFaceNormal = new Uint8Array(1024);
  let indices = new Uint32Array(3 * 2048);
  let vertexCount = 0;
  let indexCount = 0;
  let anyFaceNormal = false;

  // Vertex index of every grid edge of the current slab of cubes (-1 = not created yet).
  let xLower = new Int32Array(nx * ny).fill(-1);
  let xUpper = new Int32Array(nx * ny).fill(-1);
  let yLower = new Int32Array(nx * ny).fill(-1);
  let yUpper = new Int32Array(nx * ny).fill(-1);
  const zEdges = new Int32Array(nx * ny).fill(-1);

  const gradient = (ix: number, iy: number, iz: number, out: Float64Array, at: number): void => {
    const g = ix + strideY * iy + strideZ * iz;
    out[at] = ix === 0 ? (values[g + 1] - values[g]) / hx : ix === nx - 1 ? (values[g] - values[g - 1]) / hx : (values[g + 1] - values[g - 1]) / (2 * hx);
    out[at + 1] =
      iy === 0 ? (values[g + strideY] - values[g]) / hy : iy === ny - 1 ? (values[g] - values[g - strideY]) / hy : (values[g + strideY] - values[g - strideY]) / (2 * hy);
    out[at + 2] =
      iz === 0 ? (values[g + strideZ] - values[g]) / hz : iz === nz - 1 ? (values[g] - values[g - strideZ]) / hz : (values[g + strideZ] - values[g - strideZ]) / (2 * hz);
  };
  const grad = new Float64Array(6);

  const reserveVertex = (): void => {
    if (vertexCount * 3 < positions.length) return;
    const grownPositions = new Float32Array(positions.length * 2);
    grownPositions.set(positions);
    positions = grownPositions;
    const grownNormals = new Float32Array(normals.length * 2);
    grownNormals.set(normals);
    normals = grownNormals;
    const grownFlags = new Uint8Array(needsFaceNormal.length * 2);
    grownFlags.set(needsFaceNormal);
    needsFaceNormal = grownFlags;
  };

  /** Creates the vertex on the grid edge that starts at point (ix, iy, iz) and runs along `axis`. */
  const createVertex = (ix: number, iy: number, iz: number, axis: number): number => {
    reserveVertex();
    const g = ix + strideY * iy + strideZ * iz;
    const v0 = values[g];
    const v1 = values[g + stride[axis]];
    let t = (isoValue - v0) / (v1 - v0);
    if (!(t >= 0)) t = Number.isNaN(t) ? 0.5 : 0;
    else if (t > 1) t = 1;

    const o = vertexCount * 3;
    positions[o] = ox + (ix + (axis === 0 ? t : 0)) * hx;
    positions[o + 1] = oy + (iy + (axis === 1 ? t : 0)) * hy;
    positions[o + 2] = oz + (iz + (axis === 2 ? t : 0)) * hz;

    gradient(ix, iy, iz, grad, 0);
    gradient(ix + (axis === 0 ? 1 : 0), iy + (axis === 1 ? 1 : 0), iz + (axis === 2 ? 1 : 0), grad, 3);
    // The field decreases away from the enclosed region when that region is "above", so the
    // outward normal is minus the gradient there and plus the gradient otherwise.
    const sign = above ? -1 : 1;
    const gx = sign * (grad[0] + t * (grad[3] - grad[0]));
    const gy = sign * (grad[1] + t * (grad[4] - grad[1]));
    const gz = sign * (grad[2] + t * (grad[5] - grad[2]));
    const length = Math.hypot(gx, gy, gz);
    if (length > 0 && Number.isFinite(length)) {
      normals[o] = gx / length;
      normals[o + 1] = gy / length;
      normals[o + 2] = gz / length;
    } else {
      needsFaceNormal[vertexCount] = 1;
      anyFaceNormal = true;
    }
    return vertexCount++;
  };

  const cubeVertex = new Int32Array(CENTRE_VERTEX + 4);
  const corner = new Float64Array(8);

  /** Mesh vertex on cube edge `edge` of the cube at (ix, iy, iz), created on first use and shared afterwards. */
  const edgeVertex = (edge: number, ix: number, iy: number, iz: number): number => {
    let vertex = cubeVertex[edge];
    if (vertex >= 0) return vertex;
    const lowCorner = EDGE_CORNER[edge];
    const axis = edge >> 2;
    const px = ix + (lowCorner & 1);
    const py = iy + ((lowCorner >> 1) & 1);
    const upper = (lowCorner >> 2) & 1;
    const slot = px + nx * py;
    const cache = axis === 0 ? (upper ? xUpper : xLower) : axis === 1 ? (upper ? yUpper : yLower) : zEdges;
    vertex = cache[slot];
    if (vertex < 0) {
      vertex = createVertex(px, py, iz + upper, axis);
      cache[slot] = vertex;
    }
    cubeVertex[edge] = vertex;
    return vertex;
  };

  /** Extra vertex at the centre of a loop: mean position and mean normal of the loop's vertices. */
  const centreVertex = (loop: Int8Array, ix: number, iy: number, iz: number): number => {
    let x = 0;
    let y = 0;
    let z = 0;
    let nxSum = 0;
    let nySum = 0;
    let nzSum = 0;
    let incomplete = false;
    for (let k = 0; k < loop.length; k++) {
      const o = edgeVertex(loop[k], ix, iy, iz) * 3;
      x += positions[o];
      y += positions[o + 1];
      z += positions[o + 2];
      nxSum += normals[o];
      nySum += normals[o + 1];
      nzSum += normals[o + 2];
      if (needsFaceNormal[o / 3]) incomplete = true;
    }
    reserveVertex();
    const o = vertexCount * 3;
    positions[o] = x / loop.length;
    positions[o + 1] = y / loop.length;
    positions[o + 2] = z / loop.length;
    const length = Math.hypot(nxSum, nySum, nzSum);
    if (!incomplete && length > 0) {
      normals[o] = nxSum / length;
      normals[o + 1] = nySum / length;
      normals[o + 2] = nzSum / length;
    } else {
      needsFaceNormal[vertexCount] = 1;
      anyFaceNormal = true;
    }
    return vertexCount++;
  };

  for (let iz = 0; iz < nz - 1; iz++) {
    for (let iy = 0; iy < ny - 1; iy++) {
      const rowBase = strideY * iy + strideZ * iz;
      for (let ix = 0; ix < nx - 1; ix++) {
        const g = rowBase + ix;
        const c0 = values[g];
        const c1 = values[g + 1];
        const c2 = values[g + strideY];
        const c3 = values[g + strideY + 1];
        const c4 = values[g + strideZ];
        const c5 = values[g + strideZ + 1];
        const c6 = values[g + strideZ + strideY];
        const c7 = values[g + strideZ + strideY + 1];
        let mask = 0;
        if (above) {
          if (c0 > isoValue) mask |= 1;
          if (c1 > isoValue) mask |= 2;
          if (c2 > isoValue) mask |= 4;
          if (c3 > isoValue) mask |= 8;
          if (c4 > isoValue) mask |= 16;
          if (c5 > isoValue) mask |= 32;
          if (c6 > isoValue) mask |= 64;
          if (c7 > isoValue) mask |= 128;
        } else {
          if (c0 < isoValue) mask |= 1;
          if (c1 < isoValue) mask |= 2;
          if (c2 < isoValue) mask |= 4;
          if (c3 < isoValue) mask |= 8;
          if (c4 < isoValue) mask |= 16;
          if (c5 < isoValue) mask |= 32;
          if (c6 < isoValue) mask |= 64;
          if (c7 < isoValue) mask |= 128;
        }
        if (mask === 0 || mask === 255) continue;

        let connect = 0;
        const ambiguous = AMBIGUOUS_FACES[mask];
        if (ambiguous !== 0) {
          corner[0] = c0 - isoValue;
          corner[1] = c1 - isoValue;
          corner[2] = c2 - isoValue;
          corner[3] = c3 - isoValue;
          corner[4] = c4 - isoValue;
          corner[5] = c5 - isoValue;
          corner[6] = c6 - isoValue;
          corner[7] = c7 - isoValue;
          for (let face = 0; face < 6; face++) {
            if (!((ambiguous >> face) & 1)) continue;
            const a = FACE_CORNER[face * 4];
            const b = FACE_CORNER[face * 4 + 1];
            const c = FACE_CORNER[face * 4 + 2];
            const d = FACE_CORNER[face * 4 + 3];
            // Asymptotic decider: with the values shifted by the isovalue, the saddle point of the
            // bilinear interpolant is inside exactly when the product over the inside diagonal
            // exceeds the product over the outside diagonal. Both cubes sharing the face evaluate
            // the same two products, so they always agree.
            const insideDiagonal = (mask >> a) & 1 ? corner[a] * corner[c] : corner[b] * corner[d];
            const outsideDiagonal = (mask >> a) & 1 ? corner[b] * corner[d] : corner[a] * corner[c];
            if (insideDiagonal > outsideDiagonal) connect |= 1 << face;
          }
        }

        const entry = cubeCase(mask, connect);
        const triangles = entry.triangles;
        cubeVertex.fill(-1);
        if (indexCount + triangles.length > indices.length) {
          const grown = new Uint32Array(Math.max(indices.length * 2, indexCount + triangles.length));
          grown.set(indices);
          indices = grown;
        }
        for (let k = 0; k < triangles.length; k++) {
          const id = triangles[k];
          let vertex: number;
          if (id < CENTRE_VERTEX) {
            vertex = edgeVertex(id, ix, iy, iz);
          } else {
            vertex = cubeVertex[id];
            if (vertex < 0) {
              vertex = centreVertex(entry.centreLoops[id - CENTRE_VERTEX], ix, iy, iz);
              cubeVertex[id] = vertex;
            }
          }
          indices[indexCount++] = vertex;
        }
      }
    }
    // The upper layer of this slab is the lower layer of the next one.
    const swapX = xLower;
    xLower = xUpper;
    xUpper = swapX;
    xUpper.fill(-1);
    const swapY = yLower;
    yLower = yUpper;
    yUpper = swapY;
    yUpper.fill(-1);
    zEdges.fill(-1);
  }

  if (anyFaceNormal) {
    const sums = new Float64Array(vertexCount * 3);
    for (let k = 0; k < indexCount; k += 3) {
      const a = indices[k] * 3;
      const b = indices[k + 1] * 3;
      const c = indices[k + 2] * 3;
      const ux = positions[b] - positions[a];
      const uy = positions[b + 1] - positions[a + 1];
      const uz = positions[b + 2] - positions[a + 2];
      const vx = positions[c] - positions[a];
      const vy = positions[c + 1] - positions[a + 1];
      const vz = positions[c + 2] - positions[a + 2];
      const fx = uy * vz - uz * vy;
      const fy = uz * vx - ux * vz;
      const fz = ux * vy - uy * vx;
      for (const o of [a, b, c]) {
        sums[o] += fx;
        sums[o + 1] += fy;
        sums[o + 2] += fz;
      }
    }
    for (let v = 0; v < vertexCount; v++) {
      if (!needsFaceNormal[v]) continue;
      const o = v * 3;
      const length = Math.hypot(sums[o], sums[o + 1], sums[o + 2]);
      // A vertex surrounded only by zero-area triangles has no meaningful normal; any unit vector will do.
      normals[o] = length > 0 ? sums[o] / length : 0;
      normals[o + 1] = length > 0 ? sums[o + 1] / length : 0;
      normals[o + 2] = length > 0 ? sums[o + 2] / length : 1;
    }
  }

  return {
    positions: positions.slice(0, vertexCount * 3),
    normals: normals.slice(0, vertexCount * 3),
    indices: indices.slice(0, indexCount),
  };
}

export interface MeshStatistics {
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** Total surface area, in squared position units. */
  readonly area: number;
  /**
   * Volume enclosed by the surface (divergence theorem), in cubed position units; positive when the
   * triangles are wound counter-clockwise seen from outside. Only meaningful when `closed` is true.
   */
  readonly volume: number;
  /** Edges that belong to exactly one triangle (holes or the rim where a surface leaves the grid). */
  readonly boundaryEdges: number;
  /** Edges that belong to more than two triangles. */
  readonly nonManifoldEdges: number;
  /** Edges whose two triangles run along them in the same direction (inconsistent winding). */
  readonly inconsistentEdges: number;
  /** True when every edge is shared by exactly two triangles. */
  readonly closed: boolean;
  /** V - E + F over the vertices actually used; 2 per sphere-like component, 0 for a torus. */
  readonly eulerCharacteristic: number;
}

/** Area, enclosed volume and edge-manifold checks of an indexed triangle mesh. */
export function meshStatistics(mesh: IsoMesh): MeshStatistics {
  const { positions, indices } = mesh;
  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;
  let area = 0;
  let volume = 0;
  const keys = new Float64Array(indices.length);
  const used = new Uint8Array(vertexCount);
  for (let k = 0; k < indices.length; k += 3) {
    const ia = indices[k];
    const ib = indices[k + 1];
    const ic = indices[k + 2];
    used[ia] = 1;
    used[ib] = 1;
    used[ic] = 1;
    const ax = positions[ia * 3];
    const ay = positions[ia * 3 + 1];
    const az = positions[ia * 3 + 2];
    const bx = positions[ib * 3];
    const by = positions[ib * 3 + 1];
    const bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3];
    const cy = positions[ic * 3 + 1];
    const cz = positions[ic * 3 + 2];
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    area += 0.5 * Math.hypot(nx, ny, nz);
    volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    // One key per directed edge: the undirected edge id plus one half when traversed high -> low.
    for (let e = 0; e < 3; e++) {
      const from = indices[k + e];
      const to = indices[k + ((e + 1) % 3)];
      keys[k + e] = from < to ? from * vertexCount + to : to * vertexCount + from + 0.5;
    }
  }
  keys.sort();
  let edges = 0;
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let inconsistentEdges = 0;
  for (let i = 0; i < keys.length; ) {
    const id = Math.floor(keys[i]);
    let forward = 0;
    let backward = 0;
    while (i < keys.length && Math.floor(keys[i]) === id) {
      if (keys[i] === id) forward++;
      else backward++;
      i++;
    }
    edges++;
    const uses = forward + backward;
    if (uses === 1) boundaryEdges++;
    else if (uses > 2) nonManifoldEdges++;
    else if (forward !== 1) inconsistentEdges++;
  }
  let usedVertices = 0;
  for (let v = 0; v < vertexCount; v++) usedVertices += used[v];
  return {
    vertexCount,
    triangleCount,
    area,
    volume,
    boundaryEdges,
    nonManifoldEdges,
    inconsistentEdges,
    closed: triangleCount > 0 && boundaryEdges === 0 && nonManifoldEdges === 0,
    eulerCharacteristic: usedVertices - edges + triangleCount,
  };
}
