// Fills the measured numbers into packages/quantum/README.md.
//
//   $env:QUANTUM_REPORT = '1'; vitest run --project quantum        (writes reports/*.json)
//   node --import ./packages/quantum/tools/ts-loader.mjs packages/quantum/tools/bench.ts --write
//   node packages/quantum/tools/update-readme.mjs
//
// Every table between `<!-- BEGIN:name -->` and `<!-- END:name -->` markers in the README is
// regenerated from the JSON reports the tests and the benchmark wrote, so no number in those
// tables is typed by hand. Text outside the markers is left alone.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const report = async (name) => JSON.parse(await readFile(join(root, 'reports', `${name}.json`), 'utf8'));
const fixture = async (name) => JSON.parse(await readFile(join(root, 'test', 'fixtures', name), 'utf8'));

/**
 * All complete benchmark runs that were kept (reports/bench-runs/, written by `bench.ts --write`),
 * or just the latest one (reports/bench.json) when there is no such directory. Runs made with
 * --quick cover fewer systems and are left out.
 */
async function benchmarkRuns() {
  const directory = join(root, 'reports', 'bench-runs');
  let names = [];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    // No archive: fall back to the latest run below.
  }
  const runs = names.length > 0 ? await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8')))) : [await report('bench')];
  const systems = Math.max(...runs.map((run) => run.calculations.length));
  const complete = runs.filter((run) => run.quick !== true && run.calculations.length === systems);
  if (complete.length === 0) throw new Error('No complete benchmark run found; run tools/bench.ts --write (without --quick).');
  return complete.sort((a, b) => a.generated.localeCompare(b.generated));
}
const totalBestMs = (run) => run.calculations.reduce((sum, row) => sum + row.bestMs, 0);

