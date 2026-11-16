// Polite one-page-at-a-time fetcher for the reference-data snapshots under data/sources.
//
//   node packages/reactions/tools/fetch-source.mjs --id <id> --url <https url> --file <path relative to data/sources> [--note "..."] [--force]
//   node packages/reactions/tools/fetch-source.mjs --id <id> --url <https url> --file <path relative to data/.scratch> --discard [--note "..."]
//   node packages/reactions/tools/fetch-source.mjs --probe --url <https url> --file <path relative to data/.scratch>
//
// --discard registers the download in the manifest (URL, time, size, SHA-256) but keeps the bytes only in
// the untracked scratch folder. It is for large documents of which only short excerpts are stored, see
// tools/extract-pdf-excerpts.mjs.
//
// Every saved snapshot is written byte-for-byte as received and registered in data/sources/manifest.json
// with its URL, retrieval time, HTTP metadata, size and SHA-256, so each number in the generated data
// files can be traced back to the exact bytes it was read from.
//
// If Node reports UNABLE_TO_GET_ISSUER_CERT_LOCALLY (its bundled CA list does not cover the network you
// are on), run it as `node --use-system-ca packages/reactions/tools/fetch-source.mjs ...` so the operating
// system's trust store is used. Never disable certificate verification.
//
// Access etiquette (do not loosen):
//   - one request per invocation, never in parallel;
//   - a minimum delay per host, taken from each site's robots.txt Crawl-delay where one is published
//     (checked 2026-11-13: www.codata.info 3 s, webbook.nist.gov 5 s) and 2 s otherwise;
//   - hosts whose robots.txt disallows automated access are refused outright
//     (checked 2026-11-13: kinetics.nist.gov has "User-agent: * / Disallow: /");
//   - an already registered snapshot is not fetched again unless --force is given.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '..', 'data');
const sourcesDir = join(dataDir, 'sources');
const scratchDir = join(dataDir, '.scratch');
const manifestPath = join(sourcesDir, 'manifest.json');
const statePath = join(scratchDir, 'last-request.json');

const USER_AGENT = 'MatterLab-reactions-data/0.1 (educational chemistry lab; single-page provenance snapshots; Node fetch)';
const DEFAULT_DELAY_MS = 2000;
const HOST_DELAY_MS = {
  'www.codata.info': 3000,
  'webbook.nist.gov': 5000,
};
const REFUSED_HOSTS = {
  'kinetics.nist.gov': 'robots.txt disallows all automated agents except two named search engines (checked 2026-11-13)',
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`);
    const key = a.slice(2);
    if (key === 'force' || key === 'probe' || key === 'discard') out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function insideDir(base, relative) {
  const full = resolve(base, relative);
  if (full !== base && !full.startsWith(base + sep)) throw new Error(`Refusing to write outside ${base}: ${relative}`);
  return full;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || !args.file) throw new Error('--url and --file are required');
  if (!args.probe && !args.id) throw new Error('--id is required unless --probe is given');
  const url = new URL(args.url);
  if (url.protocol !== 'https:') throw new Error('Only https sources are accepted.');
  if (REFUSED_HOSTS[url.host]) throw new Error(`Refusing to fetch from ${url.host}: ${REFUSED_HOSTS[url.host]}`);

  const manifest = await readJson(manifestPath, { description: '', sources: [] });
  if (!args.probe) {
    const existing = manifest.sources.find((s) => s.id === args.id);
    if (existing && !args.force) {
      console.log(`Already have ${args.id} (retrieved ${existing.retrievedAt}); use --force to refetch.`);
      return;
    }
  }

  await mkdir(scratchDir, { recursive: true });
  const state = await readJson(statePath, {});
  const minDelay = HOST_DELAY_MS[url.host] ?? DEFAULT_DELAY_MS;
  const last = state[url.host] ? Date.parse(state[url.host]) : 0;
  const wait = last + minDelay - Date.now();
  if (wait > 0) await sleep(wait);

  const requestedAt = new Date();
  state[url.host] = requestedAt.toISOString();
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');

  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }, redirect: 'follow' });
  const bytes = Buffer.from(await response.arrayBuffer());
  state[new URL(response.url).host] = new Date().toISOString();
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');

  const summary = `${response.status} ${response.headers.get('content-type') ?? ''} ${bytes.length} bytes`;
  if (!response.ok) {
    console.error(`FAILED ${url.href}: ${summary}`);
    process.exitCode = 1;
    return;
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const kept = !args.probe && !args.discard;
  const target = insideDir(kept ? sourcesDir : scratchDir, args.file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);

  if (!args.probe) {
    const entry = {
      id: args.id,
      url: url.href,
      ...(response.url !== url.href ? { finalUrl: response.url } : {}),
      ...(kept ? { file: args.file.replaceAll('\\', '/') } : { kept: false }),
      retrievedAt: requestedAt.toISOString(),
      httpStatus: response.status,
      contentType: response.headers.get('content-type'),
      lastModified: response.headers.get('last-modified'),
      bytes: bytes.length,
      sha256,
      ...(args.note ? { note: args.note } : {}),
    };
    manifest.description =
      'Record of every external page retrieved for the reference data in src/data/*.generated.ts: its URL, the time of retrieval, the size and SHA-256 of the response, ' +
      'and where its snapshot or excerpt is kept under this folder. Written by the scripts in packages/reactions/tools; do not edit by hand.';
    manifest.sources = manifest.sources.filter((s) => s.id !== args.id);
    manifest.sources.push(entry);
    await mkdir(sourcesDir, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  console.log(`${args.probe ? 'probe' : kept ? 'saved' : 'registered (not kept)'} ${url.href} -> ${target} (${summary}, sha256 ${sha256.slice(0, 16)}...)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
