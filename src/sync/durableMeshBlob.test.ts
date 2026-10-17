import { readFile } from "node:fs/promises"
import { IDBFactory } from "fake-indexeddb"
import * as Automerge from "@automerge/automerge/slim"
import * as meshBlob from "@meta-uber/mesh-blob"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createWorkspaceDoc } from "../test/boardFixture"
import { createWorkspaceDeviceRevocation } from "./meshRecords"
import { createDelegatedCertificate } from "../domain/proofs"
import { DurableMesh } from "./durableMesh"
import type { WorkspaceMeshCredential } from "./peerStore"
import type { SessionEntry } from "./durableMeshBase"
import { MeshNetworkError } from "@meta-uber/mesh-transport"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, options: unknown, run?: () => Promise<unknown>) =>
    (run ?? options as () => Promise<unknown>)() } })
})
afterEach(() => { vi.restoreAllMocks(); resetIdentityStorageForTest() })
afterAll(() => vi.unstubAllGlobals())

const fileBytes = new Uint8Array([1, 2, 3, 4])

async function fixture() {
  const profile = await bootstrapIdentity("Mesh file owner")
  const workspaceId = crypto.randomUUID()
  const delegated = await createDelegatedCertificate(profile.privateKeys.devicePrivateKey, profile.device.deviceId,
    profile.identity.personId, "another-device", profile.device.publicKey, "A".repeat(43))
  const doc = Automerge.from(createWorkspaceDoc(workspaceId, "Files", profile.identity.personId, "blank"))
  const credential: WorkspaceMeshCredential = {
    version: 1, workspaceId, ownerPersonId: profile.identity.personId, ownerPublicKey: profile.identity.publicKey,
    ownerCertificates: [profile.certificate, delegated], transportSecret: "A".repeat(43), epoch: 1,
    updatedAt: new Date().toISOString(), catalog: { departures: [], deviceRevocations: [], revocations: [] },
  }
  let currentCredential = credential
  let currentProfile = profile
  const descriptor: meshBlob.BlobDescriptor = { kind: "blob", version: 1, blobId: `sha256:${"A".repeat(43)}`,
    name: "private.bin", mediaType: "application/octet-stream", size: fileBytes.byteLength }
  const blob = { read: vi.fn(async () => undefined), write: vi.fn(async () => {}),
    resolve: vi.fn(async (): Promise<meshBlob.BlobDescriptor | undefined> => descriptor) }
  const store = {
    getWorkspaceCredential: vi.fn(async () => currentCredential),
    getWorkspaceAuthority: vi.fn(async () => null),
    listWorkspaceCredentials: vi.fn(async () => [currentCredential]),
    listWorkspaceAuthorities: vi.fn(async () => []),
    listPeers: vi.fn(async () => []),
  }
  const getProfile = vi.fn(async () => currentProfile)
  const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never,
    workspaceStore: { blob } as never, getProfile, store: store as never })
  const internals = mesh as unknown as { sessions: Map<string, SessionEntry> }
  const mutableInternals = mesh as unknown as { activeWorkspaceIds?: Set<string> }
  const lifecycleHost = mesh as unknown as {
    canStartRuntime: () => Promise<boolean>
    acquireInstance: () => Promise<void>
    runMeshOnce: (signal: AbortSignal) => Promise<void>
  }
  lifecycleHost.canStartRuntime = async () => true
  lifecycleHost.acquireInstance = async () => {}
  lifecycleHost.runMeshOnce = signal => new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
  await mesh.start()
  const makeSession = (connectionId: string): SessionEntry => ({
    connectionId, workspaceId, deviceId: "peer-device", instanceId: "slot", endpoint: "",
    remoteIssuedAt: new Date().toISOString(), direction: "incoming", connection: {} as never,
    session: {} as never, remotePersonId: "peer", blobTransferSupported: true, evict: vi.fn(async () => {}),
  })
  const original = makeSession("old")
  const sessionKey = `${workspaceId}:${original.deviceId}:${original.instanceId}`
  internals.sessions.set(sessionKey, original)
  return {
    mesh, internals, profile, workspaceId, credential, doc, descriptor, original, sessionKey, blob, store, getProfile,
    mutableInternals,
    setCredential(value: WorkspaceMeshCredential) { currentCredential = value },
    setProfile(value: typeof profile) { currentProfile = value },
    replaceSession() {
      const replacement = makeSession("new")
      internals.sessions.delete(sessionKey)
      internals.sessions.set(sessionKey, replacement)
      return replacement
    },
    close: async () => { Automerge.free(doc); await mesh.dispose() },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

it("Given a missing or changed admitted attachment reference, when requesting mesh bytes, then send no peer request", async () => {
  const f = await fixture()
  const request = vi.spyOn(meshBlob, "requestBlob").mockResolvedValue(fileBytes)
  try {
    f.blob.resolve.mockResolvedValueOnce(undefined)
    await expect(f.mesh.fetchBlob(f.workspaceId, f.descriptor)).rejects.toThrow(/reference.*missing|changed/i)
    expect(request).not.toHaveBeenCalled()
    expect(f.blob.write).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it("Given a referenced mesh attachment, when requesting bytes, then provide the verified chunk signer to the SDK", async () => {
  const f = await fixture()
  const request = vi.spyOn(meshBlob, "requestBlob").mockResolvedValue(fileBytes)
  try {
    await expect(f.mesh.fetchBlob(f.workspaceId, f.descriptor)).resolves.toEqual(fileBytes)
    expect(request.mock.calls[0]?.[5]?.signing).toMatchObject({ personId: f.profile.identity.personId,
      deviceId: f.profile.device.deviceId, sign: expect.any(Function) })
  } finally { await f.close() }
})

async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), milliseconds)),
  ])
}