const sci = (x) => (x === 0 ? '0' : x.toExponential(1).replace('e-', 'e-').replace('e+', 'e+'));
const fix = (x, digits) => x.toFixed(digits);
const table = (header, rows) => [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
const max = (rows, key) => Math.max(...rows.map((row) => row[key]));

const [pyscf, crawford, integrals, boys, fields, cubes, scf, stability, challenging, large, performance, benchRuns, pyscfFixture, crawfordManifest] = await Promise.all([
  report('pyscf-scf'),
  report('crawford'),
  report('integrals'),
  report('boys'),
  report('fields'),
  report('marching-cubes'),
  report('scf'),
  report('stability'),
  report('challenging'),
  report('large'),
  report('performance'),
  benchmarkRuns(),
  fixture('pyscf_reference.json'),
  fixture('crawford/manifest.json'),
]);
// The run reported in detail is the one that was disturbed least: the smallest total time.
const bench = benchRuns.reduce((best, run) => (totalBestMs(run) < totalBestMs(best) ? run : best));

const blocks = {};

// ---- one molecule near the size limit ---------------------------------------------------------
{
  const r = large.records.C13H28;
  blocks.large = table(
    ['Quantity', 'PySCF', 'this engine', 'deviation'],
    [
      ['Total energy / E<sub>h</sub>', fix(r.referenceEnergy, 10), fix(r.energy, 10), sci(r.totalEnergy)],
      ['Orbital energies / E<sub>h</sub> (largest deviation)', '', '', sci(r.orbitalEnergies)],
      ['Mulliken charges / e (largest deviation)', '', '', sci(r.mullikenCharges)],
      ['Dipole components / e a<sub>0</sub> (largest deviation)', '', '', sci(r.dipole)],
    ],
  );
  blocks['large-screening'] =
    `${r.shellQuartetsScreened} of ${r.shellQuartets} shell quartets (${((100 * r.shellQuartetsScreened) / r.shellQuartets).toFixed(0)} %) were skipped by the Schwarz test and ` +
    `${r.primitiveQuartetsComputed} of ${r.primitiveQuartetsWithoutScreening} primitive quartets (${((100 * r.primitiveQuartetsComputed) / r.primitiveQuartetsWithoutScreening).toFixed(0)} %) were evaluated; ` +
    `${r.iterations} SCF iterations, and ${r.hessianProducts} Hessian-vector products for the stability certificate (${r.orbitalRotations} orbital rotations)`;
}

// ---- PySCF: energies and properties ------------------------------------------------------------
{
  const rows = pyscf.records['default-settings'].rows;
  const tight = pyscf.records['tight-settings'].rows;
  const required = ['H2', 'HeH+', 'LiH', 'H2O', 'NH3', 'CH4', 'HF', 'N2', 'CO', 'CO2', 'HCN', 'C2H4', 'C2H2', 'H2S', 'HCl', 'SiH4', 'PH3', 'NH4+', 'OH-', 'H2CO', 'C6H6'];
  const general = rows.filter((row) => row.system.endsWith('(general)'));
  const name = (row) => row.system.replace(' (general)', '');
  const line = (row) => [
    name(row),
    row.nBasis,
    fix(row.referenceEnergy, 10),
    fix(row.energy, 10),
    sci(row.totalEnergy),
    sci(row.orbitalEnergies),
    sci(row.mullikenCharges),
    sci(row.dipole),
    row.iterations,
    fix(row.virialRatio, 4),
  ];
  const header = ['System', 'N<sub>bf</sub>', 'E<sub>ref</sub> (PySCF) / E<sub>h</sub>', 'E (this engine) / E<sub>h</sub>', '\\|ΔE\\|', 'max \\|Δε\\|', 'max \\|Δq\\|', 'max \\|Δμ\\|', 'SCF iterations', '−V/T'];
  blocks['pyscf-required'] = table(header, general.filter((row) => required.includes(name(row))).sort((a, b) => required.indexOf(name(a)) - required.indexOf(name(b))).map(line));
  blocks['pyscf-additional'] = table(header, general.filter((row) => !required.includes(name(row))).map(line));
  const canonical = rows.filter((row) => row.system.endsWith('(canonical)'));
  blocks['pyscf-summary'] = table(
    ['Quantity', 'Target', `Largest deviation, default settings (${rows.length} runs)`, 'Largest deviation, tight convergence'],
    [
      ['Total energy / E<sub>h</sub>', '1e-6', sci(max(rows, 'totalEnergy')), sci(max(tight, 'totalEnergy'))],
      ['Orbital energies / E<sub>h</sub>', '1e-5', sci(max(rows, 'orbitalEnergies')), sci(max(tight, 'orbitalEnergies'))],
      ['Mulliken charges / e', '1e-4', sci(max(rows, 'mullikenCharges')), sci(max(tight, 'mullikenCharges'))],
      ['Dipole components / e a<sub>0</sub>', '1e-4', sci(max(rows, 'dipole')), sci(max(tight, 'dipole'))],
      ['Kinetic energy / E<sub>h</sub>', '-', sci(max(rows, 'kinetic')), sci(max(tight, 'kinetic'))],
      ['Nuclear repulsion / E<sub>h</sub>', '-', sci(max(rows, 'nuclearRepulsion')), sci(max(tight, 'nuclearRepulsion'))],
    ],
  );
  blocks['pyscf-meta'] =
    `PySCF ${pyscfFixture.versions.pyscf} (NumPy ${pyscfFixture.versions.numpy}, Python ${pyscfFixture.versions.python}), fixture generated ${pyscfFixture.generated}; ` +
    `${pyscfFixture.molecules.length} systems (${general.length} in a general orientation, ${canonical.length} of them also axis-aligned), ` +
    `${pyscfFixture.integrals.length} element-wise integral sets, ${pyscfFixture.fields.length} field sets.`;
}

// ---- Crawford ------------------------------------------------------------------------------------
{
  const r = crawford.records;
  const row = (molecule, basis, label) => {
    const i = r[`crawford/${molecule}/${basis}/integrals`];
    const s = r[`crawford/${molecule}/${basis}/scf`];
    return [`${molecule.toUpperCase()}`, label, sci(i.overlap), sci(i.kinetic), sci(i.nuclearAttraction), sci(i.dipole), sci(i.eriListed), fix(s.referenceTotalEnergy, 12), fix(s.totalEnergy, 12), sci(s.totalEnergyDeviation), sci(s.dipoleDeviation), sci(s.chargeDeviation)];
  };
  blocks.crawford = table(
    ['Molecule', 'Basis parameters used by the engine', 'max \\|ΔS\\|', 'max \\|ΔT\\|', 'max \\|ΔV\\|', 'max \\|Δμ-integrals\\|', 'max \\|ΔERI\\|', 'E<sub>ref</sub> / E<sub>h</sub>', 'E / E<sub>h</sub>', '\\|ΔE\\|', '\\|Δμ\\|', '\\|Δq\\|'],
    [
      row('h2o', 'reference-basis', 'PSI3 library STO-3G (as the reference)'),
      row('ch4', 'reference-basis', 'STO-3G from the reference input file'),
      row('h2o', 'bse-basis', 'bundled BSE snapshot'),
      row('ch4', 'bse-basis', 'bundled BSE snapshot'),
    ],
  );
  blocks['crawford-meta'] = `commit \`${crawfordManifest.crawford.commit}\`, retrieved ${crawfordManifest.crawford.retrieved}; PSI3 basis library commit \`${crawfordManifest.psi3.commit}\``;
}

// ---- integrals against PySCF, Boys function ------------------------------------------------------
{
  const names = Object.keys(integrals.records).filter((key) => key.startsWith('pyscf/'));
  blocks.integrals = table(
    ['Molecule', 'N<sub>bf</sub>', 'max \\|ΔS\\|', 'max \\|ΔT\\|', 'max \\|ΔV\\|', 'max \\|Δ⟨r⟩\\|', 'unique ERIs compared', 'max \\|ΔERI\\|'],
    names.map((key) => {
      const v = integrals.records[key];
      return [key.slice(6), v.nBasis, sci(v.overlap), sci(v.kinetic), sci(v.nuclearAttraction), sci(v.position), v.eriCount, sci(v.eri)];
    }),
  );
  const s = integrals.records.screening;
  blocks.screening = `${s.shellQuartets.screened} of ${s.shellQuartets.all} shell quartets and ${s.primitiveQuartets.all - s.primitiveQuartets.computed} of ${s.primitiveQuartets.all} primitive quartets skipped; largest change of any integral ${sci(s.largestDeviation)} E<sub>h</sub>`;
  const b = boys.records.mpmath;
  blocks.boys = `${b.arguments} arguments T in [${b.range[0]}, ${b.range[1].toExponential(0)}], m = 0..${b.orders - 1}, against mpmath ${b.mpmath}: largest relative error ${sci(b.worstRelative)} (at ${b.worstAt}), largest absolute error ${sci(b.worstAbsolute)}`;
}

// ---- systems with several SCF solutions, and the stability analysis -------------------------------
{
  const INSTABILITY = -1e-5;
  const hessians = stability.records.hessians;
  const finals = hessians.filter((row) => row.solution === 'final');
  const saddles = hessians.filter((row) => row.solution !== 'final');
  const eigenvalue = (x) => (Math.abs(x) < -INSTABILITY ? '0 (zero mode)' : fix(x, 4));
  const rows = challenging.records.systems.rows;
  blocks.challenging = table(
    ['System', 'E (this engine) / E<sub>h</sub>', 'PySCF lowest stable / E<sub>h</sub>', 'ΔE', 'saddle points left', 'SCF iterations', 'lowest Hessian eigenvalue / E<sub>h</sub>', 'PySCF runs that converged (of 4)'],
    rows.map((row) => {
      const hessian = finals.find((candidate) => candidate.system === row.system);
      if (!hessian) throw new Error(`No Hessian was diagonalised for ${row.system}.`);
      return [
        row.system,
        fix(row.energy, 10),
        row.pyscfLowestStable === null ? `none converged (lowest reached ${fix(row.pyscfLowestSeen, 8)})` : fix(row.pyscfLowestStable, 10),
        row.deviation === null ? '-' : sci(row.deviation),
        row.saddlePointsLeft,
        row.iterations,
        eigenvalue(hessian.exactLowest),
        row.pyscfConvergedRuns.length,
      ];
    }),
  );
  const n2 = scf.records['stability/N2'];
  blocks['stability-n2'] = `saddle point at ${fix(n2.saddleEnergy, 10)} E<sub>h</sub> (PySCF from the same guess: ${fix(n2.pyscfCoreGuessEnergy, 10)}), final ${fix(n2.finalEnergy, 10)} E<sub>h</sub> (PySCF: ${fix(n2.referenceEnergy, 10)}), ${n2.iterations} SCF iterations and ${n2.hessianProducts} Hessian-vector products in total`;
  const all = scf.records['stability/all'];
  const analysed = all.filter((row) => row.lowestEigenvalue !== null);
  const reference = finals.filter((row) => /\((general|canonical)\)$/.test(row.system));
  blocks['stability-all'] =
    `the lowest eigenvalue of the orbital-rotation Hessian lies between ${fix(Math.min(...reference.map((row) => row.exactLowest)), 3)} and ${fix(Math.max(...reference.map((row) => row.exactLowest)), 3)} E<sub>h</sub> ` +
    `for the ${reference.length} runs with virtual orbitals. The engine spent ${Math.min(...analysed.map((row) => row.hessianProducts))} to ${Math.max(...analysed.map((row) => row.hessianProducts))} ` +
    `Hessian-vector products (Fock builds) per run on the analysis, on top of ${Math.min(...all.map((row) => row.iterations))} to ${Math.max(...all.map((row) => row.iterations))} SCF iterations`;

  const statistics = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { min: sorted[0], median: sorted[sorted.length >> 1], max: sorted[sorted.length - 1] };
  };
  const agree = (key) => hessians.filter((row) => row[key] < INSTABILITY === row.exactLowest < INSTABILITY).length;
  const dimensions = statistics(hessians.map((row) => row.dimension));
  const stableProducts = statistics(finals.map((row) => row.iterativeProducts));
  const saddleProducts = statistics(saddles.map((row) => row.iterativeProducts));
  const soft = hessians.filter((row) => row.softModes > 0);
  const matrices = stability.records['random-matrices'];
  blocks['stability-validation'] = table(
    ['Compared with a full diagonalisation', 'Result'],
    [
      ['Hessians diagonalised (final solutions / saddle points passed on the way)', `${hessians.length} (${finals.length} / ${saddles.length}), ${dimensions.min} to ${dimensions.max} orbital rotations`],
      ['lowest eigenvalue at the final solutions / E<sub>h</sub>', `${sci(Math.min(...finals.map((row) => row.exactLowest)))} to ${fix(Math.max(...finals.map((row) => row.exactLowest)), 4)}`],
      ['lowest eigenvalue at the saddle points / E<sub>h</sub>', `${fix(Math.min(...saddles.map((row) => row.exactLowest)), 4)} to ${fix(Math.max(...saddles.map((row) => row.exactLowest)), 4)}`],
      ['verdict of the engine (stable or not) correct', `${agree('engineValue')} of ${hessians.length}; ${hessians.filter((row) => row.engineExact).length} of them decided by full diagonalisation inside the engine`],
      ['verdict of the iterative search, forced on every size, correct', `${agree('iterativeValue')} of ${hessians.length}`],
      ['largest amount by which the iterative search fell below the true lowest eigenvalue', sci(Math.max(0, ...hessians.map((row) => row.exactLowest - row.iterativeValue)))],
      ['largest error of the unstable eigenvalue it converged', sci(Math.max(...saddles.map((row) => Math.abs(row.iterativeValue - row.exactLowest))))],
      ['its Hessian-vector products at stable solutions (median / largest)', `${stableProducts.median} / ${stableProducts.max}`],
      ['its Hessian-vector products at saddle points (median / largest)', `${saddleProducts.median} / ${saddleProducts.max}`],
      ['solutions at which it set a zero mode aside', soft.map((row) => `${row.system} (${row.iterativeProducts} products)`).join(', ')],
      [
        `${matrices.samples} random symmetric matrices with blocks that do not couple (${matrices.unstable} with, ${matrices.stable} without a negative eigenvalue)`,
        `${matrices.wrong} wrong verdicts, ${matrices.unconverged} unfinished searches; ${fix(matrices.meanProducts, 1)} products on average, at most ${matrices.maxProducts}`,
      ],
    ],
  );
  const axial = stability.records['axial-symmetry'];
  const broken = axial.filter((row) => row.zeroMode);
  const symmetric = axial.filter((row) => !row.zeroMode);
  blocks['stability-zero-modes'] =
    `${broken.map((row) => row.system).join(', ')}: the two p populations perpendicular to the axis differ by ${fix(Math.min(...broken.map((row) => row.splitting)), 2)} to ${fix(Math.max(...broken.map((row) => row.splitting)), 2)} electrons there, ` +
    `and by at most ${sci(Math.max(...symmetric.map((row) => row.splitting)))} in the other ${symmetric.length} linear molecules of the set at the default convergence thresholds ` +
    `(at most ${sci(Math.max(...symmetric.map((row) => row.splittingTightlyConverged)))} once the SCF is converged to 1e-11 E<sub>h</sub> in the energy and 1e-9 in the density)`;
}

