import { beforeEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, signEnvelope } from "../domain/identity"
import { createPersonalRoot, registerDeviceInRoot, registerWorkspaceInRoot } from "../domain/personalRoot"
import { certHashDefault, createDelegatedCertificate, defaultProofStore } from "../domain/proofs"
import { defaultStorage } from "../storage"
import * as local from "../localDb"
import { applyIdentityDeviceTransfer, createIdentityDeviceTransfer, readIdentityDeviceTransfer } from "./identityDeviceTransfer"
import { resumeIdentityDeviceActivation } from "./identityDeviceActivation"
import { readIdentityStateRevision } from "../identityStateRevision"
import { createDeviceRevocation, createIdentityAuthorityView, createIdentityEnrollmentDevice, createIdentityProfileOperation,
  verifyIdentityDeviceAuthority } from "@meta-uber/mesh-identity"
import { projectIdentityProfileRoot, rootIdentityProfileState } from "../domain/identityProfileRoot"
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

it("Given a newer learned revocation, when an older authenticated catalog snapshot is imported, then recover its board reference while retaining the current revocation", async () => {
  const { owner, root, transfer } = await fixture()
  const app = await createIdentityEnrollmentDevice("Removed app")
  const certificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey!, owner.device.deviceId,
    owner.identity.personId, app.device.deviceId, app.device.publicKey, await certHashDefault(owner.certificate))
  const certificates = [owner.certificate, certificate], profileState = await rootIdentityProfileState(root)
  const authority = await verifyIdentityDeviceAuthority(owner.identity, { certificates, revocations: [] })
  const revocation = await createDeviceRevocation(owner, authority, app.device.deviceId, profileState)
  const current = await createIdentityAuthorityView(owner.identity, { certificates, revocations: [revocation] }, profileState)
  await mergeIdentityAuthorityView(current)

  await expect(applyIdentityDeviceTransfer(transfer, () => {})).resolves.toBe(true)

  expect((await defaultStorage.loadPersonalRoot(root.rootId))?.workspaces["new-board"]).toBeDefined()
  expect(await readIdentityAuthorityView(owner.identity.personId)).toEqual(current)
})

it.each(["name", "photo"] as const)("Given an offline %s edit outside a later revocation cutoff, when an old authenticated catalog is imported, then restore its board without resurrecting the revoked profile edit", async field => {
  const { owner, root } = await fixture()
  const device = await createIdentityEnrollmentDevice("Removed manager")
  const certificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey!, owner.device.deviceId,
    owner.identity.personId, device.device.deviceId, device.device.publicKey, await certHashDefault(owner.certificate))
  const certificates = [owner.certificate, certificate], profileState = await rootIdentityProfileState(root)
  await mergeIdentityAuthorityView(await createIdentityAuthorityView(owner.identity, { certificates, revocations: [] }, profileState))
  const offline = { device: device.device, identity: owner.identity, certificate,
    privateKeys: { devicePrivateKey: device.privateKey } }
  const value = field === "name" ? "Revoked offline name" : { avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA",
    changedAt: "2026-10-28T20:00:00.000Z" }
  const edit = await createIdentityProfileOperation(offline, profileState, field, value, certificates)
  const incoming = projectIdentityProfileRoot(root, { ...profileState, operations: [...profileState.operations, edit] })
  registerWorkspaceInRoot(incoming, "offline-board", "offline-board", "genesis")
  const transfer = await readIdentityDeviceTransfer(await createIdentityDeviceTransfer(incoming, certificates), owner.identity.personId)
  const authority = await verifyIdentityDeviceAuthority(owner.identity, { certificates, revocations: [] })
  const revocation = await createDeviceRevocation(owner, authority, device.device.deviceId, profileState)
  const current = await createIdentityAuthorityView(owner.identity, { certificates, revocations: [revocation] }, profileState)
  await mergeIdentityAuthorityView(current)

  await applyIdentityDeviceTransfer(transfer, () => {})

  const restored = await defaultStorage.loadPersonalRoot(root.rootId)
  expect(restored?.workspaces["offline-board"]).toBeDefined()
  expect(restored?.identity.displayName).toBe("Owner")
  expect(restored?.photo).toBeUndefined()
  expect(restored?.profileState?.operations).not.toContainEqual(edit)
  expect(await readIdentityAuthorityView(owner.identity.personId)).toEqual(current)
})

