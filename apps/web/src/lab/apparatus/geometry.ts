import type { ApparatusDefinition, ApparatusRuntimeState, BoundsM, Vec3M, VesselCalibration } from '@matterlab/contracts';
import {
  Box3, BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, DoubleSide, Euler, Group, LatheGeometry,
  LineBasicMaterial, LineSegments, Material, Matrix4, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial,
  Quaternion, SphereGeometry, TorusGeometry, Vector2, Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SceneResourceScope } from '../environment/SceneResourceManager';
import { createWorkbenchModel } from '../environment/workbenchGeometry';
import type { SceneQualityPreset } from '../environment/types';
import { apparatusTextGeometry } from './labels';
import { APPARATUS_DEFINITIONS } from './registry';

export interface ApparatusGeometry {
  readonly object: Group;
  readonly controls: ReadonlyMap<string, Group>;
  setState(state?: ApparatusRuntimeState): void;
  dispose(): void;
}
export interface ApparatusGeometryOptions {
  readonly glassMaterial?: Material;
  readonly labelMaterial?: Material;
}
export type ApparatusGeometryBuilder = (definition: ApparatusDefinition, quality: SceneQualityPreset, options: ApparatusGeometryOptions) => ApparatusGeometry;
const customBuilders = new Map<string, ApparatusGeometryBuilder>();
const builtinIds = new Set(APPARATUS_DEFINITIONS.map((definition) => definition.id));

export function registerApparatusGeometry(definitionId: string, build: ApparatusGeometryBuilder): () => void {
  if (builtinIds.has(definitionId) || customBuilders.has(definitionId)) throw new Error(`A renderer is already registered for ${definitionId}.`);
  customBuilders.set(definitionId, build);
  return () => { if (customBuilders.get(definitionId) === build) customBuilders.delete(definitionId); };
}

function radiusAt(calibration: VesselCalibration, heightM: number): number {
  const points = calibration.interiorProfile;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (heightM <= b.yM) return a.radiusM + (b.radiusM - a.radiusM) * (heightM - a.yM) / (b.yM - a.yM);
  }
  return points[points.length - 1]!.radiusM;
}
function graduationHeight(calibration: VesselCalibration, volumeL: number): number {
  const points = calibration.volumeHeightCurve;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (volumeL <= b.volumeL) return a.heightM + (b.heightM - a.heightM) * (volumeL - a.volumeL) / (b.volumeL - a.volumeL);
  }
  return calibration.maxFillHeightM;
}