// ---- fields ------------------------------------------------------------------------------------------
{
  const r = fields.records;
  const names = Object.keys(r).filter((key) => key.startsWith('pyscf/'));
  blocks.fields = table(
    ['Molecule', 'points', 'max \\|Δρ\\| / e a<sub>0</sub><sup>-3</sup>', 'max \\|Δψ\\| / a<sub>0</sub><sup>-3/2</sup> (orbitals compared)', 'max \\|ΔV\\| / E<sub>h</sub> e<sup>-1</sup>'],
    names.map((key) => [key.slice(6), r[key].points, sci(r[key].densityDeviation), `${sci(r[key].orbitalDeviation)} (${r[key].orbitalsCompared})`, sci(r[key].potentialDeviation)]),
  );
  const counts = Object.keys(r).filter((key) => key.startsWith('electron-count/'));
  blocks['electron-count'] = table(
    ['Molecule', 'grid spacing / Å', 'grid points', 'integrated electrons', 'exact', 'error'],
    counts.map((key) => {
      const [molecule, spacing] = key.slice('electron-count/'.length).split('@');
      return [molecule, spacing, r[key].points, fix(r[key].electrons, 6), r[key].expected, sci(r[key].error)];
    }),
  );
  blocks['far-field'] = table(
    ['distance / Å', 'V / E<sub>h</sub> e<sup>-1</sup>', 'dipole term μ·n/r² / E<sub>h</sub> e<sup>-1</sup>', 'ratio'],
    r['far-field/H2O'].map((row) => [row.distance, sci(row.potential), sci(row.dipoleTerm), fix(row.ratio, 4)]),
  );
  blocks['far-field-ions'] = table(
    ['Ion', ...r['far-field/NH4+'].map((row) => `V·r at ${row.distance} Å`)],
    ['NH4+', 'OH-', 'HeH+'].map((ion) => [ion, ...r[`far-field/${ion}`].map((row) => fix(row.timesR, 5))]),
  );
  const s = r.screening;
  blocks['field-screening'] = `largest change ${sci(s.pointDeviation)} e/a<sub>0</sub><sup>3</sup> in double precision at the grid points of a water grid (largest density there ${fix(s.largestDensity, 2)}); ${sci(s.gridDeviation)} between the single-precision grids`;
  const o = r['orbital-integrals'];
  blocks['orbital-integrals'] = `at ${o.coarse.spacing} Å the norms of HOMO, LUMO and HOMO-1 integrate to ${fix(o.coarse.norms.homo, 4)}, ${fix(o.coarse.norms.lumo, 4)}, ${fix(o.coarse.norms.below, 4)}; at ${o.fine.spacing} Å to ${fix(o.fine.norms.homo, 8)}, ${fix(o.fine.norms.lumo, 4)}, ${fix(o.fine.norms.below, 4)} (overlaps ${sci(Math.abs(o.fine.overlaps.homoLumo))} and ${sci(Math.abs(o.fine.overlaps.homoBelow))})`;
  const b = r['benzene-surface'];
  blocks['benzene-surface'] = `${b.coarse.triangles} triangles at ${b.coarse.spacing} Å (enclosed volume ${fix(b.coarse.volumeA3, 1)} Å³, area ${fix(b.coarse.areaA2, 1)} Å², density at the vertices within ${sci(b.coarse.contourError)} of the isovalue) and ${b.fine.triangles} triangles at ${b.fine.spacing} Å (${fix(b.fine.volumeA3, 1)} Å³, ${fix(b.fine.areaA2, 1)} Å², ${sci(b.fine.contourError)}); potential on the surface from ${fix(b.espMin, 4)} to ${fix(b.espMax, 4)} E<sub>h</sub>/e`;
}

