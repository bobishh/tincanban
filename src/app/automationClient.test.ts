import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { automationTypes } from "../domain/automationContract"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { enrollAutomation } from "./automationClient"

const origin = "https://worker.example.test"
const integrationId = crypto.randomUUID()
const capabilities = {
  version: 2,
  origin,
  enrollment: true,
  types: [{ type: automationTypes[0]!.type, version: automationTypes[0]!.version }],
}

beforeEach(() => { resetIdentityStorageForTest() })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetIdentityStorageForTest() })

it("Given identity changes while Worker capabilities load, when enrollment resumes, then it sends no owner mutation", async () => {
  const owner = await bootstrapIdentity("Owner")
  let requestCapabilities!: () => void
  let releaseCapabilities!: (response: Response) => void
  const capabilitiesRequested = new Promise<void>(resolve => { requestCapabilities = resolve })
  const capabilitiesResponse = new Promise<Response>(resolve => { releaseCapabilities = resolve })
  const requests: Array<{ url: string; method: string }> = []
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    requests.push({ url, method })
    if (url.endsWith("/v2/capabilities")) {
      requestCapabilities()
      return capabilitiesResponse
    }
    return Response.json({ accepted: true })
  }))

  const enrollment = enrollAutomation(owner, origin, "workspace-a", integrationId)
  await capabilitiesRequested
  resetIdentityStorageForTest()
  await bootstrapIdentity("Replacement")
  releaseCapabilities(Response.json(capabilities))

  await expect(enrollment).rejects.toThrow()
  expect(requests.filter(request => request.url.endsWith(`/v2/integrations/${integrationId}/identity`))).toEqual([])
})

it("Given a different device private key, when requesting Worker enrollment, then send no owner mutation", async () => {
  const owner = await bootstrapIdentity("Owner")
  const unrelatedKey = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const wrongSigner = { ...owner, privateKeys: { ...owner.privateKeys, devicePrivateKey: unrelatedKey.privateKey } }
  const requests: Array<{ url: string; method: string }> = []
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, method: init?.method ?? "GET" })
    return Response.json(url.endsWith("/v2/capabilities") ? capabilities : { accepted: true })
  }))

  await expect(enrollAutomation(wrongSigner, origin, "workspace-a", integrationId)).rejects.toThrow()
  expect(requests).toEqual([{ url: `${origin}/v2/capabilities`, method: "GET" }])
})

it("Given the active owner device, when capabilities are accepted, then enrollment sends a verified owner request", async () => {
  const owner = await bootstrapIdentity("Owner")
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined
    requests.push({ url, method, ...(body ? { body } : {}) })
    return Response.json(url.endsWith("/v2/capabilities") ? capabilities : { origin, integrationId })
  }))

  await expect(enrollAutomation(owner, origin, "workspace-a", integrationId)).resolves.toMatchObject({ origin, integrationId })

  expect(requests.map(({ url, method }) => ({ url, method }))).toEqual([
    { url: `${origin}/v2/capabilities`, method: "GET" },
    { url: `${origin}/v2/integrations/${integrationId}/identity`, method: "POST" },
  ])
  expect(requests[1]?.body?.ownerRequest).toEqual(expect.objectContaining({ publicKey: owner.identity.publicKey, signed: expect.any(Object) }))
})

it("Given a Worker without job-intake v2, when v2 is required, then it rejects before owner signing or enrollment", async () => {
  const owner = await bootstrapIdentity("Owner")
  const requests: Array<{ url: string; method: string }> = []
  const sign = vi.spyOn(crypto.subtle, "sign")
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, method: init?.method ?? "GET" })
    return Response.json(url.endsWith("/v2/capabilities") ? { ...capabilities,
      types: [{ type: "job-intake", version: 1 }] } : { origin, integrationId })
  }))

  await expect(enrollAutomation(owner, origin, "workspace-a", integrationId,
    { type: "job-intake", typeVersion: 2 })).rejects.toThrow(/support/i)
  expect(requests).toEqual([{ url: `${origin}/v2/capabilities`, method: "GET" }])
  expect(sign).not.toHaveBeenCalled()
})

it("Given a Worker advertising job-intake v2, when v2 is required, then it signs and enrolls against that exact capability", async () => {
  const owner = await bootstrapIdentity("Owner")
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
  const sign = vi.spyOn(crypto.subtle, "sign")
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined
    requests.push({ url, method: init?.method ?? "GET", ...(body ? { body } : {}) })
    return Response.json(url.endsWith("/v2/capabilities") ? { ...capabilities,
      types: [{ type: "job-intake", version: 2 }] } : { origin, integrationId })
  }))

  await expect(enrollAutomation(owner, origin, "workspace-a", integrationId,
    { type: "job-intake", typeVersion: 2 })).resolves.toMatchObject({ origin, integrationId })
  expect(requests.map(({ url, method }) => ({ url, method }))).toEqual([
    { url: `${origin}/v2/capabilities`, method: "GET" },
    { url: `${origin}/v2/integrations/${integrationId}/identity`, method: "POST" },
  ])
  expect(requests[1]?.body?.ownerRequest).toBeDefined()
  expect(sign).toHaveBeenCalled()
})
