import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { root } from './process.mjs';

execFileSync('git', ['diff', '--check', 'HEAD'], { cwd: root, stdio: 'inherit' });
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'utf8',
}).split('\0').filter(Boolean);
const checkedExtensions = new Set(['.ts', '.tsx', '.mjs', '.json', '.toml', '.yaml', '.yml', '.rs']);
let jsonFiles = 0;
for (const file of files) {
  const extension = extname(file);
  if (!checkedExtensions.has(extension)) continue;
  const source = await readFile(join(root, file), 'utf8');
  if (/^(<<<<<<< |=======$|>>>>>>> )/m.test(source)) throw new Error(`Unresolved merge marker in ${file}`);
  if (extension === '.json') {
    try { JSON.parse(source); } catch (error) { throw new Error(`${file}: ${error.message}`); }
    jsonFiles++;
  }
  if (extension === '.mjs') execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' });
}
console.log(`Repository hygiene passed: ${jsonFiles} JSON documents, JavaScript syntax, merge markers and changed-line whitespace. TypeScript is checked separately.`);
