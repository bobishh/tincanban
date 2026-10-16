import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertCompatibleRollback, canonical, readArtifactFiles, sealArtifact, verifyArtifact } from './release-cohort.mjs';
import { checkRelease, retainedAsset, retentionCandidates } from '../workers/frontend/release.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const load = path => JSON.parse(readFileSync(path, 'utf8'));

export function frontendReleaseMetadata(artifact) {
  if (artifact.component !== 'frontend' || !digest(artifact.artifactSha256) || !sha(artifact.sourceSha)) throw new Error('Invalid frontend artifact');
  const body = { kind: 'tincanban-release-cohort', version: 1, components: { frontend: {
    component: 'frontend', sourceSha: artifact.sourceSha, candidateId: artifact.candidateId,
    artifactSha256: artifact.artifactSha256, readers: artifact.readers, writerVersion: artifact.writerVersion,
  } }, contract: { minimumWriterVersion: artifact.writerVersion, readers: { frontend: artifact.readers } } };
  return { ...body, cohortId: hash(canonical(body)) };
}

export function prepareComponent(component, artifactDirectory, outputDirectory, expectedSha, runId, attempt) {
  if (!['frontend', 'automation'].includes(component) || !sha(expectedSha) ||
      !/^\d+$/.test(String(runId)) || !/^\d+$/.test(String(attempt))) throw new Error('Invalid component release selection');
  const artifact = load(join(artifactDirectory, 'artifact.json'));
  verifyArtifact(artifact, readArtifactFiles(artifactDirectory));
  if (artifact.component !== component || artifact.sourceSha !== expectedSha || artifact.candidateId !== `${runId}-${attempt}`) {
    throw new Error('Artifact does not belong to the exact successful Verify run');
  }
  assertCompatibleRollback(artifact, artifact.readers);
  const config = load(join(artifactDirectory, 'wrangler.json'));
  const artifactBase = relative(resolve(outputDirectory), resolve(artifactDirectory)).split(sep).join('/') || '.';
  config.main = posix.join(artifactBase, config.main);
  if (config.assets) config.assets.directory = posix.join(artifactBase, config.assets.directory);
  if (config.base_dir) config.base_dir = posix.join(artifactBase, config.base_dir);
  const cohortId = component === 'frontend' ? frontendReleaseMetadata(artifact).cohortId : artifact.artifactSha256;
  config.vars = { ...config.vars, RELEASE_SHA: artifact.sourceSha, RELEASE_SDK_SHA: artifact.sdkSha, RELEASE_COHORT_ID: cohortId,
    RELEASE_ARTIFACT_SHA256: artifact.artifactSha256, RELEASE_READERS_JSON: JSON.stringify(artifact.readers),
    RELEASE_WRITER_VERSION: String(artifact.writerVersion) };
  if (component === 'frontend') config.vars.RELEASE_COHORT_JSON = JSON.stringify(frontendReleaseMetadata(artifact));
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, 'wrangler.json'), JSON.stringify(config));
  writeFileSync(join(outputDirectory, 'expected.json'), JSON.stringify({ component, artifact, cohortId }));
  return { component, artifact, cohortId };
}

