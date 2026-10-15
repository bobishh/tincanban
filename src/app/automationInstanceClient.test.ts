import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, toBase64Url, type LocalProfile } from "../domain/identity"
import { signEnvelope } from "../domain/identity"
import { blindHash } from "../sync/blindClient"
import { resolveSigningContext } from "../domain/signingContext"
import { createAutomationInstanceIdentity, type AutomationInstanceIdentityInput } from "../domain/automationInstanceIdentity"
import { automationBodyHash } from "../domain/automationProtocol"
import { verifyAutomationInstanceRequest, type AutomationInstanceRequestInput } from "../domain/automationInstanceProtocol"
import { profileFromIdentitySeedForDevice } from "@meta-uber/mesh-identity"
import { activateExistingAutomation, discoverAutomationInstance, readAutomationInstance,
  assertAutomationHistoryBaselineSupported, assertAutomationKeyHistorySupported, UnsupportedAutomationInstanceManagementError } from "./automationInstanceClient"

const origin = "https://automation.example.test"
const workspaceId = "workspace-1"
const definitionId = "typed-definition"
let executorPersonId: string
const integrationId = "legacy-route"
let owner: LocalProfile
let workerExecutor: LocalProfile
let serviceKey: CryptoKeyPair
let servicePublicKey: string
let requests: Array<{ url: string; init: RequestInit; body?: Record<string, unknown> }>
let responder: (url: string, init: RequestInit, body?: Record<string, unknown>) => Promise<Response> | Response

beforeEach(async () => {
  resetIdentityStorageForTest()
  owner = await bootstrapIdentity("Automation owner")
  executorPersonId = owner.identity.personId
  workerExecutor = await profileFromIdentitySeedForDevice(new Uint8Array(32).fill(79), "Worker executor",
    new Uint8Array(32).fill(83)) as LocalProfile
  serviceKey = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair
  const servicePublicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", serviceKey.publicKey))
  servicePublicKey = toBase64Url(servicePublicBytes)
  storage = { ...storage, servicePublicKey }
  requests = []
  responder = url => {
    if (url.endsWith("/v2/capabilities")) return Response.json({ origin, version: 2,
      instanceManagement: { version: 1, actions: ["discover", "identity", "activate"] } })
    if (url.endsWith("/discover")) return Response.json({ origin, workspaceId, definitionId, executorPersonId,
      integrations: [{ integrationId }] })
    return Response.json({ status: "active", synced: true })
  }
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined
    requests.push({ url, init, ...(body ? { body } : {}) })
    return responder(url, init, body)
  }))
})

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetIdentityStorageForTest() })

async function assertRequest(request: NonNullable<typeof requests[number]>, action: AutomationInstanceRequestInput["action"],
  body: Record<string, unknown>, integration: string | null, expectedExecutor = executorPersonId) {
  expect(request.init.mode).toBe("cors")
  expect(request.init.credentials).toBe("omit")
  expect(request.init.redirect).toBe("error")
  expect(request.init.signal).toBeInstanceOf(AbortSignal)
  expect(JSON.stringify(request.body)).not.toMatch(/privateKey|pkcs8|deviceEntropy|identitySeed/i)
  const bodyHash = await automationBodyHash(body)
  const input = { action, origin, workspaceId, definitionId, integrationId: integration,
    executorPersonId: expectedExecutor, bodyHash }
  const proof = request.body!.instanceRequest as Parameters<typeof verifyAutomationInstanceRequest>[0]
  await expect(verifyAutomationInstanceRequest(proof, input)).resolves.toMatchObject(input)
  expect(request.body!.body).toEqual(body)
}

async function identityProof(requestNonce: string, overrides: Partial<AutomationInstanceIdentityInput> = {},
  signer: LocalProfile = owner) {
  const proofExecutorPersonId = overrides.description?.executorPersonId ?? executorPersonId
  const input: AutomationInstanceIdentityInput = { origin, workspaceId, definitionId, integrationId, requestNonce,
    description: { workspaceId, boardId: "board-1", definitionId, executorPersonId: proofExecutorPersonId, grantId: "expired-grant",
      expiresAt: 1, state: "paused", adoptionRequired: false }, ...overrides }
  const context = await resolveSigningContext({ profile: signer, certificates: [], purpose: "automation-instance-identity",
    authorityRevision: "owner-revision", binding: { origin, workspaceId, definitionId, integrationId }, current: async () => ({
      personId: signer.identity.personId, deviceId: signer.device.deviceId, authorityRevision: "owner-revision",
    }) })
  return createAutomationInstanceIdentity(context, input)
}