it("Given a blob request on a closing peer session, when a replacement session becomes current, then retry on that session", async () => {
  const f = await fixture()
  const oldRequest = deferred<Uint8Array>()
  const request = vi.spyOn(meshBlob, "requestBlob").mockImplementationOnce(() => oldRequest.promise)
    .mockResolvedValueOnce(fileBytes)
  try {
    const pending = f.mesh.fetchBlob(f.workspaceId, f.descriptor)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    const replacement = f.replaceSession()
    oldRequest.reject(new Error("Session closed during blob request"))

    await expect(pending).resolves.toEqual(fileBytes)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1]?.[0]).toBe(replacement.connection)
    expect(f.blob.write).toHaveBeenCalledOnce()
  } finally { await f.close() }
})

it("Given a replacement arrives near the recovery limit, when its blob transfer starts, then it receives a fresh bounded attempt budget", async () => {
  const f = await fixture()
  const request = vi.spyOn(meshBlob, "requestBlob").mockImplementationOnce((_connection, _secret, _profile, _scope,
    _descriptor, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true })
    })).mockResolvedValueOnce(fileBytes)
  vi.useFakeTimers()
  try {
    const startedAt = Date.now()
    const pending = f.mesh.fetchBlob(f.workspaceId, f.descriptor)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(9_000)
    const replacement = f.replaceSession()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))

    expect(request.mock.calls[1]?.[0]).toBe(replacement.connection)
    const retryDeadline = request.mock.calls[1]?.[5]?.deadlineAt
    if (typeof retryDeadline !== "number") throw new Error("Replacement attempt did not receive a deadline")
    expect(retryDeadline - Date.now()).toBeGreaterThanOrEqual(9_000)
    expect(retryDeadline).toBeLessThanOrEqual(startedAt + 26_000)
    await expect(pending).resolves.toEqual(fileBytes)
  } finally {
    vi.useRealTimers()
    await f.close()
  }
})

it("Given recovery time is exhausted, when a session appears later, then do not start another transfer attempt", async () => {
  const f = await fixture()
  const request = vi.spyOn(meshBlob, "requestBlob").mockImplementation((_connection, _secret, _profile, _scope,
    _descriptor, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true })
    }))
  vi.useFakeTimers()
  try {
    const pending = f.mesh.fetchBlob(f.workspaceId, f.descriptor)
    const rejected = expect(pending).rejects.toThrow(/deadline|session changed/i)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(10_000)
    f.replaceSession()
    await vi.advanceTimersByTimeAsync(300)

    expect(request).toHaveBeenCalledOnce()
    await rejected
    expect(f.blob.write).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
    await f.close()
  }
})

