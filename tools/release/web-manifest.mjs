import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { inspectBuild, listBuildFiles } from '../../qa/check-build.mjs';
import { root } from '../../qa/process.mjs';

const directory = join(root, 'apps', 'web', 'dist');
const inspection = await inspectBuild(directory);
const entries = [];
for (const file of await listBuildFiles(directory)) {
  const bytes = await readFile(file);
  entries.push({
    path: relative(directory, file).replaceAll('\\', '/'),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
const manifest = {
  schemaVersion: 1,
  target: 'static-web',
  generatedAt: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirtyWorktree: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
  node: process.version,
  lockfileSha256: createHash('sha256').update(await readFile(join(root, 'package-lock.json'))).digest('hex'),
  inspection,
  files: entries,
  limitations: ['Checksums are not a code signature.', 'Static artifact inspection is not browser or desktop execution evidence.'],
};
await mkdir(join(root, 'qa', 'results'), { recursive: true });
const output = join(root, 'qa', 'results', 'web-release-manifest.json');
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Web release manifest: ${output}`);
