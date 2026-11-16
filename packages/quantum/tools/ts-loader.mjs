// Lets Node run this package's TypeScript sources directly (built-in type stripping, Node >= 22.18)
// so that tools such as bench.ts measure the engine as native ES modules, the way a bundled
// browser build runs it, rather than through Vitest's module runner:
//
//   node --import ./packages/quantum/tools/ts-loader.mjs packages/quantum/tools/bench.ts
//
// It only teaches the resolver two things the bundler normally does: extensionless relative
// imports ("./foo" -> "./foo.ts") and the workspace package "@matterlab/core". At run time the
// engine uses nothing from @matterlab/core but physical constants (everything else it imports from
// there is types, which are erased), so the package is mapped straight to its constants module;
// that keeps this tool independent of TypeScript-only syntax elsewhere in @matterlab/core, and an
// import of anything else fails loudly with a missing-export error.

import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const coreEntry = pathToFileURL(resolvePath(here, '..', '..', 'core', 'src', 'constants.ts')).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@matterlab/core') return { url: coreEntry, shortCircuit: true };
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (relative && context.parentURL && !/\.(?:[cm]?[jt]s|json)$/.test(specifier)) {
      const base = new URL(specifier, context.parentURL).href;
      for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
        if (existsSync(fileURLToPath(candidate))) return { url: candidate, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