it("Given a network failure arrives before session eviction, when a replacement is published later, then retry the attachment within the original deadline", async () => {
  const f = await fixture()
  const request = vi.spyOn(meshBlob, "requestBlob").mockRejectedValueOnce(new MeshNetworkError("connection lost"))
    .mockResolvedValueOnce(fileBytes)
  let replacement: SessionEntry | undefined
  const replacementTimer = setTimeout(() => { replacement = f.replaceSession() }, 50)
  try {
    await expect(f.mesh.fetchBlob(f.workspaceId, f.descriptor)).resolves.toEqual(fileBytes)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1]?.[0]).toBe(replacement?.connection)
    expect(f.blob.write).toHaveBeenCalledExactlyOnceWith(f.descriptor, fileBytes)
  } finally { clearTimeout(replacementTimer); await f.close() }
})

it("Given SDK request waits for a chunk, when the peer session is replaced, then abort it and retry with SDK options", async () => {
  const f = await fixture()
  let callCount = 0
  const request = vi.spyOn(meshBlob, "requestBlob").mockImplementation((_connection, _secret, _profile, _scope,
    _descriptor, options) => {
    callCount += 1
    if (callCount > 1) return Promise.resolve(fileBytes)
    if (!options?.signal) return new Promise<Uint8Array>(() => {})
    return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }))
  })
  try {
    const pending = f.mesh.fetchBlob(f.workspaceId, f.descriptor)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    const replacement = f.replaceSession()

    expect(await settlesWithin(pending, 1_500)).toBe(true)
    await expect(pending).resolves.toEqual(fileBytes)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0]?.[5]?.signal).toBeInstanceOf(AbortSignal)
    expect(request.mock.calls[0]?.[5]?.ensureCurrent).toEqual(expect.any(Function))
    expect(request.mock.calls[0]?.[5]?.deadlineAt).toEqual(expect.any(Number))
    expect(request.mock.calls[1]?.[0]).toBe(replacement.connection)
  } finally { await f.close() }
})

it("Given a replaced session returns late bytes, when the new session is current, then only cache the new session response", async () => {
  const f = await fixture()
  const oldRequest = deferred<Uint8Array>()
  const oldBytes = new Uint8Array([9, 9, 9])
  const request = vi.spyOn(meshBlob, "requestBlob").mockImplementationOnce(() => oldRequest.promise)
    .mockResolvedValueOnce(fileBytes)
  try {
    const pending = f.mesh.fetchBlob(f.workspaceId, f.descriptor)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    f.replaceSession()
    oldRequest.resolve(oldBytes)

    await expect(pending).resolves.toEqual(fileBytes)
    expect(request).toHaveBeenCalledTimes(2)
    expect(f.blob.write).toHaveBeenCalledExactlyOnceWith(f.descriptor, fileBytes)
  } finally { await f.close() }
})

