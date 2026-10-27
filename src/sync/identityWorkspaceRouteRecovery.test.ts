import "fake-indexeddb/auto"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, signEnvelope } from "../domain/identity"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { createRecoverableIdentity } from "@meta-uber/mesh-identity"
import { createPersonalRoot, registerWorkspaceInRoot } from "../domain/personalRoot"
import { certHashDefault, createDelegatedCertificate, createWorkspaceGrant, defaultProofStore } from "../domain/proofs"
import { compareAndSwapLocal, deleteLocal, listLocalKeys } from "../localDb"
import { peerStore } from "./peerStore"
import { applyIdentityDeviceTransfer, createIdentityDeviceTransfer, readIdentityDeviceTransfer } from "./identityDeviceTransfer"
import { confirmIdentityAuthorityFixture } from "./identityAuthority.testSupport"
import { identityWorkspaceRouteRecoveryComponent, readIdentityWorkspaceRouteRecovery,
  restoreIdentityWorkspaceRoutes, planIdentityWorkspaceRouteRecoveryImport } from "./identityWorkspaceRouteRecovery"
import { createPeerAdvertisement, createWorkspaceDeviceRevocation } from "./meshRecords"
import { DurableMesh } from "./durableMesh"
import type { SyncNode } from "./transport"

beforeEach(async () => {
  resetIdentityStorageForTest()
  await peerStore.clear()
  vi.stubGlobal("navigator", { ...navigator, userAgent: "test", locks: { request: async (_name: string, options: unknown, callback?: () => Promise<unknown>) =>
    typeof options === "function" ? (options as () => Promise<unknown>)() : callback?.() } })
  for (const key of await listLocalKeys()) if (key.startsWith("tincanban.identity-workspace-routes.v1.")) await deleteLocal(key)
})
afterEach(() => vi.unstubAllGlobals())

it("Given an owner catalog already carries the original connection, when automatic sync first activates the recovered board, then reuse its secret instead of creating another mesh", async () => {
  const owner = await bootstrapIdentity("Owner")
  const workspaceId = "owner-recovery-before-activation"
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  registerWorkspaceInRoot(root, workspaceId, workspaceId, "grant-hash")
  await confirmIdentityAuthorityFixture(root, [owner.certificate])
  const component = await identityWorkspaceRouteRecoveryComponent({ personId: owner.identity.personId, envelopes: [{
    version: 1, workspaceId, ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate], transportSecret: "original-shared-secret", epoch: 1, peers: [], revocations: [],
  }] })
  await compareAndSwapLocal(await planIdentityWorkspaceRouteRecoveryImport({ personId: owner.identity.personId,
    components: { workspaceRouteRecovery: component } }))
  const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
    getProfile: async () => owner, store: peerStore })
  const start = vi.spyOn(mesh, "start").mockResolvedValue()
  try {
    await mesh.addOwnerWorkspace(workspaceId)
    expect(await peerStore.getWorkspaceCredential(workspaceId)).toMatchObject({ transportSecret: "original-shared-secret" })
  } finally { start.mockRestore(); await mesh.dispose(); await peerStore.clear() }
})

