import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical } from '../../scripts/release-cohort.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const safePath = (path) => typeof path === 'string' && !path.startsWith('/') && path.split('/').every((part) => part && part !== '.' && part !== '..');
export const retainedAsset = (path) => /^assets\/[\w.-]+-[\w-]{8,}\.(?:js|css|wasm)$/.test(path);
// Reserve at least half of the Workers Free 20,000-asset capacity for the current build.
const maximumRetainedChunks = 10_000;
export function retentionCandidates(previous, now = Date.now()) {
  const expiry = now + 7 * 24 * 60 * 60 * 1000;
  const entries = Object.entries({ ...previous.retained, ...previous.files });
  const candidates = entries.flatMap(([path, hash]) => {
    const until = previous.files?.[path] ? expiry : previous.retainedUntil?.[path] ?? expiry;
    return retainedAsset(path) && /^[a-f0-9]{64}$/.test(hash) && Number.isFinite(until) && until > now
      ? [[path, hash, Math.min(until, expiry)]] : [];
  });
  if (candidates.length > maximumRetainedChunks) throw new Error('Previous live chunks exceed the retention capacity');
  return candidates;
}
export async function retainPreviousAssets(previous, directory, request, { now = Date.now(), onProgress = () => {} } = {}) {
  const pending = retentionCandidates(previous, now).filter(([path]) => !existsSync(join(directory, path)));
  const retained = {};
  const retainedUntil = {};
  let next = 0;
  let completed = 0;
  let failure;
  onProgress(0, pending.length);
  const download = async ([path, hash, until]) => {
    const asset = await request(path);
    if (!asset.ok) throw new Error(`Previous chunk unavailable: ${path}`);
    const bytes = Buffer.from(await asset.arrayBuffer());
    if (digest(bytes) !== hash) throw new Error(`Previous chunk checksum mismatch: ${path}`);
    writeFileSync(join(directory, path), bytes);
    retained[path] = hash;
    retainedUntil[path] = until;
    completed++;
    if (completed % 100 === 0 || completed === pending.length) onProgress(completed, pending.length);
  };
  await Promise.all(Array.from({ length: Math.min(16, pending.length) }, async () => {
    while (!failure && next < pending.length) {
      const candidate = pending[next++];
      try { await download(candidate); }
      catch (error) { failure ??= error instanceof Error ? error : new Error(String(error)); }
    }
  }));
  if (failure) throw failure;
  return { retained, retainedUntil };
}
export function uploadedVersion(output) {
  const uploads = output.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'version-upload');
  if (uploads.length !== 1 || uploads[0].version !== 1 ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(uploads[0].version_id ?? '')) {
    throw new Error('Expected one successful Wrangler version upload');
  }
  return uploads[0].version_id;
}
export function checkRelease(manifest, sha, read) {
  if (!/^[a-f0-9]{40}$/.test(sha) || manifest.sha !== sha) throw new Error('Artifact commit mismatch');
  if (!manifest.files?.['index.html']) throw new Error('Artifact missing entry point');
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (!safePath(path) || digest(read(path)) !== hash) throw new Error(`Artifact checksum mismatch: ${path}`);
  }
}
function files(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix + entry.name;
    return entry.isDirectory() ? files(join(directory, entry.name), path + '/') : [path];
  });
}
async function get(url) {
  return fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error', cache: 'no-store' });
}
async function main() {
  const [command, sha] = process.argv.slice(2);
  if (command === 'uploaded-version') {
    console.log(uploadedVersion(readFileSync(sha, 'utf8')));
    return;
  }
  const directory = resolve(process.argv[4] ?? 'dist');
  const manifestPath = join(directory, 'release.json');
  const origin = 'https://match.meta-uber-engineer.dev';
  if (command === 'seal') {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid release commit');
    const manifest = { sha, files: Object.fromEntries(files(directory).filter((path) => path !== 'release.json').map((path) => [path, digest(readFileSync(join(directory, path)))])) };
    writeFileSync(manifestPath, JSON.stringify(manifest));
  } else if (command === 'check' || command === 'retain') {
    const manifest = JSON.parse(readFileSync(manifestPath));
    checkRelease(manifest, sha, (path) => readFileSync(join(directory, path)));
    if (command === 'check') return;
    const response = await get(`${origin}/release.json`);
    const previous = response.status === 404 ? JSON.parse(readFileSync(new URL('./bootstrap-assets.json', import.meta.url))) : await response.json();
    if (!response.ok && response.status !== 404) throw new Error('Cannot read previous release');
    const { retained, retainedUntil } = await retainPreviousAssets(previous, directory, path => get(`${origin}/${path}`), {
      onProgress: (completed, total) => console.log(`Retaining previous chunks: ${completed}/${total}`),
    });
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, retained, retainedUntil, previousSha: previous.sha ?? null, previousManifestSha256: digest(canonical(previous)) }));
    console.log(`Retained ${Object.keys(retained).length} previous chunks`);
  } else if (command === 'smoke') {
    let lastError;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        for (const path of ['/health', '/', '/pair', '/assets/ci-missing.js']) {
          const response = await get(`${origin}${path}`);
          const expected = path.includes('ci-missing') ? 404 : 200;
          if (response.status !== expected || response.headers.get('x-frontend-release') !== sha) throw new Error(`Release not ready at ${path}`);
          if (path === '/' || path === '/pair') {
            if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('Missing HTML');
            const html = await response.text();
            const asset = html.match(/src="(\/assets\/[^" ]+\.js)"/);
            if (!asset || !(await get(`${origin}${asset[1]}`)).ok) throw new Error('Entry chunk unavailable');
          } else await response.arrayBuffer();
        }
        console.log(`Production serves ${sha}`);
        return;
      } catch (error) { lastError = error; }
      await new Promise((done) => setTimeout(done, 5000));
    }
    throw lastError;
  } else throw new Error('Use seal, check, retain, smoke, or uploaded-version');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
