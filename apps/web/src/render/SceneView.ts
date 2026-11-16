import { EMPTY_SCENE, neighborsOf, patchChangesTopology } from '@matterlab/core';
import type { AtomId, Bond, BondId, Scene, ScenePatch, Vec3 } from '@matterlab/core';
import {
  BackSide,
  BufferGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
} from 'three';
import type { Material } from 'three';
import type { PickData } from './picking';
import {
  DASHES_PER_STICK,
  MODE_STYLES,
  NEUTRAL_BOND_COLOR,
  atomRadiusFor,
  atomVisibility,
  bondPickRadius,
  elementColorLinear,
  elementMetalness,
  hexToLinear,
  instanceCountFor,
  sticksFor,
} from './style';
import type { ModeStyle } from './style';

export interface HighlightState {
  readonly selectedAtoms: ReadonlySet<AtomId>;
  readonly selectedBonds: ReadonlySet<BondId>;
  readonly hoveredAtom: AtomId | null;
  readonly hoveredBond: BondId | null;
  /** Atoms picked for a measurement in progress. */
  readonly picks: readonly AtomId[];
  /** Atoms with structural problems, shown in physics-evaluation mode. */
  readonly flagged: ReadonlyMap<AtomId, 'error' | 'warning'>;
}

export interface GeometryDetail {
  readonly sphereDetail: number;
  readonly cylinderSegments: number;
  readonly clearcoat: number;
}

const HALO_SELECTED = hexToLinear('#55E2D1').map((c) => c * 1.9) as [number, number, number];
const HALO_HOVER = hexToLinear('#E3F1FF').map((c) => c * 1.05) as [number, number, number];
const HALO_PICK = hexToLinear('#FFB66B').map((c) => c * 1.7) as [number, number, number];
const HALO_ERROR = hexToLinear('#FF8791').map((c) => c * 1.7) as [number, number, number];

function nextCapacity(needed: number, current: number): number {
  let capacity = Math.max(64, current);
  while (capacity < needed) capacity *= 2;
  return capacity;
}

/** Wraps shared vertex data in a fresh geometry so each instanced mesh can own its per-instance attributes. */
function shareGeometry(base: BufferGeometry): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setIndex(base.getIndex());
  geometry.setAttribute('position', base.getAttribute('position'));
  geometry.setAttribute('normal', base.getAttribute('normal'));
  return geometry;
}

function createInstanced(base: BufferGeometry, material: Material, capacity: number): InstancedMesh {
  const mesh = new InstancedMesh(shareGeometry(base), material, capacity);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  mesh.instanceColor.setUsage(DynamicDrawUsage);
  mesh.count = 0;
  // Instances move constantly; recomputing a culling volume would cost more than it saves.
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

function writeSphere(m: Float32Array, o: number, x: number, y: number, z: number, r: number): void {
  m[o] = r; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
  m[o + 4] = 0; m[o + 5] = r; m[o + 6] = 0; m[o + 7] = 0;
  m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = r; m[o + 11] = 0;
  m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
}

function writeNothing(m: Float32Array, o: number): void {
  m.fill(0, o, o + 16);
  m[o + 15] = 1;
}

/** Instance matrix placing the unit cylinder (radius 1, height 1 along Y) between two points. */
function writeStick(
  m: Float32Array,
  o: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r: number,
): void {
  let dx = bx - ax;
  let dy = by - ay;
  let dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-7 || r <= 0) return writeNothing(m, o);
  dx /= len; dy /= len; dz /= len;
  let ux: number, uy: number, uz: number;
  if (Math.abs(dx) < 0.9) { ux = 0; uy = dz; uz = -dy; } else { ux = -dz; uy = 0; uz = dx; }
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  // v = u x d keeps the basis right-handed, so triangle winding and lighting stay correct.
  const vx = uy * dz - uz * dy;
  const vy = uz * dx - ux * dz;
  const vz = ux * dy - uy * dx;
  m[o] = ux * r; m[o + 1] = uy * r; m[o + 2] = uz * r; m[o + 3] = 0;
  m[o + 4] = dx * len; m[o + 5] = dy * len; m[o + 6] = dz * len; m[o + 7] = 0;
  m[o + 8] = vx * r; m[o + 9] = vy * r; m[o + 10] = vz * r; m[o + 11] = 0;
  m[o + 12] = (ax + bx) / 2; m[o + 13] = (ay + by) / 2; m[o + 14] = (az + bz) / 2; m[o + 15] = 1;
}