it.each(["name", "photo"] as const)("Given an active app-only device's signed %s, when its catalog is imported, then preserve existing application presentation rights without manager delegation", async field => {
  const { owner, root } = await fixture()
  const app = await createIdentityEnrollmentDevice("App presentation")
  const certificate = await signEnvelope(owner.privateKeys.identityPrivateKey!, { kind: "device-certificate" as const,
    version: 1 as const, personId: owner.identity.personId, deviceId: app.device.deviceId,
    devicePublicKey: app.device.publicKey, issuerCertificateHash: null, canEnrollDevices: false }, owner.identity.personId)
  const certificates = [owner.certificate, certificate], profileState = await rootIdentityProfileState(root)
  await mergeIdentityAuthorityView(await createIdentityAuthorityView(owner.identity, { certificates, revocations: [] }, profileState))
  const value = field === "name" ? "App name" : { avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA",
    changedAt: "2026-10-28T20:00:00.000Z" }
  const edit = { signed: await signEnvelope(app.privateKey, { kind: "identity-profile-update" as const, version: 1 as const,
    personId: owner.identity.personId, deviceId: app.device.deviceId, counter: 1, context: {}, field, value,
    supersedesLegacy: profileState.legacy.filter(observation => observation.field === field).map(observation => observation.id) }, app.device.deviceId),
  certificates: [certificate] }
  const incoming = projectIdentityProfileRoot(root, { ...profileState, operations: [...profileState.operations, edit] })
  const transfer = await readIdentityDeviceTransfer(await createIdentityDeviceTransfer(incoming, certificates), owner.identity.personId)

  await applyIdentityDeviceTransfer(transfer, () => {})

  const restored = await defaultStorage.loadPersonalRoot(root.rootId)
  expect(field === "name" ? restored?.identity.displayName : restored?.photo).toEqual(value)
  expect(restored?.profileState?.operations).toContainEqual(edit)
})

it("Given no retained personal root and a name history fully outside the signed revocation cutoff, when its historical catalog restores, then show neutral presentation without restoring the revoked name or inventing history", async () => {
  const { owner, root } = await fixture()
  const device = await createIdentityEnrollmentDevice("Removed sole name author")
  const certificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey!, owner.device.deviceId,
    owner.identity.personId, device.device.deviceId, device.device.publicKey, await certHashDefault(owner.certificate))
  const certificates = [owner.certificate, certificate]
  const profileState = { version: 1 as const, personId: owner.identity.personId, operations: [], legacy: [] }
  await mergeIdentityAuthorityView(await createIdentityAuthorityView(owner.identity, { certificates, revocations: [] }, profileState))
  const offline = { device: device.device, identity: owner.identity, certificate,
    privateKeys: { devicePrivateKey: device.privateKey } }
  const edit = await createIdentityProfileOperation(offline, profileState, "name", "Revoked only name", certificates)
  const incoming = projectIdentityProfileRoot(root, { ...profileState, operations: [edit] })
  registerWorkspaceInRoot(incoming, "restored-board", "restored-board", "genesis")
  const transfer = await readIdentityDeviceTransfer(await createIdentityDeviceTransfer(incoming, certificates), owner.identity.personId)
  const authority = await verifyIdentityDeviceAuthority(owner.identity, { certificates, revocations: [] })
  const revocation = await createDeviceRevocation(owner, authority, device.device.deviceId, profileState)
  await mergeIdentityAuthorityView(await createIdentityAuthorityView(owner.identity, { certificates, revocations: [revocation] }, profileState))
  await local.deleteLocal("tincanban.v1.personal_roots")

  await applyIdentityDeviceTransfer(transfer, () => {})

  const restored = await defaultStorage.loadPersonalRoot(root.rootId)
  expect(restored?.identity.displayName).toBe("Participant")
  expect(restored?.workspaces["restored-board"]).toBeDefined()
  expect(restored?.profileState).toEqual(profileState)
  expect((await bootstrapIdentity()).identity.displayName).toBe("Participant")
})
