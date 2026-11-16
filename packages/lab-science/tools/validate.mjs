import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  getScienceMethod, getScienceSources, getTitrationReference, solveEquilibrium, solveJson,
} from '../dist/index.mjs';

const fixtureFile = new URL('../fixtures/replay-v1.json', import.meta.url);
const fixtures = JSON.parse(await readFile(fixtureFile, 'utf8'));
const cases = fixtures.cases.map((fixture) => {
  const result = solveEquilibrium(fixture.input);
  assert.equal(result.status, fixture.expected.status, fixture.id);
  const replay = JSON.stringify({ schemaVersion: 1, operation: 'equilibrium', input: fixture.input });
  assert.equal(solveJson(replay), solveJson(replay), `${fixture.id}: deterministic replay`);
  assert.deepEqual(JSON.parse(solveJson(replay)), result, `${fixture.id}: JSON parity`);
  if (result.status !== 'SUCCEEDED') {
    assert.equal(result.error.code, fixture.expected.code, fixture.id);
    assert.equal('pH' in result, false, `${fixture.id}: no fabricated pH`);
    return { id: fixture.id, status: result.status, code: result.error.code };
  }
  const differencePH = result.pH.value - fixture.expected.pH;
  assert.ok(Math.abs(differencePH) <= fixture.expected.absolutePHTolerance, `${fixture.id}: pH tolerance`);
  assert.ok(Math.abs(result.diagnostics.chargeResidualMolL) < 1e-12, `${fixture.id}: charge residual`);
  assert.ok(result.diagnostics.maximumMassResidualMolL < 1e-12, `${fixture.id}: mass residual`);
  return {
    id: fixture.id, status: result.status, pH: result.pH.value,
    referencePH: fixture.expected.pH,
    allowedDifferencePH: fixture.expected.absolutePHTolerance,
    differencePH,
    chargeResidualMolL: result.diagnostics.chargeResidualMolL,
    reconstructedChargeResidualMolL: result.diagnostics.reconstructedChargeResidualMolL,
    maximumMassResidualMolL: result.diagnostics.maximumMassResidualMolL,
    waterProductResidualMol2L2: result.diagnostics.waterProductResidualMol2L2,
    ionicStrengthMolL: result.diagnostics.ionicStrengthMolL,
    iterations: result.diagnostics.iterations,
    numericalPHBracketWidth: result.diagnostics.numericalPHBracketWidth,
  };
});

const titration = {
  analyte: { reagentId: 'hcl', volumeL: 0.025, concentrationMolL: 0.1 },
  titrantReagentId: 'naoh', titrantConcentrationMolL: 0.1, deliveredVolumeL: 0.025,
};
const endpoints = ['phenolphthalein', 'methyl-orange', 'bromothymol-blue'].map((indicatorId) => {
  const result = getTitrationReference({ ...titration, indicatorId, endpointBaseFraction: 0.5 });
  assert.equal(result.status, 'SUCCEEDED', `${indicatorId}: endpoint reference`);
  return {
    indicatorId, baseFractionCriterion: 0.5,
    theoreticalEquivalenceVolumeL: result.equivalenceVolume.value,
    theoreticalEquivalencePH: result.equivalencePH.value,
    endpointTargetPH: result.endpoint.targetPH.value,
    estimatedEndpointVolumeL: result.endpoint.estimatedVolume.value,
    endpointOffsetFromEquivalenceL: result.endpoint.offsetFromEquivalence.value,
    interpretation: result.endpoint.interpretation,
  };
});

const benchmarkInput = fixtures.cases.find((fixture) => fixture.id === 'acetic-acid-half-equivalence').input;
for (let index = 0; index < 16; index++) solveEquilibrium(benchmarkInput);
const timings = [];
for (let index = 0; index < 64; index++) {
  const start = performance.now();
  assert.equal(solveEquilibrium(benchmarkInput).status, 'SUCCEEDED');
  timings.push(performance.now() - start);
}
timings.sort((a, b) => a - b);
const report = {
  generatedAt: new Date().toISOString(),
  method: getScienceMethod(),
  validation: {
    fixtureFile: 'fixtures/replay-v1.json',
    fixtureCount: cases.length,
    supportedNumericCases: cases.filter((entry) => entry.status === 'SUCCEEDED').length,
    explicitUnsupportedCases: cases.filter((entry) => entry.status === 'UNSUPPORTED').length,
    allChecksPassed: true,
    cases, endpoints,
  },
  timing: {
    scope: 'Small single-thread warm solver check, not a UI/FPS benchmark or performance guarantee on this shared host.',
    node: process.version, platform: process.platform, arch: process.arch,
    cpu: cpus()[0]?.model ?? 'not reported',
    warmupCalls: 16, measuredCalls: 64,
    medianMs: timings[32], p95Ms: timings[60], maximumMs: timings[63],
  },
  sources: getScienceSources(),
};
const text = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv.includes('--write')) await writeFile(new URL('../validation-results.json', import.meta.url), text, 'utf8');
process.stdout.write(text);
