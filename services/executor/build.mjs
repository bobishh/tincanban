import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const service = dirname(fileURLToPath(import.meta.url));
const root = resolve(service, '../..');
const output = join(service, 'dist');
const sourceSha = process.env.RELEASE_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sdkSha = process.env.RELEASE_SDK_SHA ?? execFileSync('git', ['-C', 'vendor/meta-mesh', 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
for (const value of [sourceSha, sdkSha]) if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('Executor release requires exact source and SDK revisions');

const wasm = {
  name: 'executor-wasm',
  setup(builder) {
    builder.onResolve({ filter: /\.wasm$/ }, async args => {
      if (args.pluginData?.executorWasmResolved) return;
      const resolved = await builder.resolve(args.path, {
        resolveDir: args.resolveDir, kind: args.kind, pluginData: { executorWasmResolved: true },
      });
      if (resolved.errors.length) return { errors: resolved.errors };
      return { path: resolved.path, namespace: 'executor-wasm' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'executor-wasm' }, async args => {
      const bytes = await readFile(args.path);
      const initializer = args.path.endsWith('/automerge.wasm') ? 'bytes' : 'new WebAssembly.Module(bytes)';
      return { loader: 'js', contents: `const bytes = Uint8Array.from(Buffer.from(${JSON.stringify(bytes.toString('base64'))}, "base64")); export default ${initializer};` };
    });
  },
};
const options = {
  absWorkingDir: root, bundle: true, platform: 'node', target: 'node24', format: 'esm',
  external: ['node:*'], plugins: [wasm], logLevel: 'info',
  banner: { js: 'import { createRequire as __executorCreateRequire } from "node:module"; const require = __executorCreateRequire(import.meta.url);' },
};
await mkdir(output, { recursive: true });
const runtimeFiles = ['main.mjs', 'participantWorker.mjs'].sort();
for (const filename of runtimeFiles) {
  await build({ ...options, entryPoints: [join(service, 'src', filename.replace(/\.mjs$/, '.ts'))], outfile: join(output, filename) });
}
const artifactHash = createHash('sha256');
const files = {};
for (const filename of runtimeFiles) {
  const bytes = await readFile(join(output, filename));
  files[filename] = createHash('sha256').update(bytes).digest('hex');
  artifactHash.update(`${filename}\0`).update(bytes).update('\0');
}
const artifactSha256 = artifactHash.digest('hex');
await writeFile(join(output, 'artifact.json'), JSON.stringify({ component: 'tincanban-executor', sourceSha, sdkSha, artifactSha256, files }));

async function testEntries(directory) {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? testEntries(path) : entry.name.endsWith('.test.ts') ? [path] : [];
  }))).flat();
}
const tests = await testEntries(join(service, 'test'));
if (!tests.length) throw new Error('Executor build requires its acceptance tests');
await build({ ...options, entryPoints: tests, outbase: join(service, 'test'), outdir: join(output, 'test'), outExtension: { '.js': '.mjs' } });
const compiledTests = tests.map(path => join(output, 'test', relative(join(service, 'test'), path).replace(/\.ts$/, '.mjs')));
await writeFile(join(output, 'run-tests.mjs'), `import { spawnSync } from "node:child_process";\nconst result = spawnSync(process.execPath, ["--test", ...${JSON.stringify(compiledTests.map(path => relative(output, path)))}.map(path => new URL(path, import.meta.url).pathname)], { stdio: "inherit", env: { ...process.env, EXECUTOR_WORKER_PATH: new URL("participantWorker.mjs", import.meta.url).pathname } });\nif (result.error) throw result.error;\nprocess.exit(result.status ?? 1);\n`);
