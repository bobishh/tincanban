import "fake-indexeddb/auto"
import { describe, expect, it, vi } from "vitest"
import {
  createDeviceAuthorizationApproval,
  createDeviceAuthorizationRequest,
  createIdentityRustyServicePinOperation,
  createRecoverableIdentity,
  emptyIdentityProfileState,
  publicKeyId,
  readIdentityProfileState,
} from "@meta-uber/mesh-identity"
import { readIdentityRustyServicePin, saveIdentityRustyServiceCatalogApproval } from "./identityRustyServiceCatalog"

describe("durable Identity Rusty service catalog", () => {
  it("Given ordinary sign-in chooses the Identity in the portal, when its requested service is approved, then retain that verified pin for the chosen person", async () => {
    const manager = (await createRecoverableIdentity("better", "Chosen Identity")).profile
    const app = (await createRecoverableIdentity("better", "Guest app")).profile
    const service = (await createRecoverableIdentity("better", "Catalog service")).profile
    const pin = { origin: "https://signin-catalog.example", serviceId: await publicKeyId(service.identity.publicKey),
      servicePublicKey: service.identity.publicKey }
    const request = await createDeviceAuthorizationRequest(app, { applicationOrigin: "https://boards.example",
      challenge: "f".repeat(64), expiresAt: Date.now() + 60_000, personId: null,
      includeIdentityCatalogAccess: true, rustyServicePins: [pin] })
    const empty = emptyIdentityProfileState(manager.identity.personId)
    const operation = await createIdentityRustyServicePinOperation(manager, empty, pin, [manager.certificate])
    const profileState = await readIdentityProfileState({ ...empty, operations: operation ? [operation] : [] },
      manager.identity, [manager.certificate])
    const approval = await createDeviceAuthorizationApproval(manager, request, { applicationOrigin: "https://boards.example",
      challenge: request.payload.challenge, certificates: [manager.certificate], profileState, revocations: [], includeProfileState: true })
    await saveIdentityRustyServiceCatalogApproval(request, approval, app)
    await expect(readIdentityRustyServicePin(manager.identity.personId, pin.origin, app)).resolves.toEqual(pin)
  })
  it("Given signed Identity approval, when the request expires and app reloads, then resolve the same pin from retained proof", async () => {
    const manager = (await createRecoverableIdentity("better", "Identity manager")).profile
    const app = (await createRecoverableIdentity("better", "App device")).profile
    const service = (await createRecoverableIdentity("better", "Rusty service")).profile
    const origin = "https://rusty.example"
    const pin = { origin, serviceId: await publicKeyId(service.identity.publicKey), servicePublicKey: service.identity.publicKey }
    const now = Date.now()
    const request = await createDeviceAuthorizationRequest(app, { applicationOrigin: "https://boards.example",
      challenge: "d".repeat(64), expiresAt: now + 60_000, personId: manager.identity.personId, rustyServicePins: [pin] })
    const empty = emptyIdentityProfileState(manager.identity.personId)
    const operation = await createIdentityRustyServicePinOperation(manager, empty, pin, [manager.certificate])
    const profileState = await readIdentityProfileState({ ...empty, operations: operation ? [operation] : [] },
      manager.identity, [manager.certificate])
    const approval = await createDeviceAuthorizationApproval(manager, request, { applicationOrigin: "https://boards.example",
      challenge: request.payload.challenge, certificates: [manager.certificate], profileState, revocations: [] })

    await saveIdentityRustyServiceCatalogApproval(request, approval, app)
    const expiredAt = request.payload.expiresAt + 1
    vi.spyOn(Date, "now").mockReturnValue(expiredAt)
    try {
      await expect(readIdentityRustyServicePin(manager.identity.personId, origin, app)).resolves.toMatchObject(pin)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it("Given an existing manager app key with a signed Rusty pin, when its approval is saved and revalidated, then keep the exact manager certificate", async () => {
    const manager = (await createRecoverableIdentity("better", "Existing manager app")).profile
    const service = (await createRecoverableIdentity("better", "Rusty service")).profile
    const origin = "https://manager-rusty.example"
    const pin = { origin, serviceId: await publicKeyId(service.identity.publicKey), servicePublicKey: service.identity.publicKey }
    const request = await createDeviceAuthorizationRequest(manager, { applicationOrigin: "https://boards.example",
      challenge: "e".repeat(64), expiresAt: Date.now() + 60_000, personId: manager.identity.personId,
      rustyServicePins: [pin] })
    const initial = emptyIdentityProfileState(manager.identity.personId)
    const operation = await createIdentityRustyServicePinOperation(manager, initial, pin, [manager.certificate])
    const profileState = await readIdentityProfileState({ ...initial, operations: operation ? [operation] : [] },
      manager.identity, [manager.certificate])
    const approval = await createDeviceAuthorizationApproval(manager, request, { applicationOrigin: "https://boards.example",
      challenge: request.payload.challenge, certificates: [manager.certificate], profileState, revocations: [],
      includeProfileState: true })

    await saveIdentityRustyServiceCatalogApproval(request, approval, manager)
    await expect(readIdentityRustyServicePin(manager.identity.personId, origin, manager)).resolves.toMatchObject(pin)
    await expect(readIdentityRustyServicePin(manager.identity.personId, origin)).rejects.toThrow(/does not match/u)
  })
})
