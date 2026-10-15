import { WasmStateCore, type WasmVerifiedReceivedHistoryBaseline } from '@meta-uber/mesh-transport/wasm';
import { decodeBlindBytes, encodeBlindBytes } from '../../../src/sync/blindEnvelope';
import type { BlindReplicaConfig } from '../../../src/sync/blindReplication';
import { contentKeysForEpoch, openWithReplicaContentKeys } from '../../../src/sync/replicaContentKeys';
import { parseWireHistoryBaseline, reverifyStoredHistoryBaseline, verifyReceivedWireHistoryBaseline, type HistoryBaselineFetchPort, type WireHistoryBaseline } from '../../../src/sync/historyBaselineReceiver';
import type { EncryptedArchiveObject } from '@meta-uber/mesh-replication/history-archive-crypto';
import type { ArchiveCoverageAuthority } from '@meta-uber/mesh-replication/history-archive-coverage';

const maximumEvidenceBytes = 24 * 1024 * 1024;
export type StoredWorkerHistoryBasis = {
  version: 1;
  wire: WireHistoryBaseline;
  document: string;
  encryptedObjects: Array<{ ciphertextId: string; object: EncryptedArchiveObject }>;
};
export function inspectWorkerHistoryRouting(input: unknown, workspaceId: string, configInput: BlindReplicaConfig) {
  const wire = parseWireHistoryBaseline(input), config = structuredClone(configInput);
  const signed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBlindBytes(wire.signedJson))) as {
    payload?: { workspaceId?: unknown; storage?: { keyEpoch?: unknown; authority?: ArchiveCoverageAuthority } }
  };
  const payload = signed.payload, keyEpoch = payload?.storage?.keyEpoch, authority = payload?.storage?.authority;
  if (payload?.workspaceId !== workspaceId || wire.basis.context.workspaceId !== workspaceId || !Number.isSafeInteger(keyEpoch) || (keyEpoch as number) < 1 ||
    !authority || authority.scopeId !== config.scopeId || authority.servicePublicKey !== config.servicePublicKey ||
    !Number.isSafeInteger(authority.policyRevision) || authority.policyRevision < 1 || authority.policyRevision > config.policyRevision) throw new Error('Worker history routing differs from pinned workspace storage');
  contentKeysForEpoch(config, keyEpoch as number);
  return { wire, keyEpoch: keyEpoch as number, pinnedStorage: structuredClone(authority) };
}
/** A baseline envelope cannot install its own trust anchor. Only previously admitted scope authority may enter here. */
export function validateWorkerHistoryAuthority(snapshot: unknown, workspaceId: string, owner?: { personId: string; publicKey: string }): unknown {
  if (!snapshot) throw new Error('Worker history requires an admitted signed scope authority');
  const captured = structuredClone(snapshot);
  const authority = WasmStateCore.validateScopeAuthority(captured, Date.now()) as { scopeId: string; controller: { personId: string; publicKey: string } };
  if (authority.scopeId !== workspaceId || owner && (authority.controller.personId !== owner.personId || authority.controller.publicKey !== owner.publicKey)) throw new Error('Worker history scope authority differs from admitted Owner');
  return captured;
}
export function captureWorkerHistoryBasis(wireInput: WireHistoryBaseline, basis: WasmVerifiedReceivedHistoryBaseline): StoredWorkerHistoryBasis {
  const wire = parseWireHistoryBaseline(wireInput), document = basis.document(), objects = basis.encryptedObjects();
  if (encodeBlindBytes(basis.originalJson()) !== wire.signedJson || !(objects instanceof Map) || objects.size > 8192) throw new Error('Verified Worker history does not match its received descriptor');
  const stored: StoredWorkerHistoryBasis = { version: 1, wire, document: encodeBlindBytes(document),
    encryptedObjects: [...objects].map(([ciphertextId, object]) => ({ ciphertextId, object: structuredClone(object) })) };
  if (new TextEncoder().encode(JSON.stringify(stored)).byteLength > maximumEvidenceBytes) throw new Error('Worker history receive evidence exceeds durable storage bound');
  return stored;
}
export async function receiveWorkerHistoryBasis(input: { wire: unknown; workspaceId: string; config: BlindReplicaConfig;
  trustedScopeAuthority: unknown; previous?: WasmVerifiedReceivedHistoryBaseline; fetch: HistoryBaselineFetchPort;
  guard: () => void | Promise<void>; ensureCurrent: () => void }): Promise<{ stored: StoredWorkerHistoryBasis; basis: WasmVerifiedReceivedHistoryBaseline }> {
  const { wire, keyEpoch, pinnedStorage } = inspectWorkerHistoryRouting(input.wire, input.workspaceId, input.config);
  const scopeAuthority = structuredClone(input.trustedScopeAuthority), config = structuredClone(input.config), guard = input.guard, ensureCurrent = input.ensureCurrent;
  if (!scopeAuthority) throw new Error('Worker history requires its stored admitted scope authority');
  await guard();
  const basis = await openWithReplicaContentKeys(config, keyEpoch, contentKey => verifyReceivedWireHistoryBaseline({ wire,
    scope: { scopeId: config.scopeId, keyEpoch, key: decodeBlindBytes(contentKey) }, pinnedStorage,
    trustedScopeAuthority: scopeAuthority, previous: input.previous, fetch: input.fetch, ensureCurrent }));
  try { await guard(); return { stored: captureWorkerHistoryBasis(wire, basis), basis }; }
  catch (error) { basis.free(); throw error; }
}
/** Recreate Native verification from original private bytes; serialized booleans and cached Owner fields grant no authority. */
export async function restoreWorkerHistoryBasis(storedInput: StoredWorkerHistoryBasis, workspaceId: string,
  configInput: BlindReplicaConfig, trustedScopeAuthority: unknown, guard: () => void | Promise<void>, ensureCurrent: () => void): Promise<WasmVerifiedReceivedHistoryBaseline> {
  const stored = structuredClone(storedInput), config = structuredClone(configInput), scopeAuthority = structuredClone(trustedScopeAuthority);
  if (!stored || stored.version !== 1 || Object.keys(stored).some(key => !['version', 'wire', 'document', 'encryptedObjects'].includes(key)) ||
    !Array.isArray(stored.encryptedObjects) || !stored.encryptedObjects.length || stored.encryptedObjects.length > 8192 ||
    new TextEncoder().encode(JSON.stringify(stored)).byteLength > maximumEvidenceBytes) throw new Error('Invalid Worker history evidence');
  const { wire, keyEpoch, pinnedStorage } = inspectWorkerHistoryRouting(stored.wire, workspaceId, config);
  const objects = new Map<string, EncryptedArchiveObject>();
  for (const entry of stored.encryptedObjects) {
    if (!entry || typeof entry.ciphertextId !== 'string' || objects.has(entry.ciphertextId)) throw new Error('Duplicate or invalid Worker history archive evidence');
    objects.set(entry.ciphertextId, entry.object);
  }
  await guard();
  const basis = await openWithReplicaContentKeys(config, keyEpoch, contentKey => reverifyStoredHistoryBaseline({
    stored: { id: config.scopeId, stageId: config.scopeId, workspaceId, state: 'active',
      signedJson: decodeBlindBytes(wire.signedJson), document: decodeBlindBytes(stored.document), wire,
      encryptedObjects: [...objects].map(([ciphertextId, object]) => ({ ciphertextId, object })),
      scopeId: config.scopeId, keyEpoch, pinnedStorage: { ...pinnedStorage }, expectedSnapshot: null,
      createdAt: '1970-01-01T00:00:00.000Z' },
    scope: { scopeId: config.scopeId, keyEpoch, key: decodeBlindBytes(contentKey) },
    trustedScopeAuthority: scopeAuthority, ensureCurrent,
  }));
  try { await guard(); return basis; } catch (error) { basis.free(); throw error; }
}