// ---- marching cubes ----------------------------------------------------------------------------------
{
  const r = cubes.records;
  const pct = (x) => `${(100 * x).toFixed(2)} %`;
  blocks['marching-cubes'] = table(
    ['Field', 'vertices', 'triangles', 'area error', 'volume error', 'min normal·radial', 'min face-normal·radial'],
    [
      ['sphere, spacing R/10', r['sphere/spacing R/10'].vertices, r['sphere/spacing R/10'].triangles, pct(r['sphere/spacing R/10'].areaError), pct(r['sphere/spacing R/10'].volumeError), fix(r['sphere/spacing R/10'].minVertexDot, 6), fix(r['sphere/spacing R/10'].minFaceDot, 4)],
      ['sphere, spacing R/20', r['sphere/spacing R/20'].vertices, r['sphere/spacing R/20'].triangles, pct(r['sphere/spacing R/20'].areaError), pct(r['sphere/spacing R/20'].volumeError), fix(r['sphere/spacing R/20'].minVertexDot, 6), fix(r['sphere/spacing R/20'].minFaceDot, 4)],
      ['sphere, anisotropic spacing', '-', '-', pct(r['sphere/anisotropic'].areaError), pct(r['sphere/anisotropic'].volumeError), fix(r['sphere/anisotropic'].minVertexDot, 6), fix(r['sphere/anisotropic'].minFaceDot, 4)],
    ],
  );
  const noise = r.noise;
  blocks['marching-cubes-noise'] = Object.entries(noise)
    .map(([iso, v]) => `${iso.replace('iso ', 'isovalue ')}: ${v.triangles} triangles, ${v.boundaryEdges} boundary edges, ${v.nonManifoldEdges} non-manifold edges, ${v.inconsistentEdges} inconsistently oriented edges`)
    .join('; ');
  const c = r['case-table'];
  blocks['marching-cubes-cases'] = `${c.cases} combinations of corner pattern and ambiguous-face resolution, at most ${c.maxTrianglesPerCube} triangles per cube, ${c.casesWithCentreVertex} of them triangulated around an extra centre vertex`;
}

