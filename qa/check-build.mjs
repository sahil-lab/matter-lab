import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './process.mjs';

export async function listBuildFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await listBuildFiles(path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths.sort();
}

export async function inspectBuild(directory) {
  const html = await readFile(join(directory, 'index.html'), 'utf8');
  const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1]).filter((value) => /\.(?:js|css)(?:[?#]|$)/.test(value));
  assert.ok(references.some((reference) => /\.js(?:[?#]|$)/.test(reference)), 'No executable application entry in the build.');
  for (const reference of references) {
    assert.ok(!/^(?:[a-z]+:)?\/\//i.test(reference), `Unexpected remote executable asset: ${reference}`);
    const asset = resolve(directory, reference.replace(/^\//, '').split(/[?#]/)[0]);
    assert.ok(asset.startsWith(`${resolve(directory)}${sep}`), `Asset escapes the release directory: ${reference}`);
    assert.ok((await stat(asset)).size > 0, `Missing or empty asset: ${reference}`);
  }
  const files = await listBuildFiles(directory);
  const scripts = files.filter((file) => file.endsWith('.js'));
  for (const file of scripts) {
    const script = await readFile(file, 'utf8');
    assert.ok(!script.includes('__MATTERLAB__'), `Production release exposes the molecular test hook: ${relative(directory, file)}`);
    assert.ok(!script.includes('__MATTERLAB_LAB_TEST__'), `Production release exposes the laboratory test hook: ${relative(directory, file)}`);
  }
  const wasm = files.filter((file) => file.endsWith('.wasm'));
  assert.ok(wasm.length > 0, 'RDKit WebAssembly is absent from the release.');
  for (const file of wasm) {
    const bytes = await readFile(file);
    assert.equal(bytes.subarray(0, 4).toString('hex'), '0061736d', `Invalid WebAssembly asset: ${file}`);
  }
  return {
    files: files.length,
    scripts: scripts.length,
    wasm: wasm.length,
    bytes: (await Promise.all(files.map((file) => stat(file)))).reduce((sum, file) => sum + file.size, 0),
    productionTestHooksAbsent: true,
  };
}

async function main() {
  const result = await inspectBuild(join(root, 'apps', 'web', 'dist'));
  await mkdir(join(root, 'qa', 'results'), { recursive: true });
  await writeFile(join(root, 'qa', 'results', 'build.json'), `${JSON.stringify({
    checkedAt: new Date().toISOString(), ...result,
  }, null, 2)}\n`);
  console.log(`Production artifact verified: ${result.files} files, ${result.scripts} scripts, ${result.wasm} WebAssembly assets, ${result.bytes} bytes; no test hooks.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
