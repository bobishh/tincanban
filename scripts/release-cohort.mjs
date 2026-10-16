import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fullSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safePath = path => typeof path === 'string' && !path.startsWith('/') && !path.includes('\0') && path.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes('\\'));
export const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
function assertReaders(readers) {
  if (!readers || typeof readers !== 'object' || Array.isArray(readers) || !Object.keys(readers).length ||
    Object.values(readers).some(version => !Number.isSafeInteger(version) || version < 1)) throw new Error('Invalid schema readers');
}
export function sealArtifact(identity, files) {
  if (!['frontend', 'automation'].includes(identity.component) || !fullSha(identity.sourceSha) || !fullSha(identity.sdkSha) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(identity.candidateId ?? '') || !Number.isSafeInteger(identity.writerVersion) || identity.writerVersion < 1) throw new Error('Invalid artifact identity');
  assertReaders(identity.readers);
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length || entries.length > 20000 || entries.some(([path]) => !safePath(path))) throw new Error('Invalid artifact file set');
  const body = { kind: 'tincanban-component-artifact', version: 1, ...identity,
    files: Object.fromEntries(entries.map(([path, bytes]) => [path, hash(bytes)])) };
  return { ...body, artifactSha256: hash(canonical(body)) };
}
export function verifyArtifact(artifact, files) {
  const { artifactSha256, ...body } = artifact;
  if (body.kind !== 'tincanban-component-artifact' || body.version !== 1 || !digest(artifactSha256) || hash(canonical(body)) !== artifactSha256) throw new Error('Invalid artifact seal');
  if (canonical(Object.keys(files).sort()) !== canonical(Object.keys(body.files).sort())) throw new Error('Artifact file set differs from checked bundle');
  for (const [path, checksum] of Object.entries(body.files)) if (!safePath(path) || !digest(checksum) || hash(files[path]) !== checksum) throw new Error(`Artifact checksum mismatch: ${path}`);
  return artifact;
}
export function assertCompatibleRollback(reader, retainedSchemas) {
  assertReaders(reader.readers); assertReaders(retainedSchemas);
  for (const [schema, minimum] of Object.entries(retainedSchemas)) if ((Object.hasOwn(reader.readers, schema) ? reader.readers[schema] : 0) < minimum) throw new Error(`Incompatible rollback reader: ${schema}`);
}
export function readArtifactFiles(directory) {
  const files = {};
  const walk = (base, prefix = '') => {
    for (const name of readdirSync(base)) {
      const path = join(base, name); const relative = prefix + name;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error('Artifact symlinks are not permitted');
      if (info.isDirectory()) walk(path, `${relative}/`);
      else if (info.isFile() && relative !== 'artifact.json') files[relative] = readFileSync(path);
      else if (!info.isFile()) throw new Error('Unsupported artifact entry');
    }
  };
  walk(directory); return files;
}
async function main() {
  const [command, directory, identityPath] = process.argv.slice(2);
  if (command === 'seal') {
    const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
    writeFileSync(join(directory, 'artifact.json'), JSON.stringify(sealArtifact(identity, readArtifactFiles(directory))));
  } else if (command === 'check') verifyArtifact(JSON.parse(readFileSync(join(directory, 'artifact.json'), 'utf8')), readArtifactFiles(directory));
  else throw new Error('Use seal or check');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
