import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { sealArtifact, readArtifactFiles } from './release-cohort.mjs';

const [component, directory] = process.argv.slice(2);
if (!['frontend', 'automation'].includes(component) || !directory) throw new Error('Use frontend|automation and an empty destination directory');
const destination = resolve(directory);
if (existsSync(destination)) throw new Error('Refuse to replace an existing captured artifact');
mkdirSync(destination, { recursive: true });
const supported = JSON.parse(readFileSync('release/readers.json', 'utf8'));
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sdkSha = execFileSync('git', ['-C', 'vendor/meta-mesh', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const candidateId = process.env.RELEASE_CANDIDATE_ID;
let config;
if (component === 'frontend') {
  cpSync('dist', join(destination, 'assets'), { recursive: true });
  cpSync('workers/frontend/frontend.mjs', join(destination, 'frontend.mjs'));
  config = JSON.parse(readFileSync('workers/frontend/wrangler.jsonc', 'utf8'));
  config.main = 'frontend.mjs'; config.no_bundle = true;
  config.find_additional_modules = false;
  config.assets.directory = './assets';
} else {
  cpSync('workers/automation/.artifact', join(destination, 'bundle'), { recursive: true });
  if (!existsSync(join(destination, 'bundle/index.js'))) throw new Error('Wrangler did not capture the expected immutable entry point');
  config = JSON.parse(readFileSync('workers/automation/wrangler.jsonc', 'utf8'));
  config.main = 'bundle/index.js'; config.no_bundle = true;
  config.base_dir = 'bundle'; config.find_additional_modules = true;
}
delete config.$schema;
writeFileSync(join(destination, 'wrangler.json'), JSON.stringify(config));
const identity = { component, sourceSha, sdkSha, candidateId, readers: supported[component], writerVersion: supported.writerVersions[component] };
writeFileSync(join(destination, 'artifact.json'), JSON.stringify(sealArtifact(identity, readArtifactFiles(destination))));
