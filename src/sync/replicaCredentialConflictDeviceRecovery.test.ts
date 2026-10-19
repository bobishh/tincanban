import { beforeEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import type * as SigningModule from "../domain/signingContext"
import type * as BlindModule from "./blindClient"
import type * as EnrollmentModule from "./rustyEnrollment"
import type * as EnrollmentJournalModule from "./rustyEnrollmentJournal"
import { readLocal, writeLocal } from "../localDb"
import { encodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { changeReplicaPreference, emptyPrivateReplicaState, portableReplicaState } from "./privateReplicaPreferences"
import { capturePrivateReplicaConflict, getReplicaConfigurations, persistPrivateReplicaProgress,
  privateReplicaBinding, receivePrivateReplicaState, setReplicaPreference } from "./privateReplicaRepository"
import { replicaCredentialFreezeKey } from "./replicaCredentialFreeze"
import { buildReplicaCredentialConflictRecovery } from "./replicaCredentialConflictRecovery"
import { recoverRustyCredentialConflict } from "./replicaCredentialConflictWorkflow"
import { contentKeysForEpoch } from "./replicaContentKeys"

const network = vi.hoisted(() => ({ verifyPolicy: vi.fn(), completeIntent: vi.fn(), snapshot: vi.fn() }))
vi.mock("./workspaceOwnerSigning", () => ({ workspaceOwnerSigningContext: vi.fn(async () => ({})) }))
vi.mock("../domain/signingContext", async importOriginal => ({
  ...await importOriginal<typeof SigningModule>(), assertSigningContextCurrent: vi.fn(),
}))
vi.mock("./blindClient", async importOriginal => ({
  ...await importOriginal<typeof BlindModule>(),
  discoverBlindKeeper: vi.fn(async () => ({ servicePublicKey: encodeBlindBytes(new Uint8Array(32).fill(7)),
    scopeManagement: 1, scopeEnrollmentRetry: 1, writerPolicy: { maximumWriterVersion: 2 } })),
}))
vi.mock("./rustyEnrollment", async importOriginal => ({
  ...await importOriginal<typeof EnrollmentModule>(),
  verifySavedScopeEnrollmentConfirmation: network.verifyPolicy,
}))
vi.mock("./rustyEnrollmentJournal", async importOriginal => ({
  ...await importOriginal<typeof EnrollmentJournalModule>(), completeScopeEnrollmentIntent: network.completeIntent,
}))
vi.mock("./blindReplicaStore", () => ({ createBlindReplica: (...args: unknown[]) => ({
  flushCurrentSnapshot: () => network.snapshot(...args),
}) }))

const key = (value: number) => encodeBlindBytes(new Uint8Array(32).fill(value))
beforeEach(() => {
  resetIdentityStorageForTest()
  network.verifyPolicy.mockReset().mockResolvedValue(undefined)
  network.completeIntent.mockReset().mockResolvedValue(undefined)
  network.snapshot.mockReset()
})

async function fixture() {
  const profile = await bootstrapIdentity("Recovery owner"), owner = profile.identity.personId
  const config = { origin: "https://rusty.example", scopeId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), servicePublicKey: key(7),
    readToken: key(8), writeToken: key(9), contentKey: key(1), keyEpoch: 1, policyRevision: 2, cursor: 0, lastUploaded: "" }
  await writeLocal("tincanban.local_profile.v1", JSON.stringify(profile))
  await setReplicaPreference(owner, config)
  await receivePrivateReplicaState(owner, portableReplicaState(changeReplicaPreference(emptyPrivateReplicaState(owner, "peer"),
    { ...config, contentKey: key(2) })))
  const capture = await capturePrivateReplicaConflict(owner, config.origin, config.scopeId)
  const proposal = buildReplicaCredentialConflictRecovery(capture.sourceWire, { ...config, expectedPolicyRevision: 4,
    freshContentKey: key(3), freshReadToken: key(4), freshWriteToken: key(5) })
  const freeze = { kind: "rusty-credential-conflict-freeze", version: 2, id: crypto.randomUUID(), personId: owner,
    signerDeviceId: profile.device.deviceId, origin: config.origin, scopeId: config.scopeId, proposal }
  const freezeKey = await replicaCredentialFreezeKey(owner, config.origin)
  const journalKey = freezeKey.replace("tincanban.replica-credential-freeze.v1.", "tincanban.replica-credential-conflict.v1.")
  // Signature verification is the external boundary; repository/CAS and freeze parsing are real.
  const policy = { request: { binding: {}, body: "retained signed policy request" }, receipt: { payload: { revision: 5 } } }
  const journal = { kind: "rusty-credential-conflict-recovery", version: 1, freeze, capture, policy,
    drained: { progress: capture.progress } }
  await writeLocal(freezeKey, JSON.stringify(freeze))
  await writeLocal(journalKey, JSON.stringify(journal))
  const app = { getCurrentProfile: () => profile,
    readWorkspaceDoc: async () => ({ id: config.workspaceId, ownerPersonId: owner }) }
  network.snapshot.mockImplementation(async selected => {
    await persistPrivateReplicaProgress(owner, { ...selected, lastUploaded: key(20) })
  })
  return { owner, config, freeze, freezeKey, journalKey, journal, app: app as unknown as Parameters<typeof recoverRustyCredentialConflict>[0] }
}

it("Given a retained confirmed policy and no reachable automation, when this device resumes, then activate through exact local CAS, confirm its snapshot and retain its recovery evidence", async () => {
  const f = await fixture()
  await recoverRustyCredentialConflict(f.app, f.config.origin, f.config.scopeId, f.config.workspaceId, () => {})
  expect(network.verifyPolicy).toHaveBeenCalled()
  expect(network.completeIntent).toHaveBeenCalled()
  expect(network.snapshot).toHaveBeenCalledOnce()
  expect(await readLocal(f.freezeKey)).toBeNull()
  expect(await readLocal(f.journalKey)).toBeNull()
  const archived = JSON.parse((await readLocal(`${f.journalKey}.completed.${f.freeze.id}`))!)
  expect(archived.capture).toEqual(f.journal.capture)
  expect(archived.policy).toEqual(f.journal.policy)
  const selected = (await getReplicaConfigurations(f.owner))[0]!
  expect(selected).toMatchObject({ keyEpoch: 2, policyRevision: 5 })
  expect(contentKeysForEpoch(selected, 1)).toEqual([key(1), key(2)].sort())
})

it("Given a retained policy with an invalid signature, when this device resumes, then preserve the exact freeze and journal before activating or sending a snapshot", async () => {
  const f = await fixture(), raw = await readLocal(f.journalKey), frozen = await readLocal(f.freezeKey)
  network.verifyPolicy.mockRejectedValue(new Error("Rusty signature invalid"))
  await expect(recoverRustyCredentialConflict(f.app, f.config.origin, f.config.scopeId, f.config.workspaceId, () => {}))
    .rejects.toThrow("Rusty signature invalid")
  expect(await readLocal(f.journalKey)).toBe(raw)
  expect(await readLocal(f.freezeKey)).toBe(frozen)
  expect(network.snapshot).not.toHaveBeenCalled()
})

it("Given activation completed but the fresh snapshot reply was lost, when a new recovery invocation resumes, then confirm the snapshot and archive once without changing credentials again", async () => {
  const f = await fixture()
  network.snapshot.mockRejectedValueOnce(new Error("Fresh snapshot reply lost"))
  await expect(recoverRustyCredentialConflict(f.app, f.config.origin, f.config.scopeId, f.config.workspaceId, () => {}))
    .rejects.toThrow("Fresh snapshot reply lost")
  expect(await readLocal(f.freezeKey)).toBeNull()
  const pending = JSON.parse((await readLocal(f.journalKey))!)
  expect(pending.activated).toBeDefined()
  expect(await readLocal(`${f.journalKey}.completed.${f.freeze.id}`)).toBeNull()
  const credentials = await getReplicaConfigurations(f.owner)
  await recoverRustyCredentialConflict(f.app, f.config.origin, f.config.scopeId, f.config.workspaceId, () => {})
  expect(await readLocal(f.journalKey)).toBeNull()
  expect(privateReplicaBinding(f.owner, (await getReplicaConfigurations(f.owner))[0]!))
    .toBe(privateReplicaBinding(f.owner, credentials[0]!))
  expect(network.completeIntent).toHaveBeenCalledOnce()
  expect(JSON.parse((await readLocal(`${f.journalKey}.completed.${f.freeze.id}`))!).capture).toEqual(f.journal.capture)
})