it("Given a listening mesh with an older active catalog, when a board is restored, then activate its routes and publish this device's signed contact immediately", async () => {
  const owner = await bootstrapIdentity("Owner")
  const workspaceId = "restored-while-listening"
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  registerWorkspaceInRoot(root, workspaceId, workspaceId, "grant-hash")
  const sibling = (await createRecoverableIdentity("better", "Another manager")).profile
  const siblingCertificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey!, owner.device.deviceId,
    owner.identity.personId, sibling.device.deviceId, sibling.device.publicKey, await certHashDefault(owner.certificate))
  await confirmIdentityAuthorityFixture(root, [owner.certificate, siblingCertificate])
  await defaultProofStore.putCertificate(await certHashDefault(siblingCertificate), siblingCertificate)
  const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
    getProfile: async () => owner, store: peerStore })
  const running = mesh as unknown as { activeWorkspaceIds: Set<string>; node?: SyncNode; instanceId: string }
  running.activeWorkspaceIds = new Set()
  running.instanceId = "restored-instance"
  running.node = { endpointId: "restored-endpoint", close: async () => {} } as unknown as SyncNode
  try {
    const envelope = { version: 1, workspaceId, ownerPersonId: owner.identity.personId,
      ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate],
      transportSecret: "original-secret", epoch: 1, peers: [], revocations: [] }
    await mesh.receiveInvitation([envelope], [workspaceId], owner, [],
    { mode: "identity-recovery" })
    expect(running.activeWorkspaceIds).toContain(workspaceId)
    expect(await peerStore.getPeer(workspaceId, owner.device.deviceId)).toMatchObject({
      endpoint: "restored-endpoint", personId: owner.identity.personId,
      advertisement: { advertisement: { payload: { deviceId: owner.device.deviceId, instanceId: "restored-instance" } } },
    })
    const original = (await peerStore.getPeer(workspaceId, owner.device.deviceId))!.advertisement
    await mesh.receiveInvitation([envelope], [workspaceId], owner, [], { mode: "identity-recovery" })
    expect((await peerStore.getPeer(workspaceId, owner.device.deviceId))!.advertisement).toEqual(original)
  } finally { running.node = undefined; await mesh.dispose(); await peerStore.clear() }
})

it("Given a workspace credential and signed member route, when capturing private identity state, then carry the original secret, current epoch, and route bundle", async () => {
  const profile = await bootstrapIdentity("Owner")
  resetIdentityStorageForTest()
  const ray = await bootstrapIdentity("Ray")
  const workspaceId = "recovered-workspace"
  const root = createPersonalRoot(profile, await certHashDefault(profile.certificate))
  registerWorkspaceInRoot(root, workspaceId, workspaceId, "grant-hash")
  await confirmIdentityAuthorityFixture(root, [profile.certificate])
  const now = new Date().toISOString()
  const grant = await createWorkspaceGrant(profile, workspaceId, ray.identity.personId, "editor", 2)
  const bundle = await createPeerAdvertisement(ray, workspaceId, "ray-endpoint", { certificates: [ray.certificate], grant,
    ownerPublicKey: profile.identity.publicKey, ownerCertificates: [profile.certificate], instanceId: "ray-instance",
    routeSequence: 3, issuedAt: now, expiresAt: new Date(Date.now() + 120_000).toISOString() })
  await peerStore.putWorkspaceCredential({ version: 1, workspaceId, ownerPersonId: profile.identity.personId,
    ownerPublicKey: profile.identity.publicKey, ownerCertificates: [profile.certificate], transportSecret: "original-workspace-secret",
    epoch: 7, updatedAt: now, catalog: { revocations: [] } })
  await peerStore.upsertPeer({ workspaceId, deviceId: "ray-device", personId: "ray-person", endpoint: "ray-endpoint",
    transportSecret: "original-workspace-secret", role: "editor", lastSeen: now, advertisement: bundle })

  const state = await createIdentityDeviceTransfer(root, [profile.certificate], undefined, profile)

  expect(state.components.workspaceRouteRecovery).toEqual({ schema: "workspace-route-recovery@1", required: false,
    value: { personId: profile.identity.personId, envelopes: [{ version: 1, workspaceId,
      ownerPersonId: profile.identity.personId, ownerPublicKey: profile.identity.publicKey,
      ownerCertificates: [profile.certificate], transportSecret: "original-workspace-secret", epoch: 7, peers: [bundle],
      revocations: [], deviceRevocations: [], departures: [], ownerHistory: [], ownershipTransfers: [],
      successionVotes: [], successionClaims: [] }] } })
})