it("Given a signed local-device revocation arrives during a blob request, when old bytes return, then do not cache them", async () => {
  const f = await fixture()
  const response = deferred<Uint8Array>()
  const request = vi.spyOn(meshBlob, "requestBlob").mockReturnValue(response.promise)
  try {
    const pending = f.mesh.fetchBlob(f.workspaceId, f.descriptor)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    const revocation = await createWorkspaceDeviceRevocation(f.profile, f.workspaceId, f.profile.identity.personId,
      f.profile.device.deviceId, Automerge.getHeads(f.doc), [f.profile.certificate])
    f.setCredential({ ...f.credential, catalog: { ...f.credential.catalog as object, deviceRevocations: [revocation] } })
    response.resolve(fileBytes)

    await expect(pending).rejects.toThrow(/revok|access|permission/i)
    expect(f.blob.write).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it("Given native authority revokes this device during a hanging SDK read, when the monitor observes it, then abort without caching", async () => {
  const f = await fixture()
  const request = vi.spyOn(meshBlob, "requestBlob").mockImplementation((_connection, _secret, _profile, _scope,
    _descriptor, options) => {
    if (!options?.signal) return new Promise<Uint8Array>(() => {})
    return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }))
  })
  try {
    const pending = f.mesh.fetchBlob(f.workspaceId, f.descriptor)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    const revocation = await createWorkspaceDeviceRevocation(f.profile, f.workspaceId, f.profile.identity.personId,
      f.profile.device.deviceId, Automerge.getHeads(f.doc), [f.profile.certificate])
    f.setCredential({ ...f.credential, catalog: { ...f.credential.catalog as object, deviceRevocations: [revocation] } })

    expect(await settlesWithin(pending, 1_500)).toBe(true)
    await expect(pending).rejects.toThrow(/revok|access|permission/i)
    expect(request.mock.calls[0]?.[5]?.signal?.aborted).toBe(true)
    expect(f.blob.write).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it("Given local identity changes during a blob request, when bytes return from the previous session, then do not cache them", async () => {
  const f = await fixture()
  const response = deferred<Uint8Array>()
  const request = vi.spyOn(meshBlob, "requestBlob").mockReturnValue(response.promise)
  try {
    const pending = f.mesh.fetchBlob(f.workspaceId, f.descriptor)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    resetIdentityStorageForTest()
    f.setProfile(await bootstrapIdentity("Replacement identity"))
    response.resolve(fileBytes)

    await expect(pending).rejects.toThrow(/identity|credential|access/i)
    expect(f.blob.write).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it("Given session replacement and credential change between retries, when the old request fails, then do not adopt new authority", async () => {
  const f = await fixture()
  const oldRequest = deferred<Uint8Array>()
  const request = vi.spyOn(meshBlob, "requestBlob").mockImplementationOnce(() => oldRequest.promise)
    .mockResolvedValueOnce(fileBytes)
  try {
    const pending = f.mesh.fetchBlob(f.workspaceId, f.descriptor)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    f.replaceSession()
    f.setCredential({ ...f.credential, transportSecret: "B".repeat(43), epoch: 2 })
    oldRequest.reject(new Error("Session closed during blob request"))

    await expect(pending).rejects.toThrow(/credential changed/i)
    expect(request).toHaveBeenCalledOnce()
    expect(f.blob.write).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it("Given a request reaches the overall deadline, when its SDK attempt aborts, then do not cache partial bytes", async () => {
  const f = await fixture()
  const optionsReady = deferred<meshBlob.RequestBlobOptions>()
  vi.useFakeTimers()
  vi.spyOn(meshBlob, "requestBlob").mockImplementation((_connection, _secret, _profile, _scope,
    _descriptor, options) => new Promise((_resolve, reject) => {
    optionsReady.resolve(options!)
    const remaining = options!.deadlineAt! - Date.now()
    let settled = false
    const fail = (error: unknown) => { if (!settled) { settled = true; clearTimeout(timer); reject(error) } }
    const timer = setTimeout(() => fail(new Error("Blob transfer deadline exceeded")), remaining)
    options!.signal!.addEventListener("abort", () => fail(options!.signal!.reason), { once: true })
  }))
  try {
    const pending = f.mesh.fetchBlob(f.workspaceId, f.descriptor)
    const options = await optionsReady.promise
    expect(options?.deadlineAt).toBeGreaterThan(Date.now())
    const rejected = expect(pending).rejects.toThrow(/deadline/i)
    await vi.advanceTimersByTimeAsync(10_001)

    await rejected
    expect(f.blob.write).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
    await f.close()
  }
})

it("Given authority validation stalls past the transfer deadline, when it resumes, then do not cache returned bytes", async () => {
  const f = await fixture()
  const validationStarted = deferred<void>()
  const resumeValidation = deferred<void>()
  let credentialReads = 0
  const readCredential = f.store.getWorkspaceCredential.getMockImplementation()!
  f.store.getWorkspaceCredential.mockImplementation(async () => {
    const credential = await readCredential()
    credentialReads += 1
    if (credentialReads === 3) {
      validationStarted.resolve()
      await resumeValidation.promise
    }
    return credential
  })
  vi.spyOn(meshBlob, "requestBlob").mockResolvedValue(fileBytes)
  vi.useFakeTimers()
  try {
    const pending = f.mesh.fetchBlob(f.workspaceId, f.descriptor)
    const rejected = expect(pending).rejects.toThrow(/deadline/i)
    await validationStarted.promise
    await vi.advanceTimersByTimeAsync(10_001)
    resumeValidation.resolve()

    await rejected
    expect(f.blob.write).not.toHaveBeenCalled()
  } finally {
    resumeValidation.resolve()
    vi.useRealTimers()
    await f.close()
  }
})

it("Given the current workspace credential changes during a blob request, when prior-scope bytes return, then do not cache them", async () => {
  const f = await fixture()
  const response = deferred<Uint8Array>()
  const request = vi.spyOn(meshBlob, "requestBlob").mockReturnValue(response.promise)
  try {
    const pending = f.mesh.fetchBlob(f.workspaceId, f.descriptor)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    f.setCredential({ ...f.credential, transportSecret: "B".repeat(43), epoch: 2 })
    response.resolve(fileBytes)

    await expect(pending).rejects.toThrow(/credential|identity|access/i)
    expect(f.blob.write).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it("Given the workspace key epoch changes during a blob request, when old-scope bytes return, then do not cache them", async () => {
  const f = await fixture()
  const response = deferred<Uint8Array>()
  const request = vi.spyOn(meshBlob, "requestBlob").mockReturnValue(response.promise)
  try {
    const pending = f.mesh.fetchBlob(f.workspaceId, f.descriptor)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    f.setCredential({ ...f.credential, epoch: f.credential.epoch + 1 })
    response.resolve(fileBytes)

    await expect(pending).rejects.toThrow(/credential changed/i)
    expect(f.blob.write).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it("Given two active workspaces, when a blob read checks one credential, then preserve the complete active workspace set", async () => {
  const f = await fixture()
  const anotherWorkspace = crypto.randomUUID()
  f.mutableInternals.activeWorkspaceIds = new Set([f.workspaceId, anotherWorkspace])
  vi.spyOn(meshBlob, "requestBlob").mockResolvedValue(fileBytes)
  try {
    await expect(f.mesh.fetchBlob(f.workspaceId, f.descriptor)).resolves.toEqual(fileBytes)
    expect(f.mutableInternals.activeWorkspaceIds).toEqual(new Set([f.workspaceId, anotherWorkspace]))
  } finally { await f.close() }
})

it("Given certificate sets are reordered and credential timestamp advances, when a blob transfer is live, then accept the same authority", async () => {
  const f = await fixture()
  const response = deferred<Uint8Array>()
  const request = vi.spyOn(meshBlob, "requestBlob").mockReturnValue(response.promise)
  try {
    const pending = f.mesh.fetchBlob(f.workspaceId, f.descriptor)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    f.setCredential({ ...f.credential, updatedAt: new Date(Date.now() + 1_000).toISOString(),
      ownerCertificates: [...f.credential.ownerCertificates].reverse() })
    response.resolve(fileBytes)

    await expect(pending).resolves.toEqual(fileBytes)
    expect(f.blob.write).toHaveBeenCalledOnce()
  } finally { await f.close() }
})

it("Given the mesh runtime restarts during a blob request, when the old session returns bytes, then reject its generation", async () => {
  const f = await fixture()
  const response = deferred<Uint8Array>()
  const request = vi.spyOn(meshBlob, "requestBlob").mockReturnValue(response.promise)
  try {
    const pending = f.mesh.fetchBlob(f.workspaceId, f.descriptor)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    const runtime = f.mesh as unknown as { currentRunId: number }
    runtime.currentRunId += 1
    response.resolve(fileBytes)

    await expect(pending).rejects.toThrow(/runtime stopped or changed/i)
    expect(f.blob.write).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it("Given the mesh runtime changes during the awaited cache write, when the write resolves, then do not return stale bytes", async () => {
  const f = await fixture()
  const writePending = deferred<void>()
  f.blob.write.mockImplementation(() => writePending.promise)
  vi.spyOn(meshBlob, "requestBlob").mockResolvedValue(fileBytes)
  try {
    const pending = f.mesh.fetchBlob(f.workspaceId, f.descriptor)
    await vi.waitFor(() => expect(f.blob.write).toHaveBeenCalledOnce())
    const runtime = f.mesh as unknown as { currentRunId: number }
    runtime.currentRunId += 1
    writePending.resolve()

    await expect(pending).rejects.toThrow(/runtime stopped or changed/i)
    expect(f.blob.write).toHaveBeenCalledOnce()
  } finally { await f.close() }
})

it("Given a stopped mesh retains a stale session map entry, when fetching a missing blob, then perform no network request", async () => {
  const f = await fixture()
  const request = vi.spyOn(meshBlob, "requestBlob").mockResolvedValue(fileBytes)
  try {
    await f.mesh.stop()
    f.internals.sessions.set(f.sessionKey, f.original)
    await expect(f.mesh.fetchBlob(f.workspaceId, f.descriptor)).rejects.toThrow(/runtime stopped or changed/i)
    expect(request).not.toHaveBeenCalled()
    expect(f.blob.write).not.toHaveBeenCalled()
  } finally { await f.close() }
})