// ---- performance -------------------------------------------------------------------------------------
{
  const ms = (x) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));
  blocks.performance = table(
    ['System', 'N<sub>bf</sub>', 'first call / ms', 'best / ms', 'integrals / ms', 'SCF / ms', 'SCF iterations', 'estimatedSeconds × 1000', 'measured / estimated'],
    bench.calculations.map((row) => [row.system, row.nBasis, ms(row.firstMs), ms(row.bestMs), ms(row.integralsMs), ms(row.scfMs), row.iterations, ms(row.estimatedMs), fix(row.ratio, 2)]),
  );
  const f = bench.benzeneFields;
  blocks['performance-fields'] = table(
    ['Operation (benzene, 36 basis functions)', 'time'],
    [
      [`electron density on 64³ = ${64 ** 3} points (spacing ${fix(f.grid64.spacingAngstrom, 3)} Å)`, `${ms(f.grid64.densityBestMs)} ms (first call ${ms(f.grid64.densityFirstMs)} ms)`],
      ['one molecular orbital on the same grid', `${ms(f.grid64.orbitalBestMs)} ms`],
      [`marching cubes on that grid (isovalue ${f.isosurface.isoValue}: ${f.isosurface.vertices} vertices, ${f.isosurface.triangles} triangles)`, `${ms(f.grid64.marchingCubesBestMs)} ms`],
      [`electrostatic potential at the ${f.esp.points} surface vertices`, `${ms(f.esp.ms)} ms (${fix(f.esp.microsecondsPerPoint, 0)} µs per point)`],
      [`electron density on the default grid of createGrid (${f.defaultGrid.dims.join(' × ')} = ${f.defaultGrid.points} points, ${f.defaultGrid.spacingAngstrom} Å)`, `${ms(f.defaultGrid.densityMs)} ms`],
    ],
  );
  const classes = Object.entries(bench.primitiveQuartetNs);
  const model = bench.costModel;
  const range = (pick) => {
    const values = benchRuns.map(pick);
    return `${ms(Math.min(...values))} - ${ms(Math.max(...values))}`;
  };
  const sizes = Object.keys(bench.fockNsPerIntegral);
  blocks['performance-kernel'] = table(
    ['Building block', 'run reported above', `range over ${benchRuns.length} runs`, 'value in the cost model'],
    [
      ...classes.map(([label, ns], index) => [`two-electron integrals ${label}, ns per primitive quartet`, ms(ns), range((run) => run.primitiveQuartetNs[label]), model.primitiveQuartetNs[index]]),
      ...sizes.map((n) => [`Fock build, ns per stored integral (n = ${n})`, ms(bench.fockNsPerIntegral[n]), range((run) => run.fockNsPerIntegral[n]), `${model.fockNsPerIntegral} (${model.fockBuilds} builds)`]),
      ...sizes.map((n) => [`Jacobi diagonalisation, ns per n³ (n = ${n})`, ms(bench.jacobiNsPerCube[n]), range((run) => run.jacobiNsPerCube[n]), `part of ${model.linearAlgebraNsPerCube} per n³ and iteration (${model.iterations} iterations)`]),
    ],
  );
  const days = [...new Set(benchRuns.map((run) => run.generated.slice(0, 10)))];
  const busy = benchRuns.map((run) => run.machineCpuUtilisation);
  const percent = (x) => `${(100 * x).toFixed(0)} %`;
  blocks['performance-meta'] =
    `${bench.cpu} (${bench.logicalProcessors} logical processors), Node ${bench.node}, ${bench.threads}; ${benchRuns.length} complete benchmark run${benchRuns.length === 1 ? '' : 's'}, ` +
    `each in a fresh process, on ${days.join(' and ')}. While they ran, the machine as a whole (all processors, all processes) was ${percent(Math.min(...busy))} to ${percent(Math.max(...busy))} busy; ` +
    `the single-threaded benchmark itself accounts for ${(100 / bench.logicalProcessors).toFixed(1)} % of that`;

  // Spread between the runs: the same quantity in the run reported in detail, and its smallest,
  // median and largest value over all runs.
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[middle] : 0.5 * (sorted[middle - 1] + sorted[middle]);
  };
  const spread = (label, pick) => {
    const values = benchRuns.map(pick);
    return [label, ms(pick(bench)), ms(Math.min(...values)), ms(median(values)), ms(Math.max(...values))];
  };
  const calculation = (run, system) => {
    const row = run.calculations.find((candidate) => candidate.system === system);
    if (!row) throw new Error(`Benchmark run ${run.generated} has no system ${system}.`);
    return row;
  };
  blocks['performance-spread'] = table(
    ['Quantity', 'run reported above', 'smallest', 'median', 'largest'],
    [
      ...bench.calculations.map((row) => spread(`${row.system}, best / ms`, (run) => calculation(run, row.system).bestMs)),
      ...['H2O', 'CH4', 'C6H6'].map((system) => spread(`${system}, first call / ms`, (run) => calculation(run, system).firstMs)),
      spread('benzene, density on 64³ points, best / ms', (run) => run.benzeneFields.grid64.densityBestMs),
      spread('benzene, one orbital on 64³ points, best / ms', (run) => run.benzeneFields.grid64.orbitalBestMs),
      spread('benzene, marching cubes on 64³ points, best / ms', (run) => run.benzeneFields.grid64.marchingCubesBestMs),
      spread('benzene, potential, µs per point', (run) => run.benzeneFields.esp.microsecondsPerPoint),
      spread('whole-machine CPU utilisation during the run / %', (run) => 100 * run.machineCpuUtilisation),
    ],
  );
  const p = performance.records;
  blocks['performance-vitest'] = `water ${ms(p.water.bestMs)} ms (first call ${ms(p.water.coldMs)} ms), methane ${ms(p.methane.bestMs)} ms, benzene ${ms(p.benzene.bestMs)} ms, benzene density on 64³ points ${ms(p['benzene-fields'].densityGridBestMs)} ms`;
}