it("Given a signed route envelope in same-person state, when activation runs on an empty peer store, then retain it pending without trusting peer rows", async () => {
  const profile = await bootstrapIdentity("Owner")
  const workspaceId = "pending-route-workspace"
  const root = createPersonalRoot(profile, await certHashDefault(profile.certificate))
  registerWorkspaceInRoot(root, workspaceId, workspaceId, "grant-hash")
  await confirmIdentityAuthorityFixture(root, [profile.certificate])
  const now = new Date().toISOString()
  const bundle = { advertisement: { signerKeyId: "ray-device", signature: "signed-route", payload: {
    workspaceId, personId: "ray-person", deviceId: "ray-device", endpoint: "ray-endpoint", issuedAt: now,
  } } }
  await peerStore.putWorkspaceCredential({ version: 1, workspaceId, ownerPersonId: profile.identity.personId,
    ownerPublicKey: profile.identity.publicKey, ownerCertificates: [profile.certificate], transportSecret: "original-secret",
    epoch: 3, updatedAt: now, catalog: { revocations: [] } })
  await peerStore.upsertPeer({ workspaceId, deviceId: "ray-device", personId: "ray-person", endpoint: "ray-endpoint",
    transportSecret: "original-secret", role: "editor", lastSeen: now, advertisement: bundle })
  const state = await createIdentityDeviceTransfer(root, [profile.certificate], undefined, profile)
  const envelope = (state.components.workspaceRouteRecovery as unknown as { value: { envelopes: unknown[] } }).value.envelopes[0]

  await peerStore.clear()
  await applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(state, profile.identity.personId), () => {})

  expect(await peerStore.getWorkspaceCredential(workspaceId)).toBeNull()
  expect((await readIdentityWorkspaceRouteRecovery(profile.identity.personId)).envelopes).toContainEqual(envelope)
})

it("Given repeated authority snapshots with changing signed routes, when compacting, then keep the SDK-selected highest route sequence in one envelope", async () => {
  const owner = await bootstrapIdentity("Owner")
  resetIdentityStorageForTest()
  const ray = await bootstrapIdentity("Ray")
  const workspaceId = "route-compaction"
  const now = new Date().toISOString()
  const grant = await createWorkspaceGrant(owner, workspaceId, ray.identity.personId, "editor", 2)
  const common = { certificates: [ray.certificate], grant, ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate], instanceId: "ray-instance", issuedAt: now,
    expiresAt: new Date(Date.now() + 120_000).toISOString() }
  const older = await createPeerAdvertisement(ray, workspaceId, "old-endpoint", { ...common, routeSequence: 4 })
  const newer = await createPeerAdvertisement(ray, workspaceId, "new-endpoint", { ...common, routeSequence: 9 })
  const base = { version: 1 as const, workspaceId, ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: "same-secret",
    epoch: 2, peers: [], revocations: [] }

  const component = await identityWorkspaceRouteRecoveryComponent({ personId: owner.identity.personId, envelopes: [
    { ...base, peers: [older] }, { ...base, peers: [newer] }, { ...base, peers: [older] },
  ] })
  const value = component.value as { envelopes: Array<{ peers: unknown[] }> }

  expect(value.envelopes).toHaveLength(1)
  expect(value.envelopes[0]!.peers).toEqual([newer])
})

it("Given compatible signed scope snapshots from before and after a grant update, when normalizing recovery state, then merge the signed ledger through the SDK", async () => {
  const owner = await bootstrapIdentity("Owner")
  const workspaceId = "scope-snapshot-recovery"
  const genesis = await signEnvelope(owner.privateKeys.devicePrivateKey!, { kind: "scope-genesis", version: 1,
    scopeId: workspaceId, creator: { personId: owner.identity.personId, publicKey: owner.identity.publicKey,
      certificates: [owner.certificate] }, controlEpoch: 1 }, owner.device.deviceId)
  const memberGrant = async (subjectPersonId: string, grantId: string) => signEnvelope(owner.privateKeys.devicePrivateKey!, {
    kind: "scope-capability-grant", version: 1, scopeId: workspaceId, grantId,
    issuerPersonId: owner.identity.personId, subjectPersonId, capabilities: ["read"], controlEpoch: 1,
  }, owner.device.deviceId)
  const oldGrant = await memberGrant("member-before", "grant-before")
  const newGrant = await memberGrant("member-after", "grant-after")
  const envelope = (grant: unknown) => ({ version: 1 as const, workspaceId, ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: "same-secret",
    epoch: 1, peers: [], revocations: [], scopeAuthoritySnapshot: { genesis, grants: [grant], grantIssuers: [],
      revocations: [], controlTransfers: [] } })

  const component = await identityWorkspaceRouteRecoveryComponent({ personId: owner.identity.personId,
    envelopes: [envelope(oldGrant), envelope(newGrant)] })
  const envelopes = (component.value as { envelopes: Array<{ scopeAuthoritySnapshot: { grants: unknown[] } }> }).envelopes

  expect(envelopes).toHaveLength(1)
  expect(envelopes[0]!.scopeAuthoritySnapshot.grants).toEqual(expect.arrayContaining([oldGrant, newGrant]))
  expect(meshRustRuntime().state.validateScopeAuthority(envelopes[0]!.scopeAuthoritySnapshot, Date.now())).toMatchObject({ scopeId: workspaceId })
})

