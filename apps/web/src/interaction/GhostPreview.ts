import type { BondOrder, Vec3 } from '@matterlab/core';
import { CylinderGeometry, Group, IcosahedronGeometry, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { MODE_STYLES, atomRadiusFor, elementColorLinear } from '../render/style';

const UP = new Vector3(0, 1, 0);

/**
 * The translucent preview shown while drawing: the bond being pulled out of an atom and, when the
 * pointer is over empty space, the atom that would be created. It is purely a preview; nothing is
 * added to the scene until the pointer is released.
 */
export class GhostPreview {
  readonly object = new Group();
  private readonly atom: Mesh;
  private readonly bond: Mesh;
  private readonly atomMaterial: MeshStandardMaterial;
  private readonly bondMaterial: MeshStandardMaterial;
  private readonly direction = new Vector3();
  private readonly rotation = new Quaternion();

  constructor() {
    this.atomMaterial = new MeshStandardMaterial({ transparent: true, opacity: 0.55, roughness: 0.35, depthWrite: false });
    this.bondMaterial = new MeshStandardMaterial({ color: 0x55e2d1, transparent: true, opacity: 0.6, roughness: 0.4, depthWrite: false, emissive: 0x55e2d1, emissiveIntensity: 0.35 });
    this.atom = new Mesh(new IcosahedronGeometry(1, 6), this.atomMaterial);
    this.bond = new Mesh(new CylinderGeometry(1, 1, 1, 16, 1, false), this.bondMaterial);
    this.atom.renderOrder = 5;
    this.bond.renderOrder = 5;
    this.object.add(this.atom, this.bond);
    this.object.visible = false;
  }

  private placeBond(from: Vec3, to: Vec3, order: BondOrder): void {
    this.direction.set(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const length = this.direction.length();
    if (length < 1e-6) {
      this.bond.visible = false;
      return;
    }
    this.rotation.setFromUnitVectors(UP, this.direction.divideScalar(length));
    this.bond.quaternion.copy(this.rotation);
    this.bond.position.set((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2);
    const radius = 0.07 + 0.035 * (order === 1.5 ? 1.5 : order);
    this.bond.scale.set(radius, length, radius);
    this.bond.visible = true;
  }

  /** Previews a new atom of element `z` bonded to the atom at `from`. */
  showAtom(from: Vec3, at: Vec3, z: number, order: BondOrder): void {
    const [r, g, b] = elementColorLinear(z);
    this.atomMaterial.color.setRGB(r, g, b);
    this.atom.position.set(at[0], at[1], at[2]);
    this.atom.scale.setScalar(atomRadiusFor(MODE_STYLES['ball-stick'], z));
    this.atom.visible = true;
    this.placeBond(from, at, order);
    this.object.visible = true;
  }

  /** Previews a bond between two existing atoms. */
  showBond(from: Vec3, to: Vec3, order: BondOrder): void {
    this.atom.visible = false;
    this.placeBond(from, to, order);
    this.object.visible = true;
  }

  hide(): void {
    this.object.visible = false;
  }

  dispose(): void {
    this.atom.geometry.dispose();
    this.bond.geometry.dispose();
    this.atomMaterial.dispose();
    this.bondMaterial.dispose();
  }
}
