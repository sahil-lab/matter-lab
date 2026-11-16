#!/usr/bin/env node
/**
 * Downloads the RDKit source files that `@matterlab/forcefield` is ported from, at a pinned release
 * tag, into `tools/rdkit-src/` and writes `tools/rdkit-src/MANIFEST.json` with the tag, the commit
 * the tag points at, and a SHA-256 of every file.
 *
 * Only `Code/ForceField/UFF/Params.cpp` is machine-read (by `gen_uff_params.mjs`); the other files
 * are the reference the hand-written port in `src/` was checked against, kept so that a reviewer
 * can diff the port against exactly the code it claims to reproduce.
 *
 * Usage (from the repository root, after `.\env.ps1`):
 *   node packages/forcefield/tools/fetch_rdkit_sources.mjs [--tag Release_2026_09_2]
 *
 * RDKit is distributed under the BSD 3-Clause licence; `license.txt` is downloaded alongside.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'rdkit-src');

const args = process.argv.slice(2);
const tagFlag = args.indexOf('--tag');
const TAG = tagFlag >= 0 && args[tagFlag + 1] ? args[tagFlag + 1] : 'Release_2026_09_2';

const FILES = [
  'license.txt',
  // Force-field terms and parameters
  'Code/ForceField/UFF/Params.cpp',
  'Code/ForceField/UFF/Params.h',
  'Code/ForceField/UFF/BondStretch.cpp',
  'Code/ForceField/UFF/BondStretch.h',
  'Code/ForceField/UFF/AngleBend.cpp',
  'Code/ForceField/UFF/AngleBend.h',
  'Code/ForceField/UFF/TorsionAngle.cpp',
  'Code/ForceField/UFF/TorsionAngle.h',
  'Code/ForceField/UFF/Inversion.cpp',
  'Code/ForceField/UFF/Inversion.h',
  'Code/ForceField/UFF/Inversions.cpp',
  'Code/ForceField/UFF/Inversions.h',
  'Code/ForceField/UFF/Nonbonded.cpp',
  'Code/ForceField/UFF/Nonbonded.h',
  'Code/ForceField/UFF/Utils.cpp',
  'Code/ForceField/UFF/Utils.h',
  'Code/ForceField/UFF/Contribs.h',
  'Code/ForceField/UFF/testUFFForceField.cpp',
  // Atom typing and force-field construction
  'Code/GraphMol/ForceFieldHelpers/UFF/AtomTyper.cpp',
  'Code/GraphMol/ForceFieldHelpers/UFF/AtomTyper.h',
  'Code/GraphMol/ForceFieldHelpers/UFF/Builder.cpp',
  'Code/GraphMol/ForceFieldHelpers/UFF/Builder.h',
  'Code/GraphMol/ForceFieldHelpers/UFF/UFF.h',
  'Code/GraphMol/ForceFieldHelpers/UFF/testUFFHelpers.cpp',
  'Code/GraphMol/ForceFieldHelpers/FFConvenience.h',
  'Code/GraphMol/ForceFieldHelpers/Wrap/rdForceFields.cpp',
  // Perception the typer depends on
  'Code/GraphMol/ConjugHybrid.cpp',
  'Code/GraphMol/Aromaticity.cpp',
  'Code/GraphMol/AddHs.cpp',
  'Code/GraphMol/MolOps.h',
  'Code/Geometry/point.h',
  'Code/GraphMol/Atom.cpp',
  'Code/GraphMol/Atom.h',
  'Code/GraphMol/Bond.cpp',
  'Code/GraphMol/Bond.h',
  'Code/GraphMol/MolOps.cpp',
  'Code/GraphMol/PeriodicTable.h',
  'Code/GraphMol/atomic_data.cpp',
  'Code/GraphMol/FindRings.cpp',
  'Code/GraphMol/RingInfo.h',
  // Minimiser
  'Code/ForceField/ForceField.cpp',
  'Code/ForceField/ForceField.h',
  'Code/ForceField/Contrib.h',
  'Code/Numerics/Optimizer/BFGSOpt.h',
  'Code/Numerics/Optimizer/BFGSOpt.cpp',
  'Code/Numerics/Optimizer/LinearSearch.cpp',
];

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'matterlab-forcefield-tools' } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

async function resolveCommit(tag) {
  const ref = JSON.parse(await getText(`https://api.github.com/repos/rdkit/rdkit/git/refs/tags/${tag}`));
  let { sha, type } = ref.object;
  // Annotated tags point at a tag object; peel it to the commit.
  while (type === 'tag') {
    const obj = JSON.parse(await getText(`https://api.github.com/repos/rdkit/rdkit/git/tags/${sha}`));
    sha = obj.object.sha;
    type = obj.object.type;
  }
  if (type !== 'commit') throw new Error(`Tag ${tag} resolves to a ${type}, not a commit.`);
  return sha;
}

const commit = await resolveCommit(TAG);
console.log(`RDKit tag ${TAG} -> commit ${commit}`);

const manifest = {
  repository: 'https://github.com/rdkit/rdkit',
  tag: TAG,
  commit,
  license: 'BSD-3-Clause (see license.txt)',
  retrieved: new Date().toISOString().slice(0, 10),
  files: {},
};

for (const rel of FILES) {
  // Fetch by commit, not by tag, so what is hashed is exactly what the manifest names.
  const url = `https://raw.githubusercontent.com/rdkit/rdkit/${commit}/${rel}`;
  const text = await getText(url);
  const dest = join(OUT_DIR, ...rel.split('/'));
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, text);
  const sha256 = createHash('sha256').update(text).digest('hex');
  manifest.files[rel] = { sha256, bytes: Buffer.byteLength(text) };
  console.log(`  ${rel}  (${Buffer.byteLength(text)} bytes)`);
}

await writeFile(join(OUT_DIR, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${FILES.length} files and MANIFEST.json to ${OUT_DIR}`);