let storage = { origin: "https://rusty.example.test", scopeId: "worker-scope", keyEpoch: 2, servicePublicKey: "" }
async function policyReceipt(revision = 4, signer: CryptoKeyPair = serviceKey, personId = owner.identity.personId) {
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", signer.publicKey))
  const serviceId = await blindHash(publicKey)
  return signEnvelope(signer.privateKey, { kind: "rusty-scope-policy-receipt" as const, version: 1 as const,
    serviceId, scopeId: storage.scopeId, personId, revision, revoked: false,
    challengeId: "challenge-1", authorizationHash: "B".repeat(43), minimumWriterVersion: 2 as const }, serviceId, "RUSTY/2")
}

describe("automation instance HTTP client", () => {
  it("Given supported rotation phases, When preparing, Then verify signed exact frozen state and refuse an ordinary identity acknowledgment", async () => {
    const { prepareAutomationStorageRotation } = await import("./automationInstanceClient")
    const transitionId = crypto.randomUUID()
    let frozen = true
    responder = async (url, _init, body) => {
      if (url.endsWith("/v2/capabilities")) return Response.json({ origin, version: 2,
        instanceManagement: { version: 1, actions: ["prepare-storage-rotation", "rotate-storage"] } })
      const nonce = (body!.instanceRequest as { signed: { payload: { nonce: string } } }).signed.payload.nonce
      return Response.json(await identityProof(nonce, { description: { workspaceId, boardId: "board-1", definitionId,
        executorPersonId: workerExecutor.identity.personId, grantId: "unchanged-grant", expiresAt: 1, state: "paused", adoptionRequired: false,
        storage: { ...storage, policyRevision: 3, minimumWriterVersion: 2 },
        ...(frozen ? { storageTransition: { transitionId, state: "frozen" as const } } : {}) } }, workerExecutor))
    }
    const input = { origin, workspaceId, definitionId, executorPersonId: workerExecutor.identity.personId, integrationId, storage, transitionId }
    expect((await prepareAutomationStorageRotation(owner, input)).identity.description.storageTransition).toEqual({ transitionId, state: "frozen" })
    frozen = false
    await expect(prepareAutomationStorageRotation(owner, input)).rejects.toThrow(/freeze/)
  })

  it("Given confirmed replacement keys, When rotating, Then bind private request and accept only exact new public storage with no grant renewal", async () => {
    const { rotateAutomationStorageCredentials } = await import("./automationInstanceClient")
    const credentials = { purpose: "workspace" as const, workspaceId, ...storage, keyEpoch: storage.keyEpoch + 1,
      contentKey: toBase64Url(new Uint8Array(32).fill(3)), historicalContentKeys: { "2": toBase64Url(new Uint8Array(32).fill(2)) },
      readToken: toBase64Url(new Uint8Array(32).fill(4)), writeToken: toBase64Url(new Uint8Array(32).fill(5)),
      policyRevision: 4, minimumWriterVersion: 2 as const, cursor: 0, lastUploaded: "" }
    let epoch = credentials.keyEpoch
    responder = async (url, _init, body) => {
      if (url.endsWith("/v2/capabilities")) return Response.json({ origin, version: 2,
        instanceManagement: { version: 1, actions: ["rotate-storage"] } })
      const nonce = (body!.instanceRequest as { signed: { payload: { nonce: string } } }).signed.payload.nonce
      return Response.json(await identityProof(nonce, { description: { workspaceId, boardId: "board-1", definitionId,
        executorPersonId: workerExecutor.identity.personId, grantId: "unchanged-grant", expiresAt: 1, state: "paused", adoptionRequired: false,
        storage: { ...storage, keyEpoch: epoch, policyRevision: 4, minimumWriterVersion: 2 } } }, workerExecutor))
    }
    const input = { origin, workspaceId, definitionId, executorPersonId: workerExecutor.identity.personId, integrationId,
      storage, transitionId: crypto.randomUUID(), credentials, receipt: await policyReceipt() }
    expect((await rotateAutomationStorageCredentials(owner, input)).identity.description).toMatchObject({ grantId: "unchanged-grant", expiresAt: 1, state: "paused" })
    const post = requests.find(request => request.url.endsWith("/rotate-storage"))!
    await assertRequest(post, "rotate-storage", post.body!.body as Record<string, unknown>, integrationId, workerExecutor.identity.personId)
    epoch--
    await expect(rotateAutomationStorageCredentials(owner, input)).rejects.toThrow(/activated/)
  })

  it("Given one matching integration route, When discovering, Then sign the exact body and select it", async () => {
    await expect(discoverAutomationInstance(owner, { origin, workspaceId, definitionId, executorPersonId }))
      .resolves.toEqual({ integrationId })
    expect(requests.map(request => request.url)).toEqual([`${origin}/v2/capabilities`, `${origin}/v2/automation-instances/discover`])
    await assertRequest(requests[1]!, "discover", { workspaceId, definitionId, executorPersonId }, null)
    responder = url => url.endsWith("/v2/capabilities")
      ? Response.json({ origin, version: 2, instanceManagement: { version: 1, actions: ["discover", "identity", "activate"] } })
      : Response.json({ origin, workspaceId, definitionId, executorPersonId,
        integrations: [{ integrationId }, { integrationId: "other-route" }] })
    await expect(discoverAutomationInstance(owner, { origin, workspaceId, definitionId, executorPersonId })).rejects.toThrow(/exactly one/i)
  })

  it("Given a verified identity proof, When reading an instance, Then bind signer, scope and fresh request nonce", async () => {
    responder = async (url, _init, body) => {
      if (url.endsWith("/v2/capabilities")) return Response.json({ origin, version: 2,
        instanceManagement: { version: 1, actions: ["discover", "identity", "activate"] } })
      const nonce = (body!.instanceRequest as { signed: { payload: { nonce: string } } }).signed.payload.nonce
      return Response.json(await identityProof(nonce))
    }
    const result = await readAutomationInstance(owner, { origin, workspaceId, definitionId, executorPersonId, integrationId })
    expect(result.identity).toMatchObject({ description: { grantId: "expired-grant" }, executorPersonId: owner.identity.personId })
    await assertRequest(requests[1]!, "identity", { workspaceId, definitionId, executorPersonId, integrationId }, integrationId)

    responder = async (url, _init, body) => {
      if (url.endsWith("/v2/capabilities")) return Response.json({ origin, version: 2,
        instanceManagement: { version: 1, actions: ["discover", "identity", "activate"] } })
      const nonce = (body!.instanceRequest as { signed: { payload: { nonce: string } } }).signed.payload.nonce
      return Response.json(await identityProof(nonce, { integrationId: "wrong-route" }))
    }
    await expect(readAutomationInstance(owner, { origin, workspaceId, definitionId, executorPersonId, integrationId })).rejects.toThrow()
    responder = async url => {
      if (url.endsWith("/v2/capabilities")) return Response.json({ origin, version: 2,
        instanceManagement: { version: 1, actions: ["identity"] } })
      return Response.json(await identityProof(crypto.randomUUID()))
    }
    await expect(readAutomationInstance(owner, { origin, workspaceId, definitionId, executorPersonId, integrationId }))
      .rejects.toThrow(/requestNonce/i)
  })

  it("Given a current policy receipt, When refreshing storage access, Then send only the signed refresh action and verify the acknowledged public binding", async () => {
    const client = await import("./automationInstanceClient")
    const refresh = client.refreshAutomationStorageAccess
    expect(refresh).toBeTypeOf("function")
    responder = async (url, ...args) => {
      if (url.endsWith("/v2/capabilities")) return Response.json({ origin, version: 2,
        instanceManagement: { version: 1, actions: ["refresh-access"] } })
      const posted = args[1] as Record<string, unknown> | undefined
      const nonce = (posted!.instanceRequest as { signed: { payload: { nonce: string } } }).signed.payload.nonce
      return Response.json(await identityProof(nonce, { description: {
        workspaceId, boardId: "board-1", definitionId, executorPersonId: workerExecutor.identity.personId, grantId: "expired-grant",
        expiresAt: 1, state: "paused", adoptionRequired: false,
        storage: { ...storage, policyRevision: 4, minimumWriterVersion: 2 },
      } }, workerExecutor))
    }
    const receipt = await policyReceipt()
    const refreshInput = { origin, workspaceId, definitionId, executorPersonId: workerExecutor.identity.personId,
      integrationId, storage, receipt }
    const result = await refresh!(owner, refreshInput)
    expect(result.identity.description).toMatchObject({ grantId: "expired-grant", expiresAt: 1, state: "paused",
      storage: { ...storage, policyRevision: 4, minimumWriterVersion: 2 } })
    const body = { workspaceId, definitionId, executorPersonId: workerExecutor.identity.personId, integrationId, storage, receipt }
    await assertRequest(requests[1]!, "refresh-access", body, integrationId, workerExecutor.identity.personId)
    expect(requests).toHaveLength(2)
    expect(requests[1]!.url).toBe(`${origin}/v2/automation-instances/refresh-access`)

    const wrongExecutorReceipt = await policyReceipt(4, serviceKey, workerExecutor.identity.personId)
    await expect(refresh!(owner, { ...refreshInput, receipt: wrongExecutorReceipt })).rejects.toThrow(/receipt|policy/i)
  })

  it("Given a Worker echo and a receipt signed by another service, When refreshing, Then reject before sending the maintenance request", async () => {
    const client = await import("./automationInstanceClient")
    const foreignKey = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair
    const foreignReceipt = await policyReceipt(4, foreignKey)
    responder = async (url, _init, body) => {
      if (url.endsWith("/v2/capabilities")) return Response.json({ origin, version: 2,
        instanceManagement: { version: 1, actions: ["refresh-access"] } })
      const nonce = (body!.instanceRequest as { signed: { payload: { nonce: string } } }).signed.payload.nonce
      return Response.json(await identityProof(nonce, { description: {
        workspaceId, boardId: "board-1", definitionId, executorPersonId: workerExecutor.identity.personId,
        grantId: "expired-grant", expiresAt: 1, state: "paused", adoptionRequired: false,
        storage: { ...storage, policyRevision: 4, minimumWriterVersion: 2 },
      } }, workerExecutor))
    }
    await expect(client.refreshAutomationStorageAccess!(owner, { origin, workspaceId, definitionId,
      executorPersonId: workerExecutor.identity.personId, integrationId, storage, receipt: foreignReceipt })).rejects.toThrow()
    expect(requests).toEqual([])
  })

  it("Given unsupported capability or mismatched refresh acknowledgment, When refreshing, Then fail without activation fallback", async () => {
    const client = await import("./automationInstanceClient")
    const refresh = client.refreshAutomationStorageAccess!
    const preflight = client.assertAutomationStorageRefreshSupported!
    const input = { origin, workspaceId, definitionId, executorPersonId, integrationId, storage, receipt: await policyReceipt() }
    responder = url => Response.json(url.endsWith("/v2/capabilities")
      ? { origin, version: 2, instanceManagement: { version: 1, actions: ["identity", "activate"] } }
      : { status: "active", synced: true })
    await expect(refresh(owner, input)).rejects.toBeInstanceOf(UnsupportedAutomationInstanceManagementError)
    expect(requests.map(request => request.url)).toEqual([`${origin}/v2/capabilities`])
    requests = []
    await expect(preflight(origin)).rejects.toBeInstanceOf(UnsupportedAutomationInstanceManagementError)
    expect(requests.map(request => request.url)).toEqual([`${origin}/v2/capabilities`])

    for (const patch of [
      { storage: undefined },
      { storage: { ...storage, scopeId: "other-scope", policyRevision: 4, minimumWriterVersion: 2 as const } },
      { storage: { ...storage, policyRevision: 5, minimumWriterVersion: 2 as const } },
    ]) {
      responder = async (url, _init, body) => {
        if (url.endsWith("/v2/capabilities")) return Response.json({ origin, version: 2,
          instanceManagement: { version: 1, actions: ["refresh-access"] } })
        const nonce = (body!.instanceRequest as { signed: { payload: { nonce: string } } }).signed.payload.nonce
        return Response.json(await identityProof(nonce, { description: {
          workspaceId, boardId: "board-1", definitionId, executorPersonId, grantId: "expired-grant",
          expiresAt: 1, state: "active", adoptionRequired: false, ...(patch.storage ? { storage: patch.storage } : {}),
        } }))
      }
      await expect(refresh(owner, input)).rejects.toThrow()
    }
    responder = async url => {
      if (url.endsWith("/v2/capabilities")) return Response.json({ origin, version: 2,
        instanceManagement: { version: 1, actions: ["refresh-access"] } })
      return Response.json(await identityProof(crypto.randomUUID(), { description: {
        workspaceId, boardId: "board-1", definitionId, executorPersonId, grantId: "grant-1",
        expiresAt: 1, state: "active", adoptionRequired: false,
        storage: { ...storage, policyRevision: 4, minimumWriterVersion: 2 },
      } }))
    }
    await expect(refresh(owner, input)).rejects.toThrow(/requestNonce/i)
    expect(requests.every(request => !request.url.endsWith("/activate"))).toBe(true)
  })

  it("Given an activation packet and adoption choice, When activating, Then send exact signed action and require strict receipt", async () => {
    const packet = { version: 1, encrypted: "opaque" }
    await expect(activateExistingAutomation(owner, { origin, workspaceId, definitionId, executorPersonId,
      integrationId, packet, adoptLegacy: true })).resolves.toBeUndefined()
    const body = { workspaceId, definitionId, executorPersonId, integrationId, packet, adoptLegacy: true }
    await assertRequest(requests[1]!, "activate", body, integrationId)
    responder = url => url.endsWith("/v2/capabilities")
      ? Response.json({ origin, version: 2, instanceManagement: { version: 1, actions: ["discover", "identity", "activate"] } })
      : Response.json({ status: "active", synced: true, extra: "guess" })
    await expect(activateExistingAutomation(owner, { origin, workspaceId, definitionId, executorPersonId,
      integrationId, packet, adoptLegacy: false })).rejects.toThrow()
  })

  it("Given absent or malformed capability, When requesting an action, Then distinguish unsupported from invalid without fallback", async () => {
    responder = () => Response.json({ origin, version: 2 })
    await expect(discoverAutomationInstance(owner, { origin, workspaceId, definitionId, executorPersonId }))
      .rejects.toBeInstanceOf(UnsupportedAutomationInstanceManagementError)
    expect(requests).toHaveLength(1)
    responder = () => Response.json({ origin, version: 1, instanceManagement: { version: 1, actions: ["discover"] } })
    await expect(discoverAutomationInstance(owner, { origin, workspaceId, definitionId, executorPersonId }))
      .rejects.toBeInstanceOf(UnsupportedAutomationInstanceManagementError)
    for (const value of [
      { origin, version: 2, instanceManagement: { version: 1, actions: ["discover", "discover"] } },
      { origin: "https://other.example.test", version: 2, instanceManagement: { version: 1, actions: ["discover"] } },
      { origin, version: 2, instanceManagement: { version: 1, actions: [7] } },
    ]) {
      responder = () => Response.json(value)
      await expect(discoverAutomationInstance(owner, { origin, workspaceId, definitionId, executorPersonId }))
        .rejects.not.toBeInstanceOf(UnsupportedAutomationInstanceManagementError)
    }
  })

  it("Given guards or response size change, When identity read completes, Then reject stale owner or oversized response", async () => {
    let current = true
    const guard = { ensureCurrent: () => { if (!current) throw new Error("identity changed") } }
    responder = async (url, _init, body) => {
      if (url.endsWith("/v2/capabilities")) return Response.json({ origin, version: 2,
        instanceManagement: { version: 1, actions: ["identity"] } })
      const nonce = (body!.instanceRequest as { signed: { payload: { nonce: string } } }).signed.payload.nonce
      const proof = await identityProof(nonce)
      current = false
      return Response.json({ proof })
    }
    await expect(readAutomationInstance(owner, { origin, workspaceId, definitionId, executorPersonId, integrationId }, guard))
      .rejects.toThrow(/identity changed/i)

    responder = url => url.endsWith("/v2/capabilities")
      ? Response.json({ origin, version: 2, instanceManagement: { version: 1, actions: ["identity"] } })
      : new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(384 * 1024 + 1)); controller.close() } }))
    await expect(readAutomationInstance(owner, { origin, workspaceId, definitionId, executorPersonId, integrationId })).rejects.toThrow(/size/i)
  })

  it("Given incomplete compact-history capability, when preparing maintenance, then refuse before exporting its signed authority", async () => {
    const actions = ["prepare-history-baseline", "activate-history-baseline"]
    responder = () => Response.json({ origin, version: 2, instanceManagement: { version: 1, actions },
      readers: { automationState: 4, workspaceSnapshot: 1 } })
    await expect(assertAutomationHistoryBaselineSupported(origin)).rejects.toThrow(/compact workspace history/)
    expect(requests.every(request => request.url.endsWith("/v2/capabilities"))).toBe(true)
    requests = []
    responder = () => Response.json({ origin, version: 2, instanceManagement: { version: 1, actions },
      readers: { automationState: 5, workspaceSnapshot: 2 } })
    await expect(assertAutomationHistoryBaselineSupported(origin)).resolves.toBeUndefined()
  })

  it("Given a Worker reader version, When multi-key history is exported, Then require the exact advertised reader floor", async () => {
    responder = () => Response.json({ origin, version: 2, readers: { automationState: 4 } })
    await expect(assertAutomationKeyHistorySupported(origin)).resolves.toBeUndefined()
    expect(requests.map(request => request.url)).toEqual([`${origin}/v2/capabilities`])

    requests = []
    responder = () => Response.json({ origin, version: 2, readers: { automationState: 3 } })
    await expect(assertAutomationKeyHistorySupported(origin)).rejects.toThrow(/multi-key replica history/i)
    expect(requests.map(request => request.url)).toEqual([`${origin}/v2/capabilities`])

    responder = () => Response.json({ origin, version: 2 })
    await expect(assertAutomationKeyHistorySupported(origin)).rejects.toThrow(/multi-key replica history/i)
  })
})

