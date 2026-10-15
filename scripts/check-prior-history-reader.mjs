import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';

const priorRelease = { app: '07242d4880821829026234ca1a3cb6bd07ee29fe',
  sdk: '111943361d2c765557da00bbc568596ff1a5d047', deploymentRun: '38545039241' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function committed(root, revision, path) {
  return execFileSync('git', ['-C', root, 'show', `${revision}:${path}`], { maxBuffer: 32 * 1024 * 1024 });
}
function compile(source) {
  return ts.transpileModule(source.toString(), { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022 } }).outputText;
}

/** Exact released policy and receive code; only transport/persistence ports belong to this probe. */
async function checkPriorHistoryReader(input, workspace = process.cwd()) {
  const sdk = join(workspace, 'vendor/meta-mesh');
  const js = committed(sdk, priorRelease.sdk, 'packages/mesh-transport/wasm/policy/meta_mesh_policy.js');
  const wasm = committed(sdk, priorRelease.sdk, 'packages/mesh-transport/wasm/policy/meta_mesh_policy_bg.wasm');
  const replicaSource = committed(workspace, priorRelease.app, 'src/sync/blindReplication.ts');
  const directory = await mkdtemp(join(tmpdir(), 'tincanban-prior-reader-'));
  try {
    await writeFile(join(directory, 'policy.mjs'), js);
    const policy = await import(pathToFileURL(join(directory, 'policy.mjs')).href);
    policy.initSync({ module: wasm });
    assert.equal(typeof policy.WasmStateCore.verifyOwnerAttestedHistoryBaseline, 'undefined');
    const originals = input.originals;
    const decode = text => new Uint8Array(Buffer.from(text, 'base64url'));
    const control = JSON.parse(Buffer.from(originals.control, 'base64url').toString());
    const originalBytes = decode(originals.document);
    const before = digest(originalBytes);
    const result = policy.WasmStateCore.evaluateCausalAdmission({ records: originals.authorizations.map(value =>
      JSON.parse(Buffer.from(value, 'base64url').toString())), snapshot: { ...control, document: Array.from(originalBytes) },
      pendingChangeBytes: originals.pending.map(value => Array.from(decode(value))), nowMs: 0 });
    assert.ok(result.decisions.some(decision => decision.hash === input.admittedHash && decision.status.type === 'admitted'));
    assert.equal(digest(originalBytes), before);
    // Preserve the exact released AES codec and object client. Only module routing changes for Node ESM.
    for (const name of ['blindOrigin', 'blindEnvelope', 'blindClient']) {
      const raw = committed(workspace, priorRelease.app, `src/sync/${name}.ts`);
      const compiled = compile(raw).replaceAll('"./blindOrigin"', '"./blindOrigin.mjs"')
        .replaceAll('"./blindEnvelope"', '"./blindEnvelope.mjs"');
      await writeFile(join(directory, `${name}.mjs`), compiled);
    }
    await writeFile(join(directory, 'identity.mjs'), 'export { canonicalBlindJson as canonicalizeJson } from "./blindClient.mjs";\n');
    await writeFile(join(directory, 'replica.mjs'), compile(replicaSource).replaceAll('"./blindClient"', '"./blindClient.mjs"')
      .replaceAll('"./blindEnvelope"', '"./blindEnvelope.mjs"').replaceAll('"../domain/identity"', '"./identity.mjs"'));
    const { BlindReplica } = await import(pathToFileURL(join(directory, 'replica.mjs')).href);
    const envelope = await import(pathToFileURL(join(directory, 'blindEnvelope.mjs')).href);
    const key = crypto.getRandomValues(new Uint8Array(32));
    const config = { origin: 'http://127.0.0.1:1', scopeId: 'prior-reader-scope', workspaceId: control.workspaceId,
      keyEpoch: 1, contentKey: envelope.encodeBlindBytes(key), cursor: 0, lastUploaded: '', policyRevision: 1,
      servicePublicKey: 'A'.repeat(43), readToken: 'read', writeToken: 'write' };
    const signed = JSON.parse(input.signedBaseline);
    assert.equal(signed.payload.workspaceId, control.workspaceId);
    assert.equal(signed.payload.kind, 'workspace-history-baseline');
    const snapshot = { version: 2, workspaceId: control.workspaceId, document: input.compactDocument,
      authorization: { version: 1, records: [] }, chat: null, history: { version: 1, signedJson: Buffer.from(input.signedBaseline).toString('base64url') } };
    const object = await envelope.encryptBlindObject(config.scopeId, 1, key, new TextEncoder().encode(JSON.stringify(snapshot)));
    const calls = [];
    const replica = new BlindReplica(config, { merge: async () => calls.push('merge'), mergeChat: async () => calls.push('chat'),
      persist: async () => calls.push('persist'), read: async () => originalBytes.slice(), authorization: async () => ({}), readChat: async () => null }, {
      inventory: async () => ({ objects: [{ objectId: 'fixture-object', sequence: 1 }], cursor: 1, hasMore: false }),
      download: async () => structuredClone(object), upload: async () => { calls.push('upload'); throw new Error('Unexpected upload'); },
    });
    await assert.rejects(replica.pull(), /Encrypted snapshot does not match this workspace/);
    assert.deepEqual(calls, []);
    assert.equal(config.cursor, 0);
    assert.equal(digest(originalBytes), before);
    return { priorRelease, artifacts: { policyJsSha256: digest(js), policyWasmSha256: digest(wasm), replicaSourceSha256: digest(replicaSource) },
      nativeHistoryAPI: 'absent', originalHistory: 'admitted-and-retained', version2Receive: 'rejected-before-merge-and-cursor' };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  console.log(JSON.stringify(await checkPriorHistoryReader(input)));
}
