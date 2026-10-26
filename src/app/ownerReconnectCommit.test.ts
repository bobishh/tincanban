import { beforeEach, expect, test, vi } from "vitest"
import type { WorkspaceAuthorityRecord } from "../sync/peerStore"
import type * as PeerStoreModule from "../sync/peerStore"
import type { VerifiedOwnerReconnectWorkspace, OwnerReconnectHistoryReader } from "@meta-uber/mesh-workspace"
import { createWorkspaceGrant } from "@meta-uber/mesh-workspace"
import { createRecoverableIdentity } from "@meta-uber/mesh-identity"
import type { WorkspaceSetStore } from "../sync/workspaceSet"
import { bootstrapIdentity, resetIdentityStorageForTest, signEnvelope } from "../domain/identity"
import { persistVerifiedOwnerReconnect } from "./ownerReconnectFlow"

const state = vi.hoisted(() => ({ authority: null as WorkspaceAuthorityRecord | null,
  mergedAuthority: null as WorkspaceAuthorityRecord | null, order: [] as string[] }))
vi.mock("../sync/peerStore", async importOriginal => ({ ...await importOriginal<typeof PeerStoreModule>(), peerStore: {
  getWorkspaceAuthority: async () => state.authority,
  putWorkspaceAuthority: async (authority: WorkspaceAuthorityRecord) => {
    state.authority = structuredClone(state.mergedAuthority ?? authority); state.order.push("authority")
  },
} }))
vi.mock("../sync/workspaceSet", () => ({ workspaceSet: () => ({
  validate: async () => { state.order.push("validate") },
  receive: async () => { state.order.push("receive") },
}) }))
vi.mock("../sync/privateReplicaRepository", () => ({
  getReplicaConfigurations: async () => [], setReplicaPreference: async () => { state.order.push("config") },
}))
vi.mock("../sync/replicaCredentialFreeze", () => ({ assertReplicaCredentialsUnfrozen: async () => {} }))
vi.mock("../storage", () => ({ defaultStorage: {
  withWorkspaceAuthorityMutation: async (_id: string, operation: (context: { write<T>(action: () => Promise<T>): Promise<T> }) => Promise<unknown>) =>
    operation({ write: action => action() }),
} }))

beforeEach(() => { resetIdentityStorageForTest(); state.authority = null; state.mergedAuthority = null; state.order = [] })

async function fixture() {
  const profile = await bootstrapIdentity("Current owner")
  const workspaceId = "offline-owner-copy"
  const owner = { personId: profile.identity.personId, publicKey: profile.identity.publicKey, certificates: [profile.certificate] }
  const scopeAuthoritySnapshot = { genesis: await signEnvelope(profile.privateKeys.devicePrivateKey, {
    kind: "scope-genesis", version: 1, scopeId: workspaceId, creator: owner, controlEpoch: 1,
  }, profile.device.deviceId), grants: [], grantIssuers: [], revocations: [], controlTransfers: [] }
  const token = Buffer.alloc(32, 4).toString("base64url")
  const sourcePersonId = Buffer.alloc(32, 7).toString("base64url")
  const verified: VerifiedOwnerReconnectWorkspace = { workspaceId, offerDigest: "verified-offer", workspace: { id: workspaceId, bytes: "AA" },
    workspaceAccessSnapshot: {}, sourcePersonId, sourceDeviceId: "source-fixture", sourceRole: "editor",
    grant: await createWorkspaceGrant(profile, workspaceId, sourcePersonId, "editor"),
    workspaceAuthority: { version: 1, records: [], authority: { genesisOwner: owner, currentOwner: owner,
      genesisEpoch: 1, currentEpoch: 1, ownershipTransfers: [], successionClaims: [], revocations: [], deviceRevocations: [], departures: [] } },
    scopeAuthoritySnapshot, meshEnvelope: { version: 1, workspaceId, ownerPersonId: owner.personId,
      ownerPublicKey: owner.publicKey, ownerCertificates: owner.certificates, transportSecret: token, epoch: 1,
      peers: [], scopeAuthoritySnapshot }, replicaConfig: { purpose: "workspace", origin: "https://rusty.example", workspaceId,
      scopeId: token, servicePublicKey: token, readToken: token, writeToken: token, keyEpoch: 1,
      contentKey: token, policyRevision: 1 },
  }
  const control = { failActivation: true }
  const store: WorkspaceSetStore = { read: async () => new Uint8Array(), merge: async () => {}, recordVerifiedOwnerWorkspace: async () => {
    expect(state.authority?.ownerPersonId).toBe(owner.personId)
    expect(state.authority?.scopeAuthoritySnapshot).toEqual(scopeAuthoritySnapshot)
    expect(state.authority?.localGrant).toBeUndefined()
    expect(state.authority).not.toHaveProperty("transportSecret")
    state.order.push("catalog")
  }, activate: async () => {
    state.order.push("activate")
    if (control.failActivation) throw new Error("Activation interrupted")
  } }
  const mesh = { validateInvitation: async () => { state.order.push("mesh-validate"); return new Map([[workspaceId, scopeAuthoritySnapshot]]) },
    receiveInvitation: async () => {
      expect(state.authority?.ownerPersonId).toBe(owner.personId)
      state.order.push("mesh-install")
    } }
  const input = { mesh, invitationId: "owner-copy-retry", profile, workspaceId, verified, store,
    history: {} as OwnerReconnectHistoryReader, ensureCurrent: async () => {} }
  return { input, control }
}