/**
 * MatterRender's scene layer: turns a `Scene` into a handful of GPU-instanced meshes and keeps them
 * in step with edits by writing straight into the instance buffers. No React component exists per
 * atom, and moving atoms touches only the instances that changed.
 */
export class SceneView {
  readonly object = new Group();
  /**
   * Called after the instance buffers change: `rebuild` when atoms were added, removed or changed
   * identity, `move` when they only moved or changed size. Layers that track atoms hook in here.
   */
  onChange: ((kind: 'rebuild' | 'move') => void) | null = null;

  private scene: Scene = EMPTY_SCENE;
  private style: ModeStyle = MODE_STYLES['ball-stick'];
  private transient: ReadonlyMap<AtomId, Vec3> | null = null;
  private highlights: HighlightState | null = null;
  private outlineWidth = 0.05;

  private sphereBase: BufferGeometry;
  private haloSphereBase: BufferGeometry;
  private cylinderBase: BufferGeometry;
  private detail: GeometryDetail;

  private readonly atomMaterial: MeshPhysicalMaterial;
  private readonly bondMaterial: MeshPhysicalMaterial;
  private readonly haloMaterial: MeshBasicMaterial;

  private atomMesh: InstancedMesh;
  private bondMesh: InstancedMesh;
  private atomHalo: InstancedMesh;
  private bondHalo: InstancedMesh;
  private atomCapacity = 0;
  private stickCapacity = 0;
  private atomHaloCapacity = 0;
  private bondHaloCapacity = 0;

  // Dense per-atom data, indexed by instance.
  private atomIndex = new Map<AtomId, number>();
  private atomIds = new Int32Array(0);
  private atomPositions = new Float32Array(0);
  private atomRadii = new Float32Array(0);
  private atomCount = 0;

  // Dense per-bond data.
  private bondIndex = new Map<BondId, number>();
  private bondIds = new Int32Array(0);
  private bondStart = new Float32Array(0);
  private bondEnd = new Float32Array(0);
  /** The part of each bond visible between its two atom spheres; this is what the pointer can hit. */
  private bondPickStart = new Float32Array(0);
  private bondPickEnd = new Float32Array(0);
  private bondRadii = new Float32Array(0);
  private bondFirstStick = new Int32Array(0);
  private bondCount = 0;
  private stickCount = 0;