it("Given a workspace revocation and a newer compatible scope ledger, when restoring saved routes, then merge scope authority and preserve both catalog variants", async () => {
  const owner = await bootstrapIdentity("Owner")
  const workspaceId = "scope-and-catalog-recovery"
  const genesis = await signEnvelope(owner.privateKeys.devicePrivateKey!, { kind: "scope-genesis", version: 1,
    scopeId: workspaceId, creator: { personId: owner.identity.personId, publicKey: owner.identity.publicKey,
      certificates: [owner.certificate] }, controlEpoch: 1 }, owner.device.deviceId)
  const grant = async (subjectPersonId: string, grantId: string) => signEnvelope(owner.privateKeys.devicePrivateKey!, {
    kind: "scope-capability-grant", version: 1, scopeId: workspaceId, grantId,
    issuerPersonId: owner.identity.personId, subjectPersonId, capabilities: ["read"], controlEpoch: 1,
  }, owner.device.deviceId)
  const earlierGrant = await grant("earlier-member", "earlier-grant")
  const laterGrant = await grant("later-member", "later-grant")
  const makeEnvelope = (scopeGrant: unknown, catalogRevocations: unknown[]) => ({
    version: 1 as const, workspaceId, ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: "stable-secret",
    epoch: 1, peers: [], revocations: catalogRevocations, scopeAuthoritySnapshot: { genesis, grants: [scopeGrant],
      grantIssuers: [], revocations: [], controlTransfers: [] },
  })
  const workspaceRevocation = { payload: { personId: "revoked-member", epoch: 2 } }
  const envelopes = [makeEnvelope(earlierGrant, []), makeEnvelope(laterGrant, [workspaceRevocation])]
  const component = await identityWorkspaceRouteRecoveryComponent({ personId: owner.identity.personId, envelopes: envelopes as never[] })
  const recovered = (component.value as { envelopes: Array<{ revocations: unknown[]; scopeAuthoritySnapshot: { grants: unknown[] } }> }).envelopes
  expect(recovered).toHaveLength(2)
  expect(recovered.map(value => value.revocations)).toEqual(expect.arrayContaining([[], [workspaceRevocation]]))
  for (const envelope of recovered) {
    expect(envelope.scopeAuthoritySnapshot.grants).toEqual(expect.arrayContaining([earlierGrant, laterGrant]))
  }

  const receiveInvitation = vi.fn(async () => {})
  const mesh = { enrollmentGrant: async () => undefined, validateInvitation: async () => new Map(), receiveInvitation } as never
  await restoreIdentityWorkspaceRoutes({ mesh, envelopes: recovered as never[], workspaceIds: [workspaceId], profile: owner,
    readCredential: async () => null })
  expect(receiveInvitation).toHaveBeenCalledTimes(2)
})

it("Given signed snapshots with incompatible genesis, when recovery tries to combine them, then keep both authority variants pending", async () => {
  const owner = await bootstrapIdentity("Owner")
  resetIdentityStorageForTest()
  const stranger = await bootstrapIdentity("Different genesis")
  const workspaceId = "conflicting-scope-snapshot-recovery"
  const genesis = async (profile: typeof owner) => signEnvelope(profile.privateKeys.devicePrivateKey!, {
    kind: "scope-genesis", version: 1, scopeId: workspaceId,
    creator: { personId: profile.identity.personId, publicKey: profile.identity.publicKey,
      certificates: [profile.certificate] }, controlEpoch: 1,
  }, profile.device.deviceId)
  const envelope = async (profile: typeof owner) => ({ version: 1 as const, workspaceId, ownerPersonId: profile.identity.personId,
    ownerPublicKey: profile.identity.publicKey, ownerCertificates: [profile.certificate], transportSecret: "same-secret",
    epoch: 1, peers: [], revocations: [], scopeAuthoritySnapshot: { genesis: await genesis(profile), grants: [],
      grantIssuers: [], revocations: [], controlTransfers: [] } })

  const component = await identityWorkspaceRouteRecoveryComponent({ personId: owner.identity.personId, envelopes: [
    await envelope(owner), await envelope(stranger),
  ] })

  const envelopes = (component.value as { envelopes: Array<unknown> }).envelopes
  expect(envelopes).toHaveLength(2)
  const mesh = { enrollmentGrant: async () => undefined, validateInvitation: async () => new Map(), receiveInvitation: async () => {} } as never
  await expect(restoreIdentityWorkspaceRoutes({ mesh, envelopes: envelopes as never[], workspaceIds: [workspaceId], profile: owner,
    readCredential: async () => null })).rejects.toThrow(/multiple saved workspace authorities/i)
})

