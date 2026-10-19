import { expect, it } from "vitest"
import { canonicalizeJson, sha256Base64Url, signEnvelope } from "../domain/identity"
import { compareAndSwapLocal, deleteLocal, readLocal, writeLocal } from "../localDb"
import { encodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { changeReplicaPreference, emptyPrivateReplicaState, portableReplicaState } from "./privateReplicaPreferences"
import { capturePrivateReplicaConflict, getPrivateReplicaProgress, getReplicaConfigurations, planPrivateReplicaConflictActivation,
  privateReplicaStateStorageKey, persistPrivateReplicaState, receivePrivateReplicaState, setReplicaPreference } from "./privateReplicaRepository"
import { buildReplicaCredentialConflictRecovery } from "./replicaCredentialConflictRecovery"
import { assertReplicaCredentialsUnfrozen, parseReplicaCredentialFreeze, replicaCredentialFreezeKey } from "./replicaCredentialFreeze"
import type { ReplicaCredentialConflictFreeze } from "./replicaCredentialConflictFreeze"
import { contentKeysForEpoch } from "./replicaContentKeys"
import { blindObjectId } from "./blindClient"
import { privateReplicaConflictSourceDifference, samePrivateReplicaConflictSource } from "./privateReplicaConflictSource"

const key = (byte: number) => encodeBlindBytes(new Uint8Array(32).fill(byte))
async function fixture(withOther = false) {
  const owner = crypto.randomUUID(), config = { origin: "https://rusty.example", scopeId: "scope", workspaceId: "board",
    servicePublicKey: key(7), readToken: key(8), writeToken: key(9), contentKey: key(1), keyEpoch: 1,
    policyRevision: 2, cursor: 0, lastUploaded: "" }
  await setReplicaPreference(owner, config)
  if (withOther) await setReplicaPreference(owner, { ...config, origin: "https://other-rusty.example", scopeId: "other-scope" })
  await receivePrivateReplicaState(owner, portableReplicaState(changeReplicaPreference(emptyPrivateReplicaState(owner, "remote"),
    { ...config, contentKey: key(2) })))
  const capture = await capturePrivateReplicaConflict(owner, config.origin, config.scopeId)
  const proposal = buildReplicaCredentialConflictRecovery(capture.sourceWire, { ...config, expectedPolicyRevision: 4,
    freshContentKey: key(3), freshReadToken: key(4), freshWriteToken: key(5) })
  const freeze: ReplicaCredentialConflictFreeze = { kind: "rusty-credential-conflict-freeze", version: 2, id: crypto.randomUUID(),
    personId: owner, signerDeviceId: "device", origin: config.origin, scopeId: config.scopeId, proposal }
  await writeLocal(await replicaCredentialFreezeKey(owner, config.origin), JSON.stringify(freeze))
  return { owner, config, capture, freeze, next: proposal.next }
}

it("Given concurrent credentials, when activation commits under the exact freeze, then retain both keys and require a fresh upload acknowledgment", async () => {
  const { owner, config, capture, freeze, next } = await fixture()
  const activation = await planPrivateReplicaConflictActivation(owner, capture, next, { progress: capture.progress }, freeze)
  expect(await compareAndSwapLocal(activation.plan)).toBe(true)
  await deleteLocal(await replicaCredentialFreezeKey(owner, config.origin))
  const selected = (await getReplicaConfigurations(owner))[0]!
  expect(contentKeysForEpoch(selected, 1)).toEqual([key(1), key(2)].sort())
  expect(selected).toMatchObject({ keyEpoch: 2, lastUploaded: "", policyRevision: 5 })
  expect((await getPrivateReplicaProgress(owner, selected)).pending).toBeUndefined()
})

it("Given a frozen recovery capture, when source bytes change, then reject activation and preserve both records", async () => {
  const { owner, capture, freeze, next } = await fixture(), storageKey = privateReplicaStateStorageKey(owner)
  const raw = (await readLocal(storageKey))!, changed = JSON.stringify({ ...JSON.parse(raw), actorId: "changed" })
  await writeLocal(storageKey, changed)
  await expect(planPrivateReplicaConflictActivation(owner, capture, next, { progress: capture.progress }, freeze)).rejects.toThrow(/source|changed/i)
  expect(await readLocal(storageKey)).toBe(changed)
})

it("Given an older client froze a policy-only conflict, when resuming its exact saved proposal, then activate without stranding the freeze", async () => {
  const owner = crypto.randomUUID(), config = { origin: "https://rusty.example", scopeId: "scope", workspaceId: "board",
    servicePublicKey: key(7), readToken: key(8), writeToken: key(9), contentKey: key(1), keyEpoch: 1,
    policyRevision: 1, cursor: 0, lastUploaded: "" }
  await setReplicaPreference(owner, config)
  await receivePrivateReplicaState(owner, portableReplicaState(changeReplicaPreference(emptyPrivateReplicaState(owner, "remote"),
    { ...config, policyRevision: 2, minimumWriterVersion: 2 })))
  const raw = (await readLocal(privateReplicaStateStorageKey(owner)))!
  const sourceWire = portableReplicaState(JSON.parse(raw))
  const proposal = buildReplicaCredentialConflictRecovery(sourceWire, { ...config, expectedPolicyRevision: 2,
    freshContentKey: key(3), freshReadToken: key(4), freshWriteToken: key(5) })
  const freeze: ReplicaCredentialConflictFreeze = { kind: "rusty-credential-conflict-freeze", version: 2, id: crypto.randomUUID(),
    personId: owner, signerDeviceId: "device", origin: config.origin, scopeId: config.scopeId, proposal }
  await writeLocal(await replicaCredentialFreezeKey(owner, config.origin), JSON.stringify(freeze))
  // A new action must not turn compatible policy observations into another rotation.
  await expect(capturePrivateReplicaConflict(owner, config.origin, config.scopeId)).rejects.toThrow(/conflict/i)
  const capture = await capturePrivateReplicaConflict(owner, config.origin, config.scopeId, freeze)
  const activation = await planPrivateReplicaConflictActivation(owner, capture, proposal.next, {}, freeze)
  expect(await compareAndSwapLocal(activation.plan)).toBe(true)
  await deleteLocal(await replicaCredentialFreezeKey(owner, config.origin))
  expect((await getReplicaConfigurations(owner))[0]).toMatchObject({ keyEpoch: 2, policyRevision: 3 })
})

it("Given an exact recovery proposal, when a historical key is omitted, then reject activation before writing", async () => {
  const { owner, capture, freeze, next } = await fixture(), before = await readLocal(privateReplicaStateStorageKey(owner))
  const changed = { ...next, historicalContentKeyVariants: undefined, historicalContentKeys: { "1": key(1) } }
  await expect(planPrivateReplicaConflictActivation(owner, capture, changed, { progress: capture.progress }, freeze)).rejects.toThrow(/proposal|key|changed/i)
  expect(await readLocal(privateReplicaStateStorageKey(owner))).toBe(before)
})

it("Given two causal variants, when capturing recovery twice, then preserve exact source revision and bytes without creating another queue", async () => {
  const { owner, config, capture, freeze } = await fixture()
  const savedCapture = JSON.parse(JSON.stringify(capture))
  const capturedAgain = await capturePrivateReplicaConflict(owner, config.origin, config.scopeId, freeze)
  expect(canonicalizeJson(capturedAgain)).toBe(canonicalizeJson(capture))
  expect(samePrivateReplicaConflictSource(capturedAgain, savedCapture)).toBe(true)
  expect(privateReplicaConflictSourceDifference(capturedAgain, savedCapture)).toBeUndefined()
  expect(privateReplicaConflictSourceDifference(capturedAgain, { ...savedCapture, sourceRevision: "redacted" })).toBe("sourceRevision")
  const changedActor = structuredClone(savedCapture)
  const state = JSON.parse(changedActor.sourceConditions[0].value)
  state.actorId = "different-device-actor"
  changedActor.sourceConditions[0].value = JSON.stringify(state)
  expect(privateReplicaConflictSourceDifference(capturedAgain, changedActor)).toBe("repositoryState.actorId")
  expect(samePrivateReplicaConflictSource(capturedAgain, changedActor)).toBe(false)
  expect(capture.previousVariants).toHaveLength(2)
  expect(capture.progress).toBeUndefined()
})

it("Given a strict conflict freeze, when an ordinary writer or a single-resource maintenance reader runs, then deny both without treating formats as interchangeable", async () => {
  const { owner, config, freeze } = await fixture(), before = await readLocal(privateReplicaStateStorageKey(owner))
  await expect(assertReplicaCredentialsUnfrozen(owner, config)).rejects.toThrow(/frozen|pending/i)
  await expect(setReplicaPreference(owner, config)).rejects.toThrow(/frozen|pending/i)
  expect(() => parseReplicaCredentialFreeze(JSON.stringify(freeze), owner, config.origin)).toThrow(/invalid/i)
  expect(await readLocal(privateReplicaStateStorageKey(owner))).toBe(before)
})

it("Given an orphaned original outbox, when recovering with a signed exact receipt, then retain its key and cursor without rewriting ciphertext", async () => {
  const owner = crypto.randomUUID(), service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey)), servicePublicKey = encodeBlindBytes(publicBytes)
  const config = { origin: "https://rusty.example", scopeId: "scope", workspaceId: "board", servicePublicKey,
    readToken: key(8), writeToken: key(9), contentKey: key(1), keyEpoch: 1, policyRevision: 2, cursor: 0, lastUploaded: "" }
  await setReplicaPreference(owner, config)
  const selected = (await getReplicaConfigurations(owner))[0]!, original = await getPrivateReplicaProgress(owner, selected)
  const pending = { requestId: crypto.randomUUID(), hash: key(19), bytes: 1, object: { version: 1 as const,
    scopeId: config.scopeId, keyEpoch: 1, nonce: encodeBlindBytes(new Uint8Array(12)), ciphertext: encodeBlindBytes(new Uint8Array(17)) } }
  await persistPrivateReplicaState(owner, selected, original.generation, { ...original, cursor: 17, generation: original.generation + 1,
    contentIdentity: "old-key-confirmed-content", pending })
  for (const [actor, byte] of [["remote-a", 2], ["remote-b", 3]] as const) {
    await receivePrivateReplicaState(owner, portableReplicaState(changeReplicaPreference(emptyPrivateReplicaState(owner, actor), { ...config, contentKey: key(byte) })))
  }
  // Model a maximal causal register whose original pending writer has since been superseded.
  const storageKey = privateReplicaStateStorageKey(owner), raw = JSON.parse((await readLocal(storageKey))!)
  raw.entries[0].operations = raw.entries[0].operations.filter((operation: { dot: { actorId: string } }) => operation.dot.actorId.startsWith("remote-"))
  await writeLocal(storageKey, JSON.stringify(raw))
  const capture = await capturePrivateReplicaConflict(owner, config.origin, config.scopeId)
  expect(capture.progress?.pending).toEqual(pending)
  expect(capture.progressConfig?.contentKey).toBe(key(1))
  expect(capture.previousVariants.map(value => value.contentKey)).not.toContain(key(1))
  const savedCapture = JSON.parse(JSON.stringify(capture))
  const capturedAgain = await capturePrivateReplicaConflict(owner, config.origin, config.scopeId)
  expect(samePrivateReplicaConflictSource(capturedAgain, savedCapture)).toBe(true)
  expect(privateReplicaConflictSourceDifference(capturedAgain, savedCapture)).toBeUndefined()
  const proposal = buildReplicaCredentialConflictRecovery(capture.sourceWire, { ...config, expectedPolicyRevision: 7,
    freshContentKey: key(4), freshReadToken: key(5), freshWriteToken: key(6), extraRetainedConfigs: [capture.progressConfig!] })
  const freeze: ReplicaCredentialConflictFreeze = { kind: "rusty-credential-conflict-freeze", version: 2, id: crypto.randomUUID(),
    personId: owner, signerDeviceId: "device", origin: config.origin, scopeId: config.scopeId, proposal }
  await writeLocal(await replicaCredentialFreezeKey(owner, config.origin), JSON.stringify(freeze))
  await expect(planPrivateReplicaConflictActivation(owner, capture, proposal.next, {}, freeze)).rejects.toThrow(/receipt|confirmation/i)
  const serviceId = await sha256Base64Url(publicBytes)
  const receipt = await signEnvelope(service.privateKey, { kind: "blind-storage-receipt" as const, version: 2 as const,
    serviceId, scopeId: config.scopeId, keyEpoch: 1, objectId: await blindObjectId(pending.object), sequence: 18,
    policyRevision: 8, requestId: pending.requestId }, serviceId, "RUSTY/2")
  const drained = { ...capture.progress!, generation: capture.progress!.generation + 1, lastUploaded: pending.hash }
  delete drained.pending
  const activation = await planPrivateReplicaConflictActivation(owner, capture, proposal.next, { progress: drained, receipt }, freeze)
  expect(await compareAndSwapLocal(activation.plan)).toBe(true)
  await deleteLocal(await replicaCredentialFreezeKey(owner, config.origin))
  const activated = (await getReplicaConfigurations(owner))[0]!
  expect(activated.cursor).toBe(17)
  expect(contentKeysForEpoch(activated, 1)).toEqual([key(1), key(2), key(3)].sort())
  expect((await getPrivateReplicaProgress(owner, activated)).lastUploaded).toBe("")
  expect((await getPrivateReplicaProgress(owner, activated)).contentIdentity).toBeUndefined()
})