/** A warm root switch cannot erase a local branch. Prove its frontier is retained by the signed archive catalogue first. */
export async function assertWorkerHistoryCoversHeads(basis: WasmVerifiedReceivedHistoryBaseline, headsInput: readonly string[],
  config: BlindReplicaConfig, fetch: HistoryBaselineFetchPort, guard: () => void | Promise<void>): Promise<void> {
  const heads = [...headsInput];
  if (heads.length > 256 || heads.some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw new Error('Worker history frontier exceeds bounded transition limits');
  const payload = basis.envelope().payload as { archive: { context: import('@meta-uber/mesh-replication/history-archive').ArchiveTreeContext;
    root: import('@meta-uber/mesh-replication/history-archive').ArchiveIndexRoot }; locatorRoot: import('@meta-uber/mesh-replication/history-archive-locators').ArchiveLocatorRoot;
    storage: { keyEpoch: number } };
  const { readArchiveIndex } = await import('@meta-uber/mesh-replication/history-archive');
  const { createLocatedArchiveStore } = await import('@meta-uber/mesh-replication/history-archive-locators');
  await guard();
  await openWithReplicaContentKeys(config, payload.storage.keyEpoch, async key => {
    const store = createLocatedArchiveStore({ scopeId: config.scopeId, keyEpoch: payload.storage.keyEpoch, key: decodeBlindBytes(key) }, payload.locatorRoot, fetch);
    for (const head of heads) {
      await guard();
      const target = `change/${head}`;
      const page = await readArchiveIndex(payload.archive.context, payload.archive.root, store, { prefix: target, limit: 2 });
      if (!page.entries.some(entry => entry.key === target)) throw new Error('Owner baseline does not retain this Worker branch; drain and publish a covering baseline first');
    }
  });
  await guard();
}