test("Given only a participant copy and a verified owner reconnect, when activation fails and retries, then persist owner authority before publishing and acknowledge only the successful activation", async () => {
  const { input, control } = await fixture()
  await expect(persistVerifiedOwnerReconnect(input)).rejects.toThrow("Activation interrupted")
  expect(state.order).toEqual(["mesh-validate", "validate", "receive", "authority", "mesh-install", "catalog", "config", "activate"])
  control.failActivation = false
  await expect(persistVerifiedOwnerReconnect(input)).resolves.toBeUndefined()
  const afterSuccess = [...state.order]
  await expect(persistVerifiedOwnerReconnect(input)).resolves.toBeUndefined()
  expect(state.order).toEqual(afterSuccess)
})

test("Given a newer owner is retained by the durable authority merge, when reconnect commits, then stop before publishing the old owner's catalog or configuration", async () => {
  const { input } = await fixture()
  const newer = (await createRecoverableIdentity("better", "Newer owner")).profile
  state.mergedAuthority = { version: 1, workspaceId: input.workspaceId, ownerPersonId: newer.identity.personId,
    ownerPublicKey: newer.identity.publicKey, ownerCertificates: [newer.certificate], epoch: 2, updatedAt: new Date().toISOString() }
  await expect(persistVerifiedOwnerReconnect(input)).rejects.toThrow("The board owner changed during reconnect")
  expect(state.order).toEqual(["mesh-validate", "validate", "receive", "authority"])
})

test("Given a verified board copy without Rusty, when its current owner reconnects, then preserve authority and activate without creating storage configuration", async () => {
  const { input, control } = await fixture()
  control.failActivation = false
  delete (input.verified as Partial<VerifiedOwnerReconnectWorkspace>).replicaConfig
  await expect(persistVerifiedOwnerReconnect(input)).resolves.toBeUndefined()
  expect(state.order).toEqual(["mesh-validate", "validate", "receive", "authority", "mesh-install", "catalog", "activate"])
})

test("Given a mesh envelope rejected by invitation admission, when an owner reconnect commits, then leave board and catalog untouched", async () => {
  const { input } = await fixture()
  input.mesh.validateInvitation = async () => { throw new Error("Mesh owner mismatch") }
  await expect(persistVerifiedOwnerReconnect(input)).rejects.toThrow("Mesh owner mismatch")
  expect(state.order).toEqual([])
})