it("Given frozen recovery and another connection, when its durable outbox advances, then resume recovery preserving that outbox under a fresh final CAS", async () => {
  const { owner, config, capture, freeze, next } = await fixture(true)
  const other = (await getReplicaConfigurations(owner)).find(value => value.origin === "https://other-rusty.example")!
  const initial = await getPrivateReplicaProgress(owner, other)
  const pending = { requestId: crypto.randomUUID(), hash: key(19), bytes: 1, object: { version: 1 as const,
    scopeId: other.scopeId, keyEpoch: 1, nonce: encodeBlindBytes(new Uint8Array(12)), ciphertext: encodeBlindBytes(new Uint8Array(17)) } }
  await persistPrivateReplicaState(owner, other, initial.generation, { ...initial, cursor: 17, generation: initial.generation + 1, pending })
  const activation = await planPrivateReplicaConflictActivation(owner, capture, next, { progress: capture.progress }, freeze)
  const first = await getPrivateReplicaProgress(owner, other)
  await persistPrivateReplicaState(owner, other, first.generation, { ...first, cursor: 18, generation: first.generation + 1 })
  expect(await compareAndSwapLocal(activation.plan)).toBe(false)
  const retried = await planPrivateReplicaConflictActivation(owner, capture, next, { progress: capture.progress }, freeze)
  expect(await compareAndSwapLocal(retried.plan)).toBe(true)
  expect(await getPrivateReplicaProgress(owner, other)).toEqual({ ...first, cursor: 18, generation: first.generation + 1 })
  expect((await getPrivateReplicaProgress(owner, other)).pending).toEqual(pending)
  expect((await readLocal(await replicaCredentialFreezeKey(owner, config.origin)))).not.toBeNull()
})

it("Given frozen recovery, when its own progress changes, then reject activation and retain changed source without overwriting it", async () => {
  const { owner, config, capture, freeze, next } = await fixture()
  const storageKey = privateReplicaStateStorageKey(owner), raw = JSON.parse((await readLocal(storageKey))!)
  raw.progress[`${config.origin}/${config.scopeId}`] = { revision: capture.previousVariants[0]!.preferenceRevision, cursor: 1, lastUploaded: "" }
  const changed = JSON.stringify(raw)
  await writeLocal(storageKey, changed)
  await expect(planPrivateReplicaConflictActivation(owner, capture, next, { progress: capture.progress }, freeze)).rejects.toThrow(/source|changed/i)
  expect(await readLocal(storageKey)).toBe(changed)
})
