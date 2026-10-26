import { beforeEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot, registerDeviceInRoot, registerWorkspaceInRoot } from "../domain/personalRoot"
import { certHashDefault, createDelegatedCertificate, defaultProofStore } from "../domain/proofs"
import { defaultStorage } from "../storage"
import * as local from "../localDb"
import { applyIdentityDeviceTransfer, createIdentityDeviceTransfer, readIdentityDeviceTransfer } from "./identityDeviceTransfer"
import { resumeIdentityDeviceActivation } from "./identityDeviceActivation"
import { readIdentityStateRevision } from "../identityStateRevision"
import { createIdentityAuthorityView, createIdentityEnrollmentDevice } from "@meta-uber/mesh-identity"
import { rootIdentityProfileState } from "../domain/identityProfileRoot"
import { mergeIdentityAuthorityView, readIdentityAuthorityView, identityAuthorityViewKey } from "./identityAuthorityStore"

beforeEach(() => resetIdentityStorageForTest())

async function fixture() {
  const owner = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  await defaultStorage.savePersonalRoot(root)
  const authorityView = await createIdentityAuthorityView(owner.identity, { certificates: [owner.certificate], revocations: [] },
    await rootIdentityProfileState(root))
  await mergeIdentityAuthorityView(authorityView)
  const incoming = structuredClone(root)
  registerWorkspaceInRoot(incoming, "new-board", "new-board", "genesis")
  const transfer = await readIdentityDeviceTransfer(await createIdentityDeviceTransfer(incoming, [owner.certificate]), owner.identity.personId)
  return { owner, root, transfer }
}

it("Given a new identity catalog reference, When its authenticated state is applied twice, Then report only its first portable content change", async () => {
  const { transfer } = await fixture()
  expect(await applyIdentityDeviceTransfer(transfer, () => {})).toBe(true)
  const revision = await readIdentityStateRevision()
  expect(await applyIdentityDeviceTransfer(transfer, () => {})).toBe(false)
  expect(await readIdentityStateRevision()).toBe(revision)
})

it("Given one existing component is invalid, when importing a validated device bundle, then leave every component unchanged", async () => {
  const { owner, root, transfer } = await fixture()
  const key = `tincanban.rusty-management.v1.${owner.identity.personId}`
  await local.writeLocal(key, "malformed durable evidence")
  const replicaKey = `tincanban.private-replica-state.v2.${owner.identity.personId}`
  const before = await local.readLocal(replicaKey)
  await expect(applyIdentityDeviceTransfer(transfer, () => {})).rejects.toThrow()
  expect(await defaultStorage.loadPersonalRoot(root.rootId)).toEqual(root)
  expect(await local.readLocal(replicaKey)).toBe(before)
  expect(await local.readLocal(key)).toBe("malformed durable evidence")
})

it("Given the bundle transaction aborts, when importing, then publish no partial catalog or private state", async () => {
  const { owner, root, transfer } = await fixture()
  const original = await local.readLocal(`tincanban.private-replica-state.v2.${owner.identity.personId}`)
  const failure = vi.spyOn(local, "compareAndSwapLocal").mockRejectedValueOnce(new Error("transaction aborted"))
  try { await expect(applyIdentityDeviceTransfer(transfer, () => {})).rejects.toThrow("transaction aborted") }
  finally { failure.mockRestore() }
  expect(await defaultStorage.loadPersonalRoot(root.rootId)).toEqual(root)
  expect(await local.readLocal(`tincanban.private-replica-state.v2.${owner.identity.personId}`)).toBe(original)
})

it("Given certificate publication fails after atomic activation, when retrying, then recover durable pending effects and preserve the catalog", async () => {
  const { owner, root, transfer } = await fixture()
  const failure = vi.spyOn(defaultProofStore, "putCertificate").mockRejectedValueOnce(new Error("proof store unavailable"))
  try { await expect(applyIdentityDeviceTransfer(transfer, () => {})).rejects.toThrow("proof store unavailable") }
  finally { failure.mockRestore() }
  const pendingKey = `tincanban.identity-device-activation.v1.${owner.identity.personId}`
  expect(await local.readLocal(pendingKey)).not.toBeNull()
  expect((await defaultStorage.loadPersonalRoot(root.rootId))?.workspaces["new-board"]).toBeDefined()
  await resumeIdentityDeviceActivation(owner.identity.personId, () => {})
  expect(await local.readLocal(pendingKey)).toBeNull()
  expect(await defaultProofStore.getCertificate(await certHashDefault(owner.certificate))).toEqual(owner.certificate)
})

it("Given caller-owned derived fields differ from the manifest, when importing, then only authenticated manifest state is activated", async () => {
  const { root, transfer } = await fixture()
  transfer.personalRoot.identity.displayName = "Unbound mutation"
  transfer.personalRoot.workspaces = {}
  await applyIdentityDeviceTransfer(transfer, () => {})
  const actual = await defaultStorage.loadPersonalRoot(root.rootId)
  expect(actual?.identity.displayName).toBe("Owner")
  expect(actual?.workspaces["new-board"]).toBeDefined()
})

it("Given a newer verified authority catalog arrives on another device, when transfer activates, then merge the authority view atomically without lowering its frontier", async () => {
  const { owner, root } = await fixture()
  const previous = await readIdentityAuthorityView(owner.identity.personId)
  expect(previous).not.toBeNull()
  const app = await createIdentityEnrollmentDevice("Approved app")
  const certificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey!, owner.device.deviceId,
    owner.identity.personId, app.device.deviceId, app.device.publicKey, await certHashDefault(owner.certificate))
  const incomingRoot = structuredClone(root)
  registerDeviceInRoot(incomingRoot, { deviceId: app.device.deviceId, publicKey: app.device.publicKey,
    displayName: "Approved app", certificateHash: await certHashDefault(certificate), addedAt: new Date().toISOString() })
  const next = await createIdentityAuthorityView(owner.identity, { certificates: [owner.certificate, certificate], revocations: [] },
    await rootIdentityProfileState(incomingRoot))
  await mergeIdentityAuthorityView(next)
  const manifest = await createIdentityDeviceTransfer(incomingRoot, [owner.certificate, certificate])
  const transfer = await readIdentityDeviceTransfer(manifest, owner.identity.personId)
  await local.writeLocal(identityAuthorityViewKey(owner.identity.personId), JSON.stringify(previous))

  await applyIdentityDeviceTransfer(transfer, () => {})

  await expect(readIdentityAuthorityView(owner.identity.personId)).resolves.toMatchObject({
    revocationHead: previous!.revocationHead,
    viewDigest: next.viewDigest,
  })
})
