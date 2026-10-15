import { expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, signEnvelope } from "../domain/identity"
import { DurableMesh } from "./durableMesh"

it("Given a cold invitation with a signed scope ledger, when preflight validates it, then return a detached history anchor without persisting access", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  const workspaceId = "history-invitation"
  const genesis = await signEnvelope(profile.privateKeys.devicePrivateKey, { kind: "scope-genesis", version: 1,
    scopeId: workspaceId, creator: { personId: profile.identity.personId, publicKey: profile.identity.publicKey,
      certificates: [profile.certificate] }, controlEpoch: 1 }, profile.device.deviceId)
  const scopeAuthoritySnapshot = { genesis, grants: [], grantIssuers: [], revocations: [], controlTransfers: [] }
  const envelope = { version: 1, workspaceId, ownerPersonId: profile.identity.personId,
    ownerPublicKey: profile.identity.publicKey, ownerCertificates: [profile.certificate], transportSecret: "secret",
    epoch: 1, peers: [], scopeAuthoritySnapshot }
  const putWorkspaceCredential = vi.fn(), putWorkspaceAuthority = vi.fn()
  const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
    getProfile: async () => profile, store: { getWorkspaceCredential: async () => null,
      getWorkspaceAuthority: async () => null, putWorkspaceCredential, putWorkspaceAuthority } as never })
  try {
    const anchors = await mesh.validateInvitation([envelope], [workspaceId], profile, [])
    expect(anchors).toEqual(new Map([[workspaceId, scopeAuthoritySnapshot]]))
    expect(putWorkspaceCredential).not.toHaveBeenCalled()
    expect(putWorkspaceAuthority).not.toHaveBeenCalled()
    const wrongScope = await signEnvelope(profile.privateKeys.devicePrivateKey, {
      ...genesis.payload, scopeId: "another-workspace" }, profile.device.deviceId)
    await expect(mesh.validateInvitation([{ ...envelope, scopeAuthoritySnapshot: {
      ...scopeAuthoritySnapshot, genesis: wrongScope } }], [workspaceId], profile, []))
      .rejects.toThrow(/invitation|authority/i)
    resetIdentityStorageForTest()
    const stranger = await bootstrapIdentity("Another owner")
    const wrongOwner = await signEnvelope(stranger.privateKeys.devicePrivateKey, { ...genesis.payload,
      creator: { personId: stranger.identity.personId, publicKey: stranger.identity.publicKey,
        certificates: [stranger.certificate] } }, stranger.device.deviceId)
    await expect(mesh.validateInvitation([{ ...envelope, scopeAuthoritySnapshot: {
      ...scopeAuthoritySnapshot, genesis: wrongOwner } }], [workspaceId], profile, []))
      .rejects.toThrow(/invitation|authority/i)
    genesis.signature = "forged"
    expect(anchors?.get(workspaceId)).not.toEqual(scopeAuthoritySnapshot)
    await expect(mesh.validateInvitation([envelope], [workspaceId], profile, [])).rejects.toThrow()
  } finally { await mesh.dispose() }
})