it('Given a Worker without variant-history reader support, when recovery would rotate to ambiguous keys, then refuse before sending credentials', async () => {
  const { rotateAutomationStorageCredentials } = await import('./automationInstanceClient')
  responder = async url => {
    if (url.endsWith('/v2/capabilities')) return Response.json({ origin, version: 2, readers: { automationState: 3 },
      instanceManagement: { version: 1, actions: ['prepare-storage-rotation', 'rotate-storage'] } })
    throw new Error('Credentials must not leave before compatible-reader preflight')
  }
  const credentials = { purpose: 'workspace' as const, workspaceId, origin: 'https://rusty.example.test', scopeId: 'scope',
    servicePublicKey, keyEpoch: 3, contentKey: toBase64Url(new Uint8Array(32).fill(3)),
    historicalContentKeyVariants: { '1': [toBase64Url(new Uint8Array(32).fill(1)), toBase64Url(new Uint8Array(32).fill(2))] },
    readToken: toBase64Url(new Uint8Array(32).fill(4)), writeToken: toBase64Url(new Uint8Array(32).fill(5)),
    policyRevision: 4, minimumWriterVersion: 2 as const, cursor: 0, lastUploaded: '' }
  await expect(rotateAutomationStorageCredentials(owner, { origin, workspaceId, definitionId, executorPersonId: workerExecutor.identity.personId,
    integrationId, storage: { origin: credentials.origin, scopeId: credentials.scopeId, keyEpoch: 1, servicePublicKey }, transitionId: crypto.randomUUID(),
    credentials, receipt: {} as never })).rejects.toThrow(/multi-key|history/i)
  expect(requests.some(request => request.url.endsWith('/rotate-storage'))).toBe(false)
})
