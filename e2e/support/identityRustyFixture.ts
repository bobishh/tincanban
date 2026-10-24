import type { Page } from "@playwright/test"

/** Create the signed Identity service approval expected from an already completed setup flow. */
export async function approveRustyForFixture(page: Page, origin: string): Promise<void> {
  await page.evaluate(async serviceOrigin => {
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const { defaultStorage } = await import("/src/storage.ts")
    const { projectIdentityProfileRoot, rootIdentityProfileState } = await import("/src/domain/identityProfileRoot.ts")
    const { createIdentityRustyServicePinOperation, readIdentityProfileState } =
      await import("/vendor/meta-mesh/packages/mesh-identity/src/index.ts")
    const { createIdentityAuthorityView } = await import("/vendor/meta-mesh/packages/mesh-identity/src/index.ts")
    const { discoverBlindKeeper } = await import("/src/sync/blindClient.ts")
    const { defaultProofStore } = await import("/src/domain/proofs.ts")
    const { mergeIdentityAuthorityView, readIdentityAuthorityView } = await import("/src/sync/identityAuthorityStore.ts")

    const profile = await bootstrapIdentity()
    const root = await defaultStorage.loadPersonalRoot()
    if (!root || root.identity.personId !== profile.identity.personId || root.identity.publicKey !== profile.identity.publicKey) {
      throw new Error("Rusty fixture requires the current Identity root")
    }
    const currentView = await readIdentityAuthorityView(profile.identity.personId)
    const knownCertificates = currentView?.certificates ?? await defaultProofStore.listCertificates()
    const certificates = [...knownCertificates.filter(certificate => certificate.payload.personId === profile.identity.personId),
      ...(!knownCertificates.some(certificate => JSON.stringify(certificate) === JSON.stringify(profile.certificate)) ? [profile.certificate] : [])]
    const service = await discoverBlindKeeper(serviceOrigin)
    const state = await rootIdentityProfileState(root)
    const operation = await createIdentityRustyServicePinOperation(profile, state, {
      origin: service.origin,
      serviceId: service.serviceId,
      servicePublicKey: service.servicePublicKey,
    }, certificates)
    const nextState = operation
      ? await readIdentityProfileState({ ...state, operations: [...state.operations, operation] }, profile.identity, certificates)
      : state
    if (operation) await defaultStorage.savePersonalRoot(projectIdentityProfileRoot(root, nextState))
    const authorityView = await createIdentityAuthorityView(profile.identity,
      { certificates, revocations: currentView?.revocations ?? [] }, nextState)
    await mergeIdentityAuthorityView(authorityView)
  }, origin)
}
