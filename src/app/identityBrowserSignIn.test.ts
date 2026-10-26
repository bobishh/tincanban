import { afterEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import { createRecoverableIdentity, createDeviceAuthorizationApproval, createIdentityProfileOperation,
  emptyIdentityProfileState, publicKeyId, readIdentityProfileState } from "@meta-uber/mesh-identity"
import { createApprovedSignInCompletion, createIdentityBrowserSignIn, readPendingIdentityBrowserSignIn,
  browserSignInFailureMessage, clearIdentityBrowserSignIn, captureIdentityBrowserSignInReturn, verifyIdentityBrowserSignInReturn,
  shouldResumeIdentityBrowserSignIn, writePendingIdentityBrowserSignIn, readPendingRustyConnectionIntent,
  writePendingRustyConnectionIntent, clearPendingRustyConnectionIntent, createIdentityBrowserSignInReturn } from "./identityBrowserSignIn"

describe("Identity browser sign-in", () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it("Given a configured catalog service and a cold Identity profile, when ordinary sign-in starts, then its exact service key is included for Identity approval", async () => {
    const app = (await createRecoverableIdentity("better", "Fresh app")).profile
    const service = (await createRecoverableIdentity("better", "Catalog service")).profile
    const origin = "https://catalog.example"
    const fetcher = vi.fn(async () => Response.json({ protocolVersions: [2], publicOrigin: origin,
      service: { publicKey: service.identity.publicKey, serviceId: service.identity.personId },
      capabilities: { modes: ["blind"], applicationWrites: false, classification: false,
        identityCatalogAccess: { version: 1 } } }))
    vi.stubGlobal("fetch", fetcher)
    const { pending } = await createIdentityBrowserSignIn({ profile: app,
      portalOrigin: "https://identity.example", applicationOrigin: "https://boards.example",
      returnPath: "/", catalogOrigin: origin })
    expect(pending.request.payload).toMatchObject({ version: 3, personId: null,
      includeIdentityCatalogAccess: true, rustyServicePins: [{ origin,
        serviceId: await publicKeyId(service.identity.publicKey), servicePublicKey: service.identity.publicKey }] })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it("Given catalog discovery is unavailable, when sign-in starts, then fail before redirect and allow a fresh retry", async () => {
    const app = (await createRecoverableIdentity("better", "Fresh app")).profile
    const service = (await createRecoverableIdentity("better", "Catalog service")).profile
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("Network unavailable"))
      .mockResolvedValueOnce(Response.json({ protocolVersions: [2], publicOrigin: "https://catalog.example",
        service: { publicKey: service.identity.publicKey, serviceId: service.identity.personId },
        capabilities: { modes: ["blind"], applicationWrites: false, classification: false } }))
    vi.stubGlobal("fetch", fetcher)
    const options = { profile: app,
      portalOrigin: "https://identity.example", applicationOrigin: "https://boards.example",
      returnPath: "/", catalogOrigin: "https://catalog.example" }
    await expect(createIdentityBrowserSignIn(options)).rejects.toThrow("Network unavailable")
    await expect(createIdentityBrowserSignIn(options)).resolves.toMatchObject({ pending: {
      request: { payload: { rustyServicePins: [{ origin: options.catalogOrigin }] } },
    } })
  })

  it("keeps unexpected aborts visible with a fresh-sign-in action", () => {
    expect(browserSignInFailureMessage(new DOMException("storage unavailable", "AbortError")))
      .toBe("Identity sign-in was interrupted. Select Sign in to try again.")
    expect(browserSignInFailureMessage(new Error("approval validation failed"))).toBe("approval validation failed")
  })

  it("Given a verified approval, when profile refresh is delayed, then completion stays pending until the app finishes", async () => {
    let resolveRefresh!: () => void
    const completion = createApprovedSignInCompletion(() => new Promise<void>(resolve => { resolveRefresh = resolve }))
    const finished = completion.finish("/boards/current")

    expect(completion.phase.value).toBe("pending")
    expect(completion.error.value).toBeNull()
    resolveRefresh()
    await expect(finished).resolves.toBe(true)
    expect(completion.phase.value).toBe("complete")
  })

  it("Given a verified approval, when parent refresh fails, then the same completion cannot retry without a fresh request", async () => {
    const paths: string[] = []
    const completion = createApprovedSignInCompletion(async path => {
      paths.push(path)
      if (paths.length === 1) throw new Error("profile refresh failed")
    })

    await expect(completion.finish("/boards/current")).resolves.toBe(false)
    expect(completion.phase.value).toBe("failed")
    expect(completion.error.value).toContain("Select Sign in to retry")
    await expect(completion.finish("/boards/current")).resolves.toBe(false)
    expect(paths).toEqual(["/boards/current"])
    completion.reset()
    await expect(completion.finish("/boards/current")).resolves.toBe(true)
    expect(completion.phase.value).toBe("complete")
    expect(paths).toEqual(["/boards/current", "/boards/current"])
  })

  it("Given a coherent existing context, when the return dialog closes before completion, then keep the context ready", () => {
    vi.stubGlobal("window", { sessionStorage: { getItem: () => null }, location: { pathname: "/boards/current" },
      history: { state: null, replaceState: vi.fn() } })
    const showPortal = ref(true)
    const result = createIdentityBrowserSignInReturn({ showPortal, refreshIdentity: async () => {}, closePortal: () => {} })

    expect(result.contextReady.value).toBe(true)
    result.close()
    expect(result.contextReady.value).toBe(true)
    expect(result.returning.value).toBe(false)
  })

  it("Given a return that adopts identity before failing board selection, when dialog closes, then keep workspace projection gated", async () => {
    vi.stubGlobal("window", { sessionStorage: { getItem: () => null }, location: { pathname: "/boards/current" },
      history: { state: null, replaceState: vi.fn() } })
    const showPortal = ref(true)
    const result = createIdentityBrowserSignInReturn({ showPortal, refreshIdentity: async () => {},
      closePortal: () => {}, loadBoards: async () => { throw new Error("board selection failed") } })

    await expect(result.complete("/boards/current")).rejects.toThrow("board selection failed")
    expect(result.contextReady.value).toBe(false)
    result.close()
    expect(result.contextReady.value).toBe(false)
  })

  it("Given a return flow, when refresh and board selection finish, then open workspace projection only after route restoration", async () => {
    vi.stubGlobal("window", { sessionStorage: { getItem: () => null }, location: { pathname: "/boards/current" },
      history: { state: null, replaceState: vi.fn() } })
    const showPortal = ref(true)
    const stages: string[] = []
    const result = createIdentityBrowserSignInReturn({ showPortal,
      refreshIdentity: async () => { stages.push(`refresh:${result.contextReady.value}`) }, closePortal: () => {},
      loadBoards: async () => { stages.push(`boards:${result.contextReady.value}`) },
      resolveReturnPath: path => { stages.push(`restore:${result.contextReady.value}`); return path } })

    expect(result.contextReady.value).toBe(true)
    const complete = result.complete("/boards/current")
    expect(result.contextReady.value).toBe(false)
    await complete
    stages.push(`ready:${result.contextReady.value}`)
    expect(stages).toEqual(["refresh:false", "boards:false", "restore:false", "ready:true"])
  })

  it("Given a cancelled sign-in, when the dialog closes, then neither pending request nor stale return can reopen it", () => {
    const storage = new Map<string, string>()
    const target = {
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    }
    captureIdentityBrowserSignInReturn({ pathname: "/identity/return", hash: "#state=old&cancelled=1", storage: target })
    storage.set("tincanban.identity-browser-signin.pending.v1", "stale-request")

    clearIdentityBrowserSignIn(target)

    expect(storage.size).toBe(0)
    expect(shouldResumeIdentityBrowserSignIn("/boards/current", true, false)).toBe(false)
    expect(shouldResumeIdentityBrowserSignIn("/boards/current", true, true)).toBe(false)
    expect(shouldResumeIdentityBrowserSignIn("/identity/return", true, false)).toBe(false)
    expect(shouldResumeIdentityBrowserSignIn("/identity/return", true, true)).toBe(true)
  })

  it("Given request B supersedes request A, when late callback A arrives, then B stays pending for its own state", async () => {
    const app = (await createRecoverableIdentity("better", "App device")).profile
    const storage = new Map<string, string>()
    const adapter = { setItem: (key: string, value: string) => storage.set(key, value),
      getItem: (key: string) => storage.get(key) ?? null, removeItem: (key: string) => storage.delete(key) }
    const requestA = await createIdentityBrowserSignIn({ profile: app, portalOrigin: "https://identity.example",
      applicationOrigin: "https://boards.example", returnPath: "/", challenge: "a".repeat(64) })
    writePendingIdentityBrowserSignIn(adapter, requestA.pending)
    const requestB = await createIdentityBrowserSignIn({ profile: app, portalOrigin: "https://identity.example",
      applicationOrigin: "https://boards.example", returnPath: "/boards/current", challenge: "b".repeat(64) })
    writePendingIdentityBrowserSignIn(adapter, requestB.pending)

    expect(readPendingIdentityBrowserSignIn(adapter, requestA.pending.request.payload.challenge)).toBeNull()
    expect(readPendingIdentityBrowserSignIn(adapter, requestB.pending.request.payload.challenge)?.request.payload.challenge)
      .toBe(requestB.pending.request.payload.challenge)
  })

  it("Given a guest app device and portal approval, when returning with the bound state, then verify the app key and preserve the local return path", async () => {
    const app = (await createRecoverableIdentity("better", "App device")).profile
    const owner = (await createRecoverableIdentity("better", "Portal owner")).profile
    const now = Date.now()
    const { pending, portalUrl } = await createIdentityBrowserSignIn({ profile: app,
      portalOrigin: "https://identity.example", applicationOrigin: "https://boards.example",
      returnPath: "/workspace/123", now, challenge: "a".repeat(64) })
    expect(new URL(portalUrl).pathname).toBe("/authorize")
    expect(new URLSearchParams(new URL(portalUrl).hash.slice(1)).has("device-request")).toBe(true)
    expect(portalUrl).not.toContain("privateKey")
    expect(pending.request.payload.devicePublicKey).toBe(app.device.publicKey)
    expect(pending.request.payload).toMatchObject({ version: 3, includeIdentityCatalogAccess: true })
    const storage = new Map<string, string>()
    writePendingIdentityBrowserSignIn({ setItem: (key, value) => storage.set(key, value) }, pending)
    const read = readPendingIdentityBrowserSignIn({ getItem: key => storage.get(key) ?? null, removeItem: key => storage.delete(key) })
    expect(read?.returnPath).toBe("/workspace/123")
    expect(readPendingIdentityBrowserSignIn({ getItem: key => storage.get(key) ?? null, removeItem: key => storage.delete(key) })).toBeNull()
    const approval = await createDeviceAuthorizationApproval(owner, pending.request, {
      applicationOrigin: "https://boards.example", challenge: pending.request.payload.challenge,
      profileState: emptyIdentityProfileState(owner.identity.personId), certificates: [owner.certificate], revocations: [], includeProfileState: true,
    })
    const encoded = btoa(JSON.stringify(approval)).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_")
    const result = await verifyIdentityBrowserSignInReturn({ hash: `#state=${"a".repeat(64)}&approval=${encoded}`,
      pending, currentProfile: app, applicationOrigin: "https://boards.example" })
    expect(result).toMatchObject({ kind: "approved", returnPath: "/workspace/123", replacesIdentity: true })
    await expect(verifyIdentityBrowserSignInReturn({ hash: `#state=${"a".repeat(64)}&approval=${encoded}`,
      pending, currentProfile: app, applicationOrigin: "https://substituted.example" })).rejects.toThrow(/origin/u)
    await expect(verifyIdentityBrowserSignInReturn({ hash: `#state=${"a".repeat(64)}&approval=${encoded}`,
      pending, currentProfile: app, applicationOrigin: "https://boards.example", now: now + 120_001 })).rejects.toThrow(/approval|request/u)
    const substitutedApproval = { ...approval, proof: { ...approval.proof, payload: { ...approval.proof.payload,
      request: { ...approval.proof.payload.request, payload: { ...approval.proof.payload.request.payload, challenge: "f".repeat(64) } } } } }
    const substituted = btoa(JSON.stringify(substitutedApproval)).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_")
    await expect(verifyIdentityBrowserSignInReturn({ hash: `#state=${"a".repeat(64)}&approval=${substituted}`,
      pending, currentProfile: app, applicationOrigin: "https://boards.example" })).rejects.toThrow(/approval|request/u)
  })

  it("Given an existing manager certificate, when the exact same device returns from Identity, then accept its signed profile approval", async () => {
    const manager = (await createRecoverableIdentity("better", "Existing manager app")).profile
    const challenge = "e".repeat(64)
    const { pending } = await createIdentityBrowserSignIn({ profile: manager, portalOrigin: "https://identity.example",
      applicationOrigin: "https://boards.example", returnPath: "/boards/current", challenge,
      personId: manager.identity.personId })
    const initial = emptyIdentityProfileState(manager.identity.personId)
    const avatarData = "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA"
    const photo = await createIdentityProfileOperation(manager, initial, "photo", {
      avatarData, changedAt: "2026-10-25T00:00:00.000Z",
    })
    const profileState = await readIdentityProfileState({ ...initial, operations: [photo] }, manager.identity,
      [manager.certificate])
    const approval = await createDeviceAuthorizationApproval(manager, pending.request, {
      applicationOrigin: "https://boards.example", challenge, certificates: [manager.certificate], profileState,
      revocations: [], includeProfileState: true,
    })
    const encoded = btoa(JSON.stringify(approval)).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_")

    await expect(verifyIdentityBrowserSignInReturn({ hash: `#state=${challenge}&approval=${encoded}`, pending,
      currentProfile: manager, applicationOrigin: "https://boards.example" })).resolves.toMatchObject({
      kind: "approved", replacesIdentity: false, approval: { certificate: manager.certificate },
    })
  })

  it("Given Add Rusty requests Identity consent, When creating the browser request, Then bind the same Identity and exact Rusty service key", async () => {
    const app = (await createRecoverableIdentity("better", "Current app")).profile
    const service = (await createRecoverableIdentity("better", "Rusty service")).profile
    const pin = { origin: "https://rusty.example", serviceId: await publicKeyId(service.identity.publicKey),
      servicePublicKey: service.identity.publicKey }
    const fetcher = vi.fn(async () => { throw new Error("Explicit pin must not be rediscovered") })
    vi.stubGlobal("fetch", fetcher)
    const { pending } = await createIdentityBrowserSignIn({ profile: app, portalOrigin: "https://identity.example",
      applicationOrigin: "https://boards.example", returnPath: "/boards/current", personId: app.identity.personId,
      rustyServicePins: [pin], catalogOrigin: "https://ignored.example", challenge: "c".repeat(64) })
    expect(fetcher).not.toHaveBeenCalled()
    expect(pending.request.payload.personId).toBe(app.identity.personId)
    expect(pending.request.payload).toMatchObject({ version: 3, includeIdentityCatalogAccess: true, rustyServicePins: [pin] })

    const storage = new Map<string, string>()
    const adapter = { setItem: (key: string, value: string) => storage.set(key, value),
      getItem: (key: string) => storage.get(key) ?? null, removeItem: (key: string) => storage.delete(key) }
    const intent = { version: 1 as const, origin: pin.origin, serviceId: pin.serviceId,
      workspaceId: "workspace-1", challenge: pending.request.payload.challenge }
    writePendingRustyConnectionIntent(adapter, intent)
    expect(readPendingRustyConnectionIntent(adapter, false)).toEqual(intent)
    expect(readPendingRustyConnectionIntent(adapter)).toEqual(intent)
    clearPendingRustyConnectionIntent(adapter)
    expect(readPendingRustyConnectionIntent(adapter)).toBeNull()
  })

  it("Given a cancelled or substituted browser return, when callback handling runs, then leave identity approval unavailable", async () => {
    const app = (await createRecoverableIdentity("better", "App device")).profile
    const { pending } = await createIdentityBrowserSignIn({ profile: app,
      portalOrigin: "https://identity.example", applicationOrigin: "https://boards.example",
      returnPath: "/", now: Date.now(), challenge: "b".repeat(64) })
    await expect(verifyIdentityBrowserSignInReturn({ hash: "#state=wrong&approval=bad", pending,
      currentProfile: app, applicationOrigin: "https://boards.example" })).rejects.toThrow(/state/u)
    await expect(verifyIdentityBrowserSignInReturn({ hash: `#state=${"b".repeat(64)}&cancelled=1`, pending,
      currentProfile: app, applicationOrigin: "https://boards.example" })).resolves.toMatchObject({ kind: "cancelled" })
    const changed = { ...app, device: { ...app.device, publicKey: "substituted" } }
    await expect(verifyIdentityBrowserSignInReturn({ hash: `#state=${"b".repeat(64)}&approval=bad`, pending,
      currentProfile: changed, applicationOrigin: "https://boards.example" })).rejects.toThrow(/changed/u)
  })
})
