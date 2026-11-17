/**
 * Barrel for the procedural geometry layer. Every P0/P1 instrument's visual mesh is built from
 * one of these functions, each returning a `GeometryBuildResult` (material-tagged groups + a
 * derived poly count) ready for a `components/` renderer to turn into real `BufferGeometry`
 * meshes, and for `definitions/**` to size its `asset.polyCount` from (via `polyCountOf`).
 */
export * from './types';
export * from './polycount';
export * from './gltfLoader';
export * from './hardware';
export * from './profiles';

export * from './workbench';
export * from './retortStand';
export * from './buretteClamp';
export * from './burette';
export * from './conicalFlask';
export * from './reagentBottle';
export * from './magneticStirrer';
export * from './phProbe';

export * from './beaker';
export * from './testTube';
export * from './volumetricFlask';
export * from './pipette';

export * from './funnel';
export * from './graduatedCylinder';
export * from './dropper';
export * from './supportRing';
export * from './labJack';
export * from './balance';