// A block that is a table goes on lines of its own, separated from its markers by blank lines.
// Any other block is a sentence fragment and is written in line with the surrounding text: its
// BEGIN marker must not start a line (Markdown would treat that line as raw HTML and end the
// paragraph or list item there), so a marker found at the start of a line is joined to the line
// before it, and punctuation that follows on the next line is pulled up behind the END marker.
const original = await readFile(join(root, 'README.md'), 'utf8');
const lineEnding = original.includes('\r\n') ? '\r\n' : '\n';
let readme = original.replace(/\r\n/g, '\n');
const used = new Set();
readme = readme.replace(/((?<=[^\n])\n[ \t]*)?<!-- BEGIN:([\w-]+) -->[\s\S]*?<!-- END:\2 -->(\n[ \t]*(?=[.,;:)]))?/g, (_match, before, name, after) => {
  if (!(name in blocks)) throw new Error(`README has a marker "${name}" for which no block is generated.`);
  used.add(name);
  const content = String(blocks[name]);
  if (content.includes('\n')) return `${before ?? ''}<!-- BEGIN:${name} -->\n\n${content}\n\n<!-- END:${name} -->${after ?? ''}`;
  return `${before === undefined ? '' : ' '}<!-- BEGIN:${name} -->${content}<!-- END:${name} -->`;
});
const misplaced = [...readme.matchAll(/^[ \t]*<!-- BEGIN:([\w-]+) -->(?!\n)/gm)].map((match) => match[1]);
if (misplaced.length > 0) throw new Error(`Inline blocks must follow text, not start a paragraph: ${misplaced.join(', ')}`);
const unused = Object.keys(blocks).filter((name) => !used.has(name));
await writeFile(join(root, 'README.md'), readme.replace(/\n/g, lineEnding));
console.log(`Updated ${used.size} blocks in README.md${unused.length > 0 ? `; not used: ${unused.join(', ')}` : ''}`);