it("Given an expired but signed route lease, when compacting recovery state, then retain it as a bootstrap contact for SDK handshake revalidation", async () => {
  const owner = await bootstrapIdentity("Owner")
  resetIdentityStorageForTest()
  const ray = await bootstrapIdentity("Ray")
  const workspaceId = "expired-route-bootstrap"
  const issuedAt = new Date(Date.now() - 5 * 60_000).toISOString()
  const grant = await createWorkspaceGrant(owner, workspaceId, ray.identity.personId, "editor", 2)
  const bundle = await createPeerAdvertisement(ray, workspaceId, "ray-bootstrap-endpoint", {
    certificates: [ray.certificate], grant, ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate],
    instanceId: "ray-instance", routeSequence: 11, issuedAt,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  })
  const component = await identityWorkspaceRouteRecoveryComponent({ personId: owner.identity.personId, envelopes: [{
    version: 1, workspaceId, ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate], transportSecret: "bootstrap-secret", epoch: 2, peers: [bundle], revocations: [],
  }] })

  expect((component.value as { envelopes: Array<{ peers: unknown[] }> }).envelopes[0]!.peers).toEqual([bundle])
})

it("Given an existing workspace credential with another transport secret, when restoring its saved route, then preserve the credential and refuse invitation delivery", async () => {
  const profile = await bootstrapIdentity("Owner")
  const workspaceId = "route-secret-conflict"
  const now = new Date().toISOString()
  const envelope = { version: 1 as const, workspaceId, ownerPersonId: profile.identity.personId,
    ownerPublicKey: profile.identity.publicKey, ownerCertificates: [profile.certificate], transportSecret: "backup-secret",
    epoch: 4, peers: [], revocations: [] }
  const validateInvitation = vi.fn(async () => new Map())
  const receiveInvitation = vi.fn(async () => {})
  const mesh = { enrollmentGrant: async () => undefined, validateInvitation, receiveInvitation } as never
  const currentCredential = { version: 1 as const, workspaceId, ownerPersonId: profile.identity.personId,
    ownerPublicKey: profile.identity.publicKey, ownerCertificates: [profile.certificate], transportSecret: "current-secret",
    epoch: 4, updatedAt: now }

  await expect(restoreIdentityWorkspaceRoutes({ mesh, envelopes: [envelope], workspaceIds: [workspaceId], profile,
    readCredential: async () => currentCredential })).rejects.toThrow(/different transport secret/i)

  expect(validateInvitation).not.toHaveBeenCalled()
  expect(receiveInvitation).not.toHaveBeenCalled()
})

