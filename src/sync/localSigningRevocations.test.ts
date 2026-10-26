import { beforeEach, expect, it } from "vitest"
import { createDeviceRevocation, createIdentityAuthorityView, createDelegatedCertificate,
  emptyIdentityProfileState, verifyIdentityDeviceAuthority } from "@meta-uber/mesh-identity"
import { adoptEnrolledIdentity, bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "../domain/identity"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { signWithContext } from "../domain/signingContext"
import { certHashDefault } from "../domain/proofs"
import { mergeIdentityAuthorityView } from "./identityAuthorityStore"

let profile: LocalProfile
beforeEach(async () => { resetIdentityStorageForTest(); profile = await bootstrapIdentity("Owner") })

it("Given a signed global Identity revocation already learned by this device, when resolving or using its workspace signer, then reject the revoked app key", async () => {
  const owner = profile
  resetIdentityStorageForTest()
  const removed = await bootstrapIdentity("Revoked app key")
  const appCertificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
    owner.identity.personId, removed.device.deviceId, removed.device.publicKey, await certHashDefault(owner.certificate))
  profile = await adoptEnrolledIdentity(owner.identity, appCertificate)
  const certificates = [owner.certificate, appCertificate]
  const context = await resolveLocalSigningContext(profile, "workspace-changes", { workspaceId: "board-1" }, { certificates })
  const authority = await verifyIdentityDeviceAuthority(owner.identity, { certificates, revocations: [] })
  const profileState = emptyIdentityProfileState(owner.identity.personId)
  const revocation = await createDeviceRevocation(owner, authority, profile.device.deviceId, profileState)
  const view = await createIdentityAuthorityView(owner.identity, { certificates, revocations: [revocation] }, profileState)
  await mergeIdentityAuthorityView(view)

  await expect(resolveLocalSigningContext(profile, "workspace-changes", { workspaceId: "board-1" }, { certificates }))
    .rejects.toThrow(/Identity device access is revoked/i)
  await expect(signWithContext(context, { kind: "workspace-changes", workspaceId: "board-1", hashes: ["change"] }))
    .rejects.toThrow(/Identity device access is revoked/i)
})

it("Given revocation arrives during the final authority check, when signing with a prepared app key, then reject before releasing the signature", async () => {
  const owner = profile
  resetIdentityStorageForTest()
  const app = await bootstrapIdentity("App device")
  const appCertificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
    owner.identity.personId, app.device.deviceId, app.device.publicKey, await certHashDefault(owner.certificate))
  profile = await adoptEnrolledIdentity(owner.identity, appCertificate)
  const certificates = [owner.certificate, appCertificate]
  const authority = await verifyIdentityDeviceAuthority(owner.identity, { certificates, revocations: [] })
  const profileState = emptyIdentityProfileState(owner.identity.personId)
  const revocation = await createDeviceRevocation(owner, authority, profile.device.deviceId, profileState)
  const view = await createIdentityAuthorityView(owner.identity, { certificates, revocations: [revocation] }, profileState)
  let authorityChecks = 0
  const context = await resolveLocalSigningContext(profile, "workspace-changes", { workspaceId: "board-1" }, {
    certificates,
    currentAuthority: async () => {
      authorityChecks += 1
      if (authorityChecks === 4) await mergeIdentityAuthorityView(view)
      return "stable"
    },
  })

  await expect(signWithContext(context, { kind: "workspace-changes", workspaceId: "board-1", hashes: ["change"] }))
    .rejects.toThrow(/Identity device access is revoked/i)
})

