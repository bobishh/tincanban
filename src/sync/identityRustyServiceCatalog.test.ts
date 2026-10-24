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

    await saveIdentityRustyServiceCatalogApproval(request, approval)
    const expiredAt = request.payload.expiresAt + 1
    vi.spyOn(Date, "now").mockReturnValue(expiredAt)
    try {
      await expect(readIdentityRustyServicePin(manager.identity.personId, origin)).resolves.toMatchObject(pin)
    } finally {
      vi.restoreAllMocks()
    }
  })
})