/** Local-meter geometry only; the React wrapper applies the authoritative transform once. */
export function buildApparatusGeometry(
  definition: ApparatusDefinition,
  quality: SceneQualityPreset = 'balanced',
  options: ApparatusGeometryOptions = {},
): ApparatusGeometry {
  const custom = customBuilders.get(definition.id);
  if (custom) return custom(definition, quality, options);
  if (!builtinIds.has(definition.id)) throw new Error(`No geometry is registered for apparatus ${definition.id}.`);
  if (definition.kind === 'BENCH') {
    const bench = createWorkbenchModel(quality);
    return { object: bench.group, controls: new Map(), setState() {}, dispose: bench.dispose };
  }
  const resources = new SceneResourceScope();
  const object = new Group();
  object.name = definition.id;
  const controls = new Map<string, Group>();
  const segments = quality === 'low' ? 12 : quality === 'high' ? 32 : 24;
  const metal = resources.own(new MeshStandardMaterial({ color: '#94a8b0', metalness: 0.8, roughness: 0.28 }));
  const dark = resources.own(new MeshStandardMaterial({ color: '#233d4c', metalness: 0.5, roughness: 0.42 }));
  const ceramic = resources.own(new MeshStandardMaterial({ color: '#d9e2de', metalness: 0.05, roughness: 0.3 }));
  const rubber = resources.own(new MeshStandardMaterial({ color: '#17302f', roughness: 0.7 }));
  const accent = resources.own(new MeshStandardMaterial({ color: '#58b9ad', roughness: 0.42, metalness: 0.2 }));
  const glass = options.glassMaterial ?? resources.own(new MeshPhysicalMaterial({
    color: '#d8eaf0', roughness: 0.14, metalness: 0, transmission: quality === 'low' ? 0 : 0.86,
    thickness: 0.002, ior: 1.47, transparent: true, opacity: quality === 'low' ? 0.22 : 0.5,
    side: DoubleSide, depthWrite: false,
  }));
  const label = options.labelMaterial ?? resources.own(new MeshBasicMaterial({ color: '#ffffff', side: DoubleSide }));
  const batches = new Map<Material, BufferGeometry[]>();
  const add = (geometry: BufferGeometry, material: Material, position: Vec3M = [0, 0, 0], rotation: Vec3M = [0, 0, 0]) => {
    geometry.applyMatrix4(new Matrix4().compose(new Vector3(...position), new Quaternion().setFromEuler(new Euler(...rotation)), new Vector3(1, 1, 1)));
    const batch = batches.get(material);
    if (batch) batch.push(geometry);
    else batches.set(material, [geometry]);
  };
  const box = (size: Vec3M, position: Vec3M, material = dark, rotation: Vec3M = [0, 0, 0]) => add(new BoxGeometry(...size), material, position, rotation);
  const cylinder = (radius: number, height: number, position: Vec3M, material: Material = metal, rotation: Vec3M = [0, 0, 0], open = false) =>
    add(new CylinderGeometry(radius, radius, height, segments, 1, open), material, position, rotation);
  const sphere = (radius: number, position: Vec3M, material: Material = metal) =>
    add(new SphereGeometry(radius, segments, Math.max(6, segments / 2)), material, position);
  const ring = (radius: number, thickness: number, position: Vec3M, material: Material = metal) =>
    add(new TorusGeometry(radius, thickness, quality === 'low' ? 6 : 10, segments), material, position, [Math.PI / 2, 0, 0]);
  const text = (value: string, height: number, position: Vec3M) => add(apparatusTextGeometry(value, height), label, position);
  const dynamic = (id: string, position: Vec3M, geometry: BufferGeometry, material: Material) => {
    const group = new Group();
    group.position.set(...position);
    group.name = id;
    group.userData.labControlId = id;
    const mesh = new Mesh(resources.own(geometry), material);
    mesh.userData.labControlId = id;
    group.add(mesh);
    controls.set(id, group);
    object.add(group);
    return group;
  };

  const calibration = definition.vesselCalibration;
  if (calibration) {
    const wall = 0.0012;
    const profile = calibration.interiorProfile;
    const bottom = profile[0]!;
    const top = profile[profile.length - 1]!;
    const height = definition.dimensionsM[1];
    const outline = [
      ...profile.map((point) => new Vector2(point.radiusM + wall, point.yM)),
      new Vector2(top.radiusM + wall, height - wall),
      new Vector2(top.radiusM, height - wall),
      ...[...profile].reverse().map((point) => new Vector2(point.radiusM, point.yM)),
    ];
    add(new LatheGeometry(outline, segments), glass);
    ring(top.radiusM + wall / 2, wall / 2, [0, height - wall, 0], glass);
    if (definition.kind !== 'BURETTE' && definition.kind !== 'PIPETTE') {
      cylinder(bottom.radiusM + wall, bottom.yM, [0, bottom.yM / 2, 0], glass);
    }
    const marks = calibration.graduations;
    if (marks) {
      const stride = quality === 'low' ? marks.majorStepL : marks.minorStepL;
      const ticks = Math.floor(calibration.capacityL / stride + 1e-8);
      const lines: number[] = [];
      for (let i = 0; i <= ticks; i++) {
        const reading = Math.min(calibration.capacityL, i * stride);
        const contained = marks.reading === 'DELIVERED' ? calibration.capacityL - reading : reading;
        const y = graduationHeight(calibration, contained);
        const radius = radiusAt(calibration, y) + wall + 0.00015;
        const major = Math.abs(reading / marks.majorStepL - Math.round(reading / marks.majorStepL)) < 1e-7;
        const length = radius * (major ? 0.85 : 0.45);
        lines.push(-length, y, Math.sqrt(Math.max(0, radius ** 2 - length ** 2)), 0, y, radius);
        const labelStep = definition.kind === 'BURETTE' ? 0.005 : marks.majorStepL;
        if (Math.abs(reading / labelStep - Math.round(reading / labelStep)) < 1e-7) {
          text(String(Number((reading * 1000).toFixed(2))), definition.kind === 'BURETTE' ? 0.005 : 0.006, [radius * 0.15, y, radius + 0.0001]);
        }
      }
      const geometry = resources.own(new BufferGeometry());
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(lines), 3));
      object.add(new LineSegments(geometry, resources.own(new LineBasicMaterial({ color: '#e5edef', transparent: true, opacity: 0.8, depthWrite: false }))));
    }
    if (definition.kind === 'BURETTE') {
      cylinder(0.0025, 0.075, [0, 0.0625, 0], glass, [0, 0, 0], true);
      add(new CylinderGeometry(0.0025, 0.0007, 0.025, segments, 1, true), glass, [0, 0.0125, 0]);
      cylinder(0.006, 0.016, [0, 0.065, 0], ceramic, [Math.PI / 2, 0, 0]);
      dynamic('stopcock', [0, 0.065, 0.01], new BoxGeometry(0.05, 0.006, 0.004), accent);
    } else if (definition.kind === 'PIPETTE') {
      add(new CylinderGeometry(bottom.radiusM, 0.0006, bottom.yM, segments, 1, true), glass, [0, bottom.yM / 2, 0]);
      if (definition.id === 'dropper-3ml') sphere(0.008, [0, 0.132, 0], rubber);
    } else if (definition.id === 'graduated-cylinder-100ml') {
      cylinder(0.035, 0.009, [0, 0.0045, 0], glass);
    } else if (definition.id === 'reagent-bottle-250ml') {
      cylinder(top.radiusM + 0.0015, 0.008, [0, height - 0.004, 0], rubber);
    }
  } else if (definition.kind === 'STAND') {
    box([0.36, 0.02, 0.24], [0, 0.01, 0]);
    cylinder(0.008, 0.71, [0, 0.375, 0]);
    cylinder(0.01, 0.01, [0, 0.735, 0]);
    ring(0.012, 0.004, [0, 0.025, 0]);
  } else if (definition.kind === 'CLAMP') {
    ring(0.012, 0.004, [0, 0, 0]);
    cylinder(0.006, 0.28, [0.14, 0, 0], metal, [0, 0, Math.PI / 2]);
    cylinder(0.004, 0.027, [-0.015, 0, 0], dark, [0, 0, Math.PI / 2]);
    for (const z of [-0.018, 0.018]) box([0.05, 0.044, 0.008], [0.32, 0, z], rubber);
    box([0.04, 0.025, 0.052], [0.28, 0, 0], metal);
  } else if (definition.kind === 'STIRRER') {
    box([0.2, 0.048, 0.2], [0, 0.024, 0], ceramic);
    cylinder(0.085, 0.008, [0, 0.056, 0], ceramic);
    ring(0.086, 0.002, [0, 0.052, 0], metal);
    const knob = dynamic('stirring', [0.04, 0.025, 0.096], new CylinderGeometry(0.014, 0.014, 0.008, segments), dark);
    knob.children[0]!.rotation.x = Math.PI / 2;
    box([0.032, 0.008, 0.002], [-0.055, 0.026, 0.099], accent);
  } else if (definition.kind === 'PH_PROBE' || ['thermometer', 'temperature-sensor', 'conductivity-probe'].includes(definition.id)) {
    cylinder(0.008, 0.065, [0, 0.1675, 0], definition.kind === 'PH_PROBE' ? accent : dark);
    cylinder(0.0035, 0.128, [0, 0.07, 0], glass);
    sphere(0.004, [0, 0.004, 0], definition.id === 'conductivity-probe' ? metal : glass);
    ring(0.0075, 0.001, [0, 0.14, 0], rubber);
  } else if (definition.id === 'support-ring') {
    cylinder(0.004, 0.16, [0.08, 0, 0], metal, [0, 0, Math.PI / 2]);
    ring(0.048, 0.004, [0.16, 0, 0]);
    ring(0.012, 0.004, [0, 0, 0]);
  } else if (definition.id === 'lab-jack') {
    box([0.18, 0.008, 0.18], [0, 0.004, 0], dark);
    box([0.18, 0.008, 0.18], [0, 0.116, 0], metal);
    for (const z of [-0.06, 0.06]) {
      for (const angle of [-0.7, 0.7]) box([0.15, 0.008, 0.012], [0, 0.06, z], metal, [0, 0, angle]);
    }
  } else if (definition.id === 'funnel') {
    add(new CylinderGeometry(0.04, 0.006, 0.055, segments, 1, true), glass, [0, 0.0925, 0]);
    cylinder(0.006, 0.065, [0, 0.0325, 0], glass, [0, 0, 0], true);
    ring(0.039, 0.001, [0, 0.119, 0], glass);
  } else if (definition.kind === 'BALANCE') {
    box([0.24, 0.055, 0.24], [0, 0.0275, 0], ceramic);
    cylinder(0.09, 0.01, [0, 0.065, 0], metal);
    box([0.095, 0.025, 0.001], [0, 0.028, 0.1195], rubber);
    text('--', 0.011, [0, 0.028, 0.1201]);
  }

  for (const [material, geometries] of batches) {
    const merged = mergeGeometries(geometries);
    for (const geometry of geometries) geometry.dispose();
    if (!merged) {
      resources.dispose();
      throw new Error(`Could not batch geometry for ${definition.id}.`);
    }
    const mesh = new Mesh(resources.own(merged), material);
    mesh.castShadow = quality !== 'low' && material !== glass && material !== label;
    mesh.receiveShadow = material !== glass && material !== label;
    if (material === glass) mesh.renderOrder = 10;
    if (material === label) mesh.renderOrder = 12;
    object.add(mesh);
  }
  object.updateMatrixWorld(true);
  return {
    object,
    controls,
    setState(state) {
      const opening = state?.valveOpeningFraction ?? 0;
      if (!Number.isFinite(opening) || opening < 0 || opening > 1) throw new RangeError('Invalid stopcock state.');
      const stopcock = controls.get('stopcock');
      if (stopcock) stopcock.rotation.z = -Math.PI / 2 * opening;
      const stirrer = controls.get('stirring');
      if (stirrer) stirrer.rotation.z = state?.stirring?.enabled ? -Math.PI / 4 : 0;
    },
    dispose() { resources.dispose(); },
  };
}

export function measureApparatusGeometry(model: ApparatusGeometry): { boundsM: BoundsM; triangles: number; meshes: number; lineSegments: number } {
  model.object.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(model.object, true);
  let triangles = 0;
  let meshes = 0;
  let lineSegments = 0;
  model.object.traverse((child) => {
    if (child instanceof Mesh) {
      meshes++;
      triangles += (child.geometry.index?.count ?? child.geometry.getAttribute('position').count) / 3;
    } else if (child instanceof LineSegments) {
      lineSegments += child.geometry.getAttribute('position').count / 2;
    }
  });
  return {
    boundsM: { min: [bounds.min.x, bounds.min.y, bounds.min.z], max: [bounds.max.x, bounds.max.y, bounds.max.z] },
    triangles, meshes, lineSegments,
  };
}