  constructor(detail: GeometryDetail) {
    this.detail = detail;
    this.sphereBase = new IcosahedronGeometry(1, detail.sphereDetail);
    this.haloSphereBase = new IcosahedronGeometry(1, 4);
    this.cylinderBase = new CylinderGeometry(1, 1, 1, detail.cylinderSegments, 1, false);

    this.atomMaterial = new MeshPhysicalMaterial({
      roughness: 0.3,
      metalness: 0,
      clearcoat: detail.clearcoat,
      clearcoatRoughness: 0.22,
      envMapIntensity: 1,
    });
    // Per-instance metalness: metals read as polished metal, non-metals as glossy dielectric.
    this.atomMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aMetal;\nvarying float vMetal;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMetal = aMetal;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vMetal;')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= mix(1.0, 0.8, vMetal);')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vMetal;');
    };
    this.atomMaterial.customProgramCacheKey = () => 'matterlab-atom-1';

    this.bondMaterial = new MeshPhysicalMaterial({
      roughness: 0.42,
      metalness: 0.1,
      clearcoat: detail.clearcoat * 0.5,
      clearcoatRoughness: 0.35,
      envMapIntensity: 0.85,
    });
    // An enlarged, inside-out shell drawn in a flat colour shows only as a rim around the object.
    this.haloMaterial = new MeshBasicMaterial({ side: BackSide, toneMapped: false, fog: false });

    this.atomMesh = this.createAtomMesh(64);
    this.bondMesh = createInstanced(this.cylinderBase, this.bondMaterial, 64);
    this.atomHalo = createInstanced(this.haloSphereBase, this.haloMaterial, 64);
    this.bondHalo = createInstanced(this.cylinderBase, this.haloMaterial, 64);
    this.atomCapacity = this.stickCapacity = this.atomHaloCapacity = this.bondHaloCapacity = 64;
    this.object.add(this.atomMesh, this.bondMesh, this.atomHalo, this.bondHalo);
    this.object.matrixAutoUpdate = false;
  }

  private createAtomMesh(capacity: number): InstancedMesh {
    const mesh = createInstanced(this.sphereBase, this.atomMaterial, capacity);
    const metal = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    metal.setUsage(DynamicDrawUsage);
    mesh.geometry.setAttribute('aMetal', metal);
    return mesh;
  }

  private replace(old: InstancedMesh, next: InstancedMesh): InstancedMesh {
    this.object.remove(old);
    old.geometry.dispose();
    old.dispose();
    this.object.add(next);
    return next;
  }

  /** Applies a quality preset or level-of-detail change. */
  configure(detail: GeometryDetail): void {
    const geometryChanged = detail.sphereDetail !== this.detail.sphereDetail || detail.cylinderSegments !== this.detail.cylinderSegments;
    this.atomMaterial.clearcoat = detail.clearcoat;
    this.bondMaterial.clearcoat = detail.clearcoat * 0.5;
    this.atomMaterial.needsUpdate = true;
    this.bondMaterial.needsUpdate = true;
    this.detail = detail;
    if (!geometryChanged) return;
    this.sphereBase.dispose();
    this.cylinderBase.dispose();
    this.sphereBase = new IcosahedronGeometry(1, detail.sphereDetail);
    this.cylinderBase = new CylinderGeometry(1, 1, 1, detail.cylinderSegments, 1, false);
    this.atomMesh = this.replace(this.atomMesh, this.createAtomMesh(this.atomCapacity));
    this.bondMesh = this.replace(this.bondMesh, createInstanced(this.cylinderBase, this.bondMaterial, this.stickCapacity));
    this.bondHalo = this.replace(this.bondHalo, createInstanced(this.cylinderBase, this.haloMaterial, this.bondHaloCapacity));
    this.rebuild();
  }

  /** Brings the view in line with a scene. With a non-structural patch only the changed atoms are touched. */
  sync(scene: Scene, patch: ScenePatch | null): void {
    const previous = this.scene;
    this.scene = scene;
    const incremental =
      patch !== null &&
      !patchChangesTopology(patch) &&
      previous.atoms.size === scene.atoms.size &&
      scene.atoms.size === this.atomCount &&
      scene.bonds.size === this.bondCount;
    if (!incremental) return this.rebuild();
    const changed: AtomId[] = [];
    let identityChanged = false;
    for (const change of patch.atomsChanged) {
      changed.push(change.after.id);
      const { before, after } = change;
      if (before.protons !== after.protons || before.neutrons !== after.neutrons || before.electrons !== after.electrons) identityChanged = true;
    }
    if (identityChanged && this.style.carbonHydrogenScale < 1) {
      const affected = new Set(changed);
      for (const id of changed) for (const neighbor of neighborsOf(scene, id)) affected.add(neighbor.atomId);
      this.refreshAtoms(affected, 'rebuild');
    } else {
      this.refreshAtoms(changed, identityChanged ? 'rebuild' : 'move');
    }
  }

  setStyle(style: ModeStyle): void {
    this.style = style;
    this.rebuild();
  }

  /** Live position overrides while atoms are being dragged; `null` clears them. */
  setTransient(positions: ReadonlyMap<AtomId, Vec3> | null): void {
    const affected = new Set<AtomId>();
    if (this.transient) for (const id of this.transient.keys()) affected.add(id);
    this.transient = positions && positions.size > 0 ? positions : null;
    if (this.transient) for (const id of this.transient.keys()) affected.add(id);
    if (affected.size > 0) this.refreshAtoms(affected);
  }

  setHighlights(highlights: HighlightState): void {
    this.highlights = highlights;
    this.writeHalos();
  }

  /** Thickness of selection rims in angstrom; the caller keeps this near a constant size on screen. */
  setOutlineWidth(angstrom: number): void {
    if (Math.abs(angstrom - this.outlineWidth) < this.outlineWidth * 0.04) return;
    this.outlineWidth = angstrom;
    this.writeHalos();
  }

  get atoms(): number {
    return this.atomCount;
  }

  get sticks(): number {
    return this.stickCount;
  }

  /** Current position of an atom, including any live drag override. */
  position(id: AtomId): Vec3 | undefined {
    return this.transient?.get(id) ?? this.scene.atoms.get(id)?.position;
  }

  /** Radius at which an atom is currently drawn. */
  radius(id: AtomId): number {
    const i = this.atomIndex.get(id);
    return i === undefined ? 0 : this.atomRadii[i]!;
  }

  pickData(): PickData {
    return {
      atomCount: this.atomCount,
      atomPositions: this.atomPositions,
      atomRadii: this.atomRadii,
      atomIds: this.atomIds,
      bondCount: this.style.bondRadius > 0 ? this.bondCount : 0,
      bondStart: this.bondPickStart,
      bondEnd: this.bondPickEnd,
      bondRadii: this.bondRadii,
      bondIds: this.bondIds,
    };
  }

  dispose(): void {
    for (const mesh of [this.atomMesh, this.bondMesh, this.atomHalo, this.bondHalo]) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.sphereBase.dispose();
    this.haloSphereBase.dispose();
    this.cylinderBase.dispose();
    this.atomMaterial.dispose();
    this.bondMaterial.dispose();
    this.haloMaterial.dispose();
  }

  // ---------- building ----------

  private rebuild(): void {
    const scene = this.scene;
    const n = scene.atoms.size;
    if (n > this.atomCapacity) {
      this.atomCapacity = nextCapacity(n, this.atomCapacity);
      this.atomMesh = this.replace(this.atomMesh, this.createAtomMesh(this.atomCapacity));
    }
    if (this.atomIds.length < n) {
      this.atomIds = new Int32Array(this.atomCapacity);
      this.atomPositions = new Float32Array(this.atomCapacity * 3);
      this.atomRadii = new Float32Array(this.atomCapacity);
    }

    this.atomIndex.clear();
    let i = 0;
    for (const atom of scene.atoms.values()) {
      this.atomIndex.set(atom.id, i);
      this.atomIds[i] = atom.id;
      this.writeAtom(i, atom.id);
      i++;
    }
    this.atomCount = n;
    this.atomMesh.count = n;
    this.flagAtomBuffers();

    // Bonds: first lay out which cylinder instances each bond owns, then fill them in.
    const bondTotal = scene.bonds.size;
    if (this.bondIds.length < bondTotal) {
      const capacity = nextCapacity(bondTotal, this.bondIds.length);
      this.bondIds = new Int32Array(capacity);
      this.bondStart = new Float32Array(capacity * 3);
      this.bondEnd = new Float32Array(capacity * 3);
      this.bondPickStart = new Float32Array(capacity * 3);
      this.bondPickEnd = new Float32Array(capacity * 3);
      this.bondRadii = new Float32Array(capacity);
      this.bondFirstStick = new Int32Array(capacity);
    }
    this.bondIndex.clear();
    let sticks = 0;
    let b = 0;
    for (const bond of scene.bonds.values()) {
      this.bondIndex.set(bond.id, b);
      this.bondIds[b] = bond.id;
      this.bondFirstStick[b] = sticks;
      sticks += instanceCountFor(sticksFor(this.style, bond.order));
      b++;
    }
    this.bondCount = bondTotal;
    this.stickCount = sticks;
    if (sticks > this.stickCapacity) {
      this.stickCapacity = nextCapacity(sticks, this.stickCapacity);
      this.bondMesh = this.replace(this.bondMesh, createInstanced(this.cylinderBase, this.bondMaterial, this.stickCapacity));
    }
    for (const bond of scene.bonds.values()) this.writeBond(bond);
    this.bondMesh.count = sticks;
    this.flagBondBuffers();
    this.writeHalos();
    this.onChange?.('rebuild');
  }

  private refreshAtoms(ids: Iterable<AtomId>, kind: 'rebuild' | 'move' = 'move'): void {
    // A moved atom changes its own bonds and can change the side direction of its neighbours' multiple bonds.
    const bonds = new Set<BondId>();
    for (const id of ids) {
      const i = this.atomIndex.get(id);
      if (i === undefined) continue;
      this.writeAtom(i, id);
      for (const n of neighborsOf(this.scene, id)) {
        bonds.add(n.bondId);
        for (const second of neighborsOf(this.scene, n.atomId)) bonds.add(second.bondId);
      }
    }
    for (const id of bonds) {
      const bond = this.scene.bonds.get(id);
      if (bond) this.writeBond(bond);
    }
    this.flagAtomBuffers();
    this.flagBondBuffers();
    this.writeHalos();
    this.onChange?.(kind);
  }

  private flagAtomBuffers(): void {
    this.atomMesh.instanceMatrix.needsUpdate = true;
    this.atomMesh.instanceColor!.needsUpdate = true;
    this.atomMesh.geometry.getAttribute('aMetal').needsUpdate = true;
  }

  private flagBondBuffers(): void {
    this.bondMesh.instanceMatrix.needsUpdate = true;
    this.bondMesh.instanceColor!.needsUpdate = true;
  }

  private writeAtom(i: number, id: AtomId): void {
    const atom = this.scene.atoms.get(id)!;
    const p = this.transient?.get(id) ?? atom.position;
    const r = atomRadiusFor(this.style, atom.protons) * atomVisibility(this.style, this.scene, atom);
    this.atomPositions[3 * i] = p[0];
    this.atomPositions[3 * i + 1] = p[1];
    this.atomPositions[3 * i + 2] = p[2];
    this.atomRadii[i] = r;
    writeSphere(this.atomMesh.instanceMatrix.array as Float32Array, 16 * i, p[0], p[1], p[2], r);
    const color = elementColorLinear(atom.protons);
    const colors = this.atomMesh.instanceColor!.array as Float32Array;
    colors[3 * i] = color[0];
    colors[3 * i + 1] = color[1];
    colors[3 * i + 2] = color[2];
    (this.atomMesh.geometry.getAttribute('aMetal').array as Float32Array)[i] = elementMetalness(atom.protons);
  }

  /**
   * Direction in which the extra sticks of a multiple bond are offset: towards a neighbouring
   * substituent, so the sticks lie in the local molecular plane, and towards the ring interior for
   * aromatic bonds.
   */
  private sideDirection(bond: Bond, dx: number, dy: number, dz: number): [number, number, number] {
    const positions = this.atomPositions;
    let best: [number, number, number] | null = null;
    let bestScore = -1;
    for (const [center, other] of [
      [bond.a, bond.b],
      [bond.b, bond.a],
    ] as const) {
      const ci = this.atomIndex.get(center)!;
      for (const n of neighborsOf(this.scene, center)) {
        if (n.atomId === other) continue;
        const ni = this.atomIndex.get(n.atomId);
        if (ni === undefined) continue;
        let rx = positions[3 * ni]! - positions[3 * ci]!;
        let ry = positions[3 * ni + 1]! - positions[3 * ci + 1]!;
        let rz = positions[3 * ni + 2]! - positions[3 * ci + 2]!;
        const along = rx * dx + ry * dy + rz * dz;
        rx -= along * dx; ry -= along * dy; rz -= along * dz;
        const len = Math.hypot(rx, ry, rz);
        if (len < 1e-3) continue;
        const neighbour = this.scene.atoms.get(n.atomId)!;
        const sameRing = bond.order === 1.5 && this.scene.bonds.get(n.bondId)!.order === 1.5;
        const score = (sameRing ? 4 : 0) + (neighbour.protons > 1 ? 2 : 0) + (center === bond.a ? 1 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = [rx / len, ry / len, rz / len];
        }
      }
    }
    if (best) return best;
    // No neighbours (a diatomic): any stable perpendicular will do.
    let ux: number, uy: number, uz: number;
    if (Math.abs(dx) < 0.9) { ux = 0; uy = dz; uz = -dy; } else { ux = -dz; uy = 0; uz = dx; }
    const ul = Math.hypot(ux, uy, uz);
    return [ux / ul, uy / ul, uz / ul];
  }

  private writeBond(bond: Bond): void {
    const b = this.bondIndex.get(bond.id);
    const ia = this.atomIndex.get(bond.a);
    const ib = this.atomIndex.get(bond.b);
    if (b === undefined || ia === undefined || ib === undefined) return;
    const P = this.atomPositions;
    const ax = P[3 * ia]!, ay = P[3 * ia + 1]!, az = P[3 * ia + 2]!;
    const bx = P[3 * ib]!, by = P[3 * ib + 1]!, bz = P[3 * ib + 2]!;
    this.bondStart[3 * b] = ax; this.bondStart[3 * b + 1] = ay; this.bondStart[3 * b + 2] = az;
    this.bondEnd[3 * b] = bx; this.bondEnd[3 * b + 1] = by; this.bondEnd[3 * b + 2] = bz;

    const sticks = sticksFor(this.style, bond.order);
    const visibility = Math.min(
      atomVisibility(this.style, this.scene, this.scene.atoms.get(bond.a)!),
      atomVisibility(this.style, this.scene, this.scene.atoms.get(bond.b)!),
    );
    this.bondRadii[b] = bondPickRadius(sticks) * visibility;

    // Trim the pickable segment to where the bond emerges from each atom sphere.
    {
      const lx = bx - ax, ly = by - ay, lz = bz - az;
      const full = Math.hypot(lx, ly, lz);
      const ra = this.atomRadii[ia]!;
      const rb = this.atomRadii[ib]!;
      const from = full > ra + rb ? ra / full : 0.5;
      const to = full > ra + rb ? 1 - rb / full : 0.5;
      this.bondPickStart[3 * b] = ax + lx * from; this.bondPickStart[3 * b + 1] = ay + ly * from; this.bondPickStart[3 * b + 2] = az + lz * from;
      this.bondPickEnd[3 * b] = ax + lx * to; this.bondPickEnd[3 * b + 1] = ay + ly * to; this.bondPickEnd[3 * b + 2] = az + lz * to;
    }
    if (sticks.length === 0) return;

    const matrices = this.bondMesh.instanceMatrix.array as Float32Array;
    const colors = this.bondMesh.instanceColor!.array as Float32Array;
    let slot = this.bondFirstStick[b]!;

    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-6 || visibility === 0) {
      for (let k = instanceCountFor(sticks); k > 0; k--) writeNothing(matrices, 16 * slot++);
      return;
    }
    dx /= length; dy /= length; dz /= length;

    const tint = this.style.bondTint;
    const ca = elementColorLinear(this.scene.atoms.get(bond.a)!.protons);
    const cb = elementColorLinear(this.scene.atoms.get(bond.b)!.protons);
    const setColor = (index: number, c: readonly number[]) => {
      colors[3 * index] = c[0]! + (NEUTRAL_BOND_COLOR[0] - c[0]!) * tint;
      colors[3 * index + 1] = c[1]! + (NEUTRAL_BOND_COLOR[1] - c[1]!) * tint;
      colors[3 * index + 2] = c[2]! + (NEUTRAL_BOND_COLOR[2] - c[2]!) * tint;
    };

    // The colour changes hands midway between the two atom surfaces, so both halves look equally long.
    const ra = this.atomRadii[ia]!;
    const rb = this.atomRadii[ib]!;
    const split = Math.min(0.92, Math.max(0.08, (ra + (length - rb)) / (2 * length)));
    const needsSide = sticks.length > 1;
    const side = needsSide ? this.sideDirection(bond, dx, dy, dz) : null;

    for (const stick of sticks) {
      const ox = side ? side[0] * stick.offset : 0;
      const oy = side ? side[1] * stick.offset : 0;
      const oz = side ? side[2] * stick.offset : 0;
      if (!stick.dashed) {
        const mx = ax + dx * length * split + ox;
        const my = ay + dy * length * split + oy;
        const mz = az + dz * length * split + oz;
        writeStick(matrices, 16 * slot, ax + ox, ay + oy, az + oz, mx, my, mz, stick.radius * visibility);
        setColor(slot++, ca);
        writeStick(matrices, 16 * slot, mx, my, mz, bx + ox, by + oy, bz + oz, stick.radius * visibility);
        setColor(slot++, cb);
        continue;
      }
      // Dashes span only the part of the bond visible between the two atom spheres.
      const from = Math.min(ra * 0.92, length * 0.45);
      const to = length - Math.min(rb * 0.92, length * 0.45);
      const pitch = (to - from) / DASHES_PER_STICK;
      for (let k = 0; k < DASHES_PER_STICK; k++) {
        const s0 = from + pitch * (k + 0.2);
        const s1 = from + pitch * (k + 0.8);
        writeStick(
          matrices,
          16 * slot,
          ax + dx * s0 + ox, ay + dy * s0 + oy, az + dz * s0 + oz,
          ax + dx * s1 + ox, ay + dy * s1 + oy, az + dz * s1 + oz,
          stick.radius * visibility,
        );
        setColor(slot++, (s0 + s1) / 2 < length * split ? ca : cb);
      }
    }
  }

  // ---------- highlights ----------

  private writeHalos(): void {
    const h = this.highlights;
    if (!h) {
      this.atomHalo.count = 0;
      this.bondHalo.count = 0;
      return;
    }
    const w = this.outlineWidth;

    // One rim per atom; the most important reason wins.
    const rims = new Map<AtomId, readonly [number, number, number]>();
    for (const [id, severity] of h.flagged) rims.set(id, severity === 'error' ? HALO_ERROR : HALO_PICK);
    if (h.hoveredAtom !== null) rims.set(h.hoveredAtom, HALO_HOVER);
    for (const id of h.picks) rims.set(id, HALO_PICK);
    for (const id of h.selectedAtoms) rims.set(id, HALO_SELECTED);

    if (rims.size > this.atomHaloCapacity) {
      this.atomHaloCapacity = nextCapacity(rims.size, this.atomHaloCapacity);
      this.atomHalo = this.replace(this.atomHalo, createInstanced(this.haloSphereBase, this.haloMaterial, this.atomHaloCapacity));
    }
    let matrices = this.atomHalo.instanceMatrix.array as Float32Array;
    let colors = this.atomHalo.instanceColor!.array as Float32Array;
    let count = 0;
    for (const [id, color] of rims) {
      const i = this.atomIndex.get(id);
      if (i === undefined || this.atomRadii[i]! <= 0) continue;
      const hovered = id === h.hoveredAtom && color !== HALO_HOVER;
      writeSphere(
        matrices,
        16 * count,
        this.atomPositions[3 * i]!, this.atomPositions[3 * i + 1]!, this.atomPositions[3 * i + 2]!,
        this.atomRadii[i]! + w * (hovered ? 1.55 : 1),
      );
      colors[3 * count] = color[0];
      colors[3 * count + 1] = color[1];
      colors[3 * count + 2] = color[2];
      count++;
    }
    this.atomHalo.count = count;
    this.atomHalo.instanceMatrix.needsUpdate = true;
    this.atomHalo.instanceColor!.needsUpdate = true;

    const bondRims = new Map<BondId, readonly [number, number, number]>();
    if (h.hoveredBond !== null) bondRims.set(h.hoveredBond, HALO_HOVER);
    for (const id of h.selectedBonds) bondRims.set(id, HALO_SELECTED);
    if (bondRims.size > this.bondHaloCapacity) {
      this.bondHaloCapacity = nextCapacity(bondRims.size, this.bondHaloCapacity);
      this.bondHalo = this.replace(this.bondHalo, createInstanced(this.cylinderBase, this.haloMaterial, this.bondHaloCapacity));
    }
    matrices = this.bondHalo.instanceMatrix.array as Float32Array;
    colors = this.bondHalo.instanceColor!.array as Float32Array;
    count = 0;
    if (this.style.bondRadius > 0) {
      for (const [id, color] of bondRims) {
        const b = this.bondIndex.get(id);
        if (b === undefined || this.bondRadii[b]! <= 0) continue;
        writeStick(
          matrices,
          16 * count,
          this.bondStart[3 * b]!, this.bondStart[3 * b + 1]!, this.bondStart[3 * b + 2]!,
          this.bondEnd[3 * b]!, this.bondEnd[3 * b + 1]!, this.bondEnd[3 * b + 2]!,
          this.bondRadii[b]! + w,
        );
        colors[3 * count] = color[0];
        colors[3 * count + 1] = color[1];
        colors[3 * count + 2] = color[2];
        count++;
      }
    }
    this.bondHalo.count = count;
    this.bondHalo.instanceMatrix.needsUpdate = true;
    this.bondHalo.instanceColor!.needsUpdate = true;
  }
}
