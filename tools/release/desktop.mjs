import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root, runProcess } from '../../qa/process.mjs';
import { createIcons } from './create-icons.mjs';

const command = process.argv[2] ?? 'check';
if (!['check', 'lock', 'dev', 'build', 'bundle'].includes(command)) throw new Error('Expected check|lock|dev|build|bundle');
const directory = join(root, 'apps', 'desktop');
const rustDirectory = join(directory, 'src-tauri');
const probes = [
  ['rustc', ['--version'], /^rustc 1\.95\.0\b/],
  ['cargo', ['--version'], /^cargo 1\.95\.0\b/],
  ['cargo-tauri', ['tauri', '--version'], /(?:tauri-cli|tauri) 2\.12\.4\b/],
].map(([name, args, version]) => {
  const result = spawnSync(name === 'cargo-tauri' ? 'cargo' : name, args, {
    cwd: rustDirectory, encoding: 'utf8', shell: false, timeout: 30_000,
    env: { ...process.env, RUSTUP_AUTO_INSTALL: '0' },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return {
    name,
    status: result.error ? 'MISSING' : result.status !== 0 ? 'FAILED' : version.test(output) ? 'READY' : 'VERSION_MISMATCH',
    detail: result.error?.message ?? output,
  };
});
const lockPresent = existsSync(join(rustDirectory, 'Cargo.lock'));
const ready = process.platform === 'win32'
  && probes.every((probe) => probe.status === 'READY')
  && (command === 'lock' || lockPresent);
const report = {
  checkedAt: new Date().toISOString(),
  target: 'x86_64-pc-windows-msvc',
  status: ready ? 'PREREQUISITES_READY_NOT_BUILT' : 'BLOCKED_NOT_BUILT',
  platform: process.platform,
  probes,
  cargoLockPresent: lockPresent,
  additionalPrerequisites: [
    'Microsoft Visual Studio Build Tools with Desktop development with C++ and Windows SDK.',
    'Microsoft Edge WebView2 Evergreen runtime for execution.',
    'A reviewed, committed Cargo.lock before claiming dependency-reproducible releases.',
    'Windows signing certificate and signed-bundle validation before public release.',
  ],
  limitations: [
    'This probe is not a compilation, WebView2, Rust linker or desktop-runtime test.',
    'No embedded backend is installed; FastAPI/PostgreSQL remain separately managed services.',
    'Linux and macOS desktop targets are not configured or verified.',
  ],
};
await mkdir(join(root, 'qa', 'results'), { recursive: true });
await writeFile(join(root, 'qa', 'results', 'desktop-prerequisites.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (!ready) {
  console.error('Desktop is blocked. Install Rust 1.95.0 (MSVC) and cargo-tauri 2.12.4; use npm run desktop:lock once, review and commit Cargo.lock. No build was attempted.');
  process.exitCode = 1;
} else if (command === 'lock') {
  const result = await runProcess('cargo', ['generate-lockfile'], { cwd: rustDirectory });
  process.exitCode = result.code;
  if (result.code === 0) console.log('Cargo.lock generated. Review and commit it; generation alone is not a verified desktop build.');
} else if (command !== 'check') {
  await createIcons();
  const args = command === 'dev' ? [
    'tauri', 'dev',
    ...(process.env.MATTERLAB_DESKTOP_EXISTING_DEV_SERVER === '1'
      ? ['--config', JSON.stringify({ build: { beforeDevCommand: null } })] : []),
    '--', '--locked',
  ]
    : ['tauri', 'build', ...(command === 'build' ? ['--no-bundle'] : []), '--', '--locked'];
  const result = await runProcess('cargo', args, { cwd: directory });
  await writeFile(join(root, 'qa', 'results', 'desktop-build.json'), `${JSON.stringify({
    completedAt: new Date().toISOString(),
    command,
    ...result,
    signed: false,
    runtimeTested: false,
  }, null, 2)}\n`);
  process.exitCode = result.code;
}