it("Given captured signed member routes, when a clean peer restores through DurableMesh, then admit active Ray and reject revoked or foreign routes", async () => {
  const owner = await bootstrapIdentity("Owner")
  resetIdentityStorageForTest()
  const ray = await bootstrapIdentity("Ray")
  resetIdentityStorageForTest()
  const revoked = await bootstrapIdentity("Revoked")
  const workspaceId = "durable-route-admission"
  const now = new Date().toISOString()
  const grant = await createWorkspaceGrant(owner, workspaceId, ray.identity.personId, "editor", 2)
  const revokedGrant = await createWorkspaceGrant(owner, workspaceId, revoked.identity.personId, "editor", 2)
  const bundle = await createPeerAdvertisement(ray, workspaceId, "ray-endpoint", { certificates: [ray.certificate], grant,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], instanceId: "ray-instance",
    routeSequence: 8, issuedAt: now, expiresAt: new Date(Date.now() + 120_000).toISOString() })
  const revokedBundle = await createPeerAdvertisement(revoked, workspaceId, "revoked-endpoint", {
    certificates: [revoked.certificate], grant: revokedGrant, ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate], instanceId: "revoked-instance", routeSequence: 3,
    issuedAt: now, expiresAt: new Date(Date.now() + 120_000).toISOString() })
  const deviceRevocation = await createWorkspaceDeviceRevocation(owner, workspaceId, revoked.identity.personId,
    revoked.device.deviceId, ["current-workspace-head"], [owner.certificate])
  const foreignWorkspace = `${workspaceId}-foreign`
  const foreignGrant = await createWorkspaceGrant(owner, foreignWorkspace, revoked.identity.personId, "editor", 2)
  const foreignBundle = await createPeerAdvertisement(revoked, foreignWorkspace, "foreign-endpoint", {
    certificates: [revoked.certificate], grant: foreignGrant, ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate], instanceId: "foreign-instance", routeSequence: 4,
    issuedAt: now, expiresAt: new Date(Date.now() + 120_000).toISOString() })
  await peerStore.putWorkspaceCredential({ version: 1, workspaceId, ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: "shared-secret",
    epoch: 2, updatedAt: now, catalog: { revocations: [], deviceRevocations: [deviceRevocation] } })
  await peerStore.upsertPeer({ workspaceId, deviceId: ray.device.deviceId, personId: ray.identity.personId,
    endpoint: "ray-endpoint", instanceId: "ray-instance", transportSecret: "shared-secret", role: "editor",
    lastSeen: now, advertisement: bundle })
  await peerStore.upsertPeer({ workspaceId, deviceId: revoked.device.deviceId, personId: revoked.identity.personId,
    endpoint: "revoked-endpoint", instanceId: "revoked-instance", transportSecret: "shared-secret", role: "editor",
    lastSeen: now, advertisement: revokedBundle })
  await peerStore.upsertPeer({ workspaceId, deviceId: `${revoked.device.deviceId}-foreign`, personId: revoked.identity.personId,
    endpoint: "foreign-endpoint", instanceId: "foreign-instance", transportSecret: "shared-secret", role: "editor",
    lastSeen: now, advertisement: foreignBundle })
  const envelope = (await import("./identityWorkspaceRouteRecovery")).captureWorkspaceRouteEnvelopes(peerStore, [workspaceId], owner)
  const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
    getProfile: async () => owner, store: peerStore })
  const persistGrant = vi.spyOn(defaultProofStore, "putGrant")
  const start = vi.spyOn(mesh, "start").mockResolvedValue()
  try {
    const captured = await envelope
    expect(captured[0]?.transportSecret).toBe("shared-secret")
    await peerStore.clear()
    await restoreIdentityWorkspaceRoutes({ mesh, envelopes: captured, workspaceIds: [workspaceId], profile: owner,
      readCredential: id => peerStore.getWorkspaceCredential(id) })
    expect(await peerStore.getWorkspaceCredential(workspaceId)).toMatchObject({ transportSecret: "shared-secret", epoch: 2 })
    expect(await peerStore.getPeer(workspaceId, ray.device.deviceId)).toMatchObject({
      endpoint: "ray-endpoint", transportSecret: "shared-secret", role: "editor", advertisement: bundle,
    })
    expect(await peerStore.getPeer(workspaceId, revoked.device.deviceId)).toBeNull()
    expect(await peerStore.getPeer(workspaceId, `${revoked.device.deviceId}-foreign`)).toBeNull()
    expect(await defaultProofStore.listGrants(workspaceId)).toEqual([grant])
    expect(start).toHaveBeenCalledOnce()
    await restoreIdentityWorkspaceRoutes({ mesh, envelopes: captured, workspaceIds: [workspaceId], profile: owner,
      readCredential: id => peerStore.getWorkspaceCredential(id) })
    expect(persistGrant).toHaveBeenCalledOnce()
  } finally { persistGrant.mockRestore(); start.mockRestore(); await mesh.dispose(); await peerStore.clear() }
})
