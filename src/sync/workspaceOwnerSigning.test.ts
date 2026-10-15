import { beforeEach, expect, it } from "vitest"
import { adoptEnrolledIdentity, bootstrapIdentity, resetIdentityStorageForTest, verifyEnvelope } from "../domain/identity"
import { certHashDefault, createDelegatedCertificate, createWorkspaceGrant, defaultProofStore } from "../domain/proofs"
import { signWithContext, signingEvidence } from "../domain/signingContext"
import { workspaceOwnerSigningContext } from "./workspaceOwnerSigning"
import type { WorkspaceAuthorityRecord } from "./peerStore"

beforeEach(() => resetIdentityStorageForTest())

it("Given a current workspace owner, when issuing a grant through its context, then bind the exact workspace and recipient", async () => {
  const owner = await bootstrapIdentity("Owner")
  const authority = ownerAuthority(owner)
  const context = await workspaceOwnerSigningContext(owner, authority.workspaceId, "workspace-grant",
    { personId: "member", role: "editor", accessEpoch: 2 }, async () => authority)
  const grant = await createWorkspaceGrant(owner, authority.workspaceId, "member", "editor", 2, context)
  expect(await verifyEnvelope(grant, owner.device.publicKey)).toBe(true)
  await expect(createWorkspaceGrant(owner, "another-workspace", "member", "editor", 2, context)).rejects.toThrow(/scope binding/i)
  await expect(createWorkspaceGrant(owner, authority.workspaceId, "another-member", "editor", 2, context)).rejects.toThrow(/scope binding/i)
})

it("Given a resolved owner context, when current authority changes, then reject without signing under replacement rights", async () => {
  const owner = await bootstrapIdentity("Owner")
  let authority = ownerAuthority(owner)
  const context = await workspaceOwnerSigningContext(owner, authority.workspaceId, "workspace-grant",
    { personId: "member", role: "editor", accessEpoch: 2 }, async () => authority)
  authority = { ...authority, epoch: authority.epoch + 1 }
  await expect(createWorkspaceGrant(owner, authority.workspaceId, "member", "editor", 2, context)).rejects.toThrow(/authority.*changed|stale/i)
})

it("Given missing or another owner's authority, when resolving a grant signer, then refuse authorization", async () => {
  const owner = await bootstrapIdentity("Owner")
  await expect(workspaceOwnerSigningContext(owner, "workspace", "workspace-grant", {}, async () => null)).rejects.toThrow(/owner.*authority/i)
  const authority = { ...ownerAuthority(owner), ownerPersonId: "another-person" }
  await expect(workspaceOwnerSigningContext(owner, "workspace", "workspace-grant", {}, async () => authority)).rejects.toThrow(/owner.*authority/i)
})

it("Given a scope-control transfer, when using owner authority, then bind scopeId rather than an absent workspaceId", async () => {
  const owner = await bootstrapIdentity("Owner")
  const authority = ownerAuthority(owner)
  const context = await workspaceOwnerSigningContext(owner, authority.workspaceId, "scope-control-transfer", {},
    async () => authority, "scopeId")
  const signed = await signWithContext(context, { kind: "scope-control-transfer", scopeId: authority.workspaceId })
  expect(await verifyEnvelope(signed, owner.device.publicKey)).toBe(true)
  await expect(signWithContext(context, { kind: "scope-control-transfer", scopeId: "another" })).rejects.toThrow(/scope binding/i)
})

it("Given a delegated owner with complete retained evidence, when issuing a grant, then carry its unchanged full chain", async () => {
  const issuer = await bootstrapIdentity("Owner")
  resetIdentityStorageForTest()
  const temporary = await bootstrapIdentity("Second device")
  const certificate = await createDelegatedCertificate(issuer.privateKeys.devicePrivateKey, issuer.device.deviceId,
    issuer.identity.personId, temporary.device.deviceId, temporary.device.publicKey, await certHashDefault(issuer.certificate))
  const owner = await adoptEnrolledIdentity(issuer.identity, certificate)
  await defaultProofStore.putCertificate(await certHashDefault(issuer.certificate), issuer.certificate)
  const authority = ownerAuthority(owner)
  const context = await workspaceOwnerSigningContext(owner, authority.workspaceId, "workspace-grant",
    { personId: "member", role: "editor", accessEpoch: 2 }, async () => authority)
  expect(signingEvidence(context).certificates).toEqual([certificate, issuer.certificate])
  const grant = await createWorkspaceGrant(owner, authority.workspaceId, "member", "editor", 2, context)
  expect(await verifyEnvelope(grant, temporary.device.publicKey)).toBe(true)
  expect(owner.certificate).toEqual(certificate)
})

function ownerAuthority(owner: Awaited<ReturnType<typeof bootstrapIdentity>>): WorkspaceAuthorityRecord {
  return { version: 1, workspaceId: "workspace", genesisOwnerPersonId: owner.identity.personId,
    ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate], ownerHistory: [], epoch: 1, updatedAt: new Date().toISOString(), catalog: {} }
}