export async function assertActiveCompatibility(component, artifact, fetcher = fetch) {
  const origin = component === 'automation' ? 'https://automation.meta-uber-engineer.dev' : releaseOrigin;
  const path = component === 'frontend' ? '/release-cohort.json' : '/health';
  const response = await fetcher(`${origin}${path}`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return;
  if (!response.ok) throw new Error(`Cannot establish current ${component} reader floors (${response.status})`);
  const current = await response.json();
  const floors = component === 'frontend' ? current.contract?.readers?.frontend : current.readers;
  const writerFloor = component === 'frontend' ? current.contract?.minimumWriterVersion : current.writerVersion;
  if (!floors || !Number.isSafeInteger(writerFloor) || writerFloor < 1) throw new Error(`Current ${component} release has no valid compatibility floors`);
  assertCompatibleRollback(artifact, floors);
  if (artifact.writerVersion < writerFloor) throw new Error(`Incompatible ${component} writer rollback`);
}

export function composeFrontendRollback(targetDirectory, currentDirectory, outputDirectory, now = Date.now()) {
  const targetArtifact = load(join(targetDirectory, 'artifact.json'));
  const targetFiles = readArtifactFiles(targetDirectory);
  const currentArtifact = load(join(currentDirectory, 'artifact.json'));
  const currentFiles = readArtifactFiles(currentDirectory);
  verifyArtifact(targetArtifact, targetFiles); verifyArtifact(currentArtifact, currentFiles);
  if (targetArtifact.component !== 'frontend' || currentArtifact.component !== 'frontend') throw new Error('Frontend rollback needs two sealed frontend artifacts');
  const files = { ...targetFiles };
  const previous = JSON.parse(currentFiles['assets/release.json']);
  const manifest = JSON.parse(targetFiles['assets/release.json']);
  checkRelease(previous, currentArtifact.sourceSha, path => currentFiles[`assets/${path}`]);
  checkRelease(manifest, targetArtifact.sourceSha, path => targetFiles[`assets/${path}`]);
  const retained = {}, retainedUntil = {};
  for (const [source, sourceFiles] of [[manifest, targetFiles], [previous, currentFiles]]) {
    for (const [path, checksum, until] of retentionCandidates(source, now)) {
      const key = `assets/${path}`;
      const bytes = sourceFiles[key];
      if (!bytes || hash(bytes) !== checksum) throw new Error(`Rollback chunk missing or changed: ${path}`);
      if (files[key] && hash(files[key]) !== checksum) throw new Error(`Rollback chunk path collision: ${path}`);
      if (manifest.files[path]) continue;
      files[key] = bytes;
      retained[path] = checksum;
      retainedUntil[path] = Math.min(retainedUntil[path] ?? until, until);
    }
  }
  for (const path of Object.keys(files)) {
    const assetPath = path.startsWith('assets/') ? path.slice(7) : '';
    if (retainedAsset(assetPath) && !manifest.files[assetPath] && !retained[assetPath]) delete files[path];
  }
  files['assets/release.json'] = Buffer.from(JSON.stringify({ ...manifest, retained, retainedUntil, previousSha: currentArtifact.sourceSha }));
  const { files: ignoredFiles, artifactSha256: ignoredHash, kind: ignoredKind, version: ignoredVersion, ...identity } = targetArtifact;
  const artifact = sealArtifact({ ...identity, derivedFrom: [targetArtifact.artifactSha256, currentArtifact.artifactSha256] }, files);
  mkdirSync(outputDirectory, { recursive: true });
  for (const [path, bytes] of Object.entries(files)) {
    const target = join(outputDirectory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  writeFileSync(join(outputDirectory, 'artifact.json'), JSON.stringify(artifact));
  return artifact;
}

const releaseOrigin = 'https://match.meta-uber-engineer.dev';
const canonicalHtmlPaths = new Set(['/', '/index.html', '/agent', '/agent/', '/agent/index.html']);
const htmlRedirectTargets = new Map([['/index.html', new Set(['/'])], ['/agent/index.html', new Set(['/agent', '/agent/'])]]);
export async function readVerifiedReleaseAsset(path, checksum, fetcher = fetch) {
  if (!['index.html', 'agent/index.html'].includes(path) &&
      (!path.startsWith('assets/') || path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')))) throw new Error(`Unexpected deployed frontend asset path: ${path}`);
  const initial = new URL(`/${path}`, releaseOrigin);
  let url = initial; const visited = new Set(); let response;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
    if (visited.has(url.href)) throw new Error(`Repeated deployed asset redirect: ${path}`);
    visited.add(url.href);
    response = await fetcher(url, { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(30000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers?.get?.('location');
    const allowed = htmlRedirectTargets.get(initial.pathname);
    if (!location || !allowed) throw new Error(`Unexpected deployed asset redirect: ${path}`);
    const target = new URL(location, url);
    if (target.origin !== releaseOrigin || target.username || target.password || target.search || target.hash ||
        !canonicalHtmlPaths.has(target.pathname) || !allowed.has(target.pathname)) throw new Error(`Non-canonical deployed HTML redirect: ${path}`);
    url = target;
    if (redirectCount === 3) throw new Error(`Too many deployed asset redirects: ${path}`);
  }
  if (!response?.ok) throw new Error(`Deployed asset unavailable: ${path} (${response?.status ?? 'no response'})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== checksum) throw new Error(`Deployed frontend bytes differ: ${path}`);
  return bytes;
}

async function verifyOnce(expectedPath, versionId, fetcher) {
  const { component, artifact, cohortId } = load(expectedPath);
  const origin = component === 'automation' ? 'https://automation.meta-uber-engineer.dev' : releaseOrigin;
  const healthResponse = await fetcher(`${origin}/health`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!healthResponse.ok) throw new Error(`Deployed ${component} health unavailable (${healthResponse.status})`);
  const health = await healthResponse.json();
  if (!['ready', 'ok'].includes(health.status) || health.buildSha !== artifact.sourceSha || health.sdkSha !== artifact.sdkSha ||
      health.artifactSha256 !== artifact.artifactSha256 || health.cohortId !== cohortId ||
      (versionId && health.versionId !== versionId) || health.writerVersion !== artifact.writerVersion ||
      canonical(health.readers) !== canonical(artifact.readers)) throw new Error(`Deployed ${component} differs from selected sealed artifact`);
  assertCompatibleRollback({ readers: health.readers }, artifact.readers);
  if (component === 'frontend') {
    const metadataResponse = await fetcher(`${origin}/release-cohort.json`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!metadataResponse.ok) throw new Error('Frontend release compatibility metadata unavailable');
    const metadata = await metadataResponse.json();
    if (canonical(metadata) !== canonical({ ...frontendReleaseMetadata(artifact), frontendVersionId: health.versionId ?? null })) throw new Error('Frontend release metadata differs from selected artifact');
    const frontendAssets = resolve(dirname(expectedPath), '../../frontend/assets');
    const manifest = JSON.parse(readFileSync(join(frontendAssets, 'release.json'), 'utf8'));
    checkRelease(manifest, artifact.sourceSha, path => readFileSync(join(frontendAssets, path)));
    for (const [path, checksum] of Object.entries(manifest.files)) {
      if (path.startsWith('assets/') || path === 'index.html' || path === 'agent/index.html') await readVerifiedReleaseAsset(path, checksum, fetcher);
    }
    for (const [path, checksum] of Object.entries(artifact.files)) {
      if (path === 'index.html' || path === 'agent/index.html') await readVerifiedReleaseAsset(path, checksum, fetcher);
    }
  }
  return health;
}

async function verifyComponent(expectedPath, versionId, fetcher = fetch, attempts = 12) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await verifyOnce(expectedPath, versionId, fetcher); }
    catch (error) { lastError = error; }
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw lastError;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare') prepareComponent(args[0], resolve(args[1]), resolve(args[2]), args[3], args[4], args[5]);
  else if (command === 'compatibility') {
    const artifact = load(join(resolve(args[1]), 'artifact.json'));
    await assertActiveCompatibility(args[0], artifact);
  }
  else if (command === 'compose-frontend-rollback') composeFrontendRollback(resolve(args[0]), resolve(args[1]), resolve(args[2]));
  else if (command === 'verify') await verifyComponent(resolve(args[0]), args[1]);
  else throw new Error('Use prepare <component> <artifact-dir> <output-dir> <sha> <run-id> <attempt>, compatibility <component> <artifact-dir>, compose-frontend-rollback <target-dir> <current-dir> <output-dir>, or verify <expected.json> [version-id]');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
