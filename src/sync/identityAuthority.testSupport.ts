import { bootstrapIdentity } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { certificateHash, createIdentityAuthorityView } from "@meta-uber/mesh-identity"
import type { DeviceCertificate, PersonalRootDocumentV1 } from "../domain/model"
import { rootIdentityProfileState } from "../domain/identityProfileRoot"
import { mergeIdentityAuthorityView } from "./identityAuthorityStore"
import { createIdentityDeviceTransfer } from "./identityDeviceTransfer"

/** Represent the explicit Identity confirmation that precedes portable-state scenarios. */
export async function confirmIdentityAuthorityFixture(root: PersonalRootDocumentV1, certificates: DeviceCertificate[]) {
  const view = await createIdentityAuthorityView(root.identity, { certificates, revocations: [] },
    await rootIdentityProfileState(root))
  return mergeIdentityAuthorityView(view)
}

export async function createAuthorizedIdentityDeviceTransferFixture(...args: Parameters<typeof createIdentityDeviceTransfer>) {
  await confirmIdentityAuthorityFixture(args[0], args[1])
  return createIdentityDeviceTransfer(...args)
}

export async function bootstrapConfirmedIdentityFixture(...args: Parameters<typeof bootstrapIdentity>) {
  const profile = await bootstrapIdentity(...args)
  await confirmIdentityAuthorityFixture(createPersonalRoot(profile, await certificateHash(profile.certificate)), [profile.certificate])
  return profile
}
