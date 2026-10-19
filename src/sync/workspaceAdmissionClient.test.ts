import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { WorkspaceAdmissionInput, WorkspaceAdmissionResult } from "../product-replica/workspaceAdmission"
import type { WorkspaceAdmissionRequest, WorkspaceAdmissionResponse } from "./workspaceAdmissionWorkerContract"

const workers: FakeWorker[] = []
const onlineListeners: Array<() => void> = []
class FakeWorker {
  requests: WorkspaceAdmissionRequest[] = []
  onmessage?: (event: MessageEvent<WorkspaceAdmissionResponse>) => void
  onerror?: (event: ErrorEvent) => void
  onmessageerror?: () => void
  terminate = vi.fn()
  constructor() { workers.push(this) }
  postMessage(request: WorkspaceAdmissionRequest) { this.requests.push(request) }
  ready() { this.onmessage?.({ data: { type: "ready" } } as MessageEvent<WorkspaceAdmissionResponse>) }
  reply(response: WorkspaceAdmissionResponse) { this.onmessage?.({ data: response } as MessageEvent<WorkspaceAdmissionResponse>) }
}
const result: WorkspaceAdmissionResult = { neededHashes: [], admittedHashes: [], verifiedAuthorizations: [],
  authorizationEvidence: [], quarantinedHashes: [], pendingHashes: [], decisions: [], authorizedDocument: new Uint8Array(), authorizedHeads: [] }
function input(): WorkspaceAdmissionInput {
  return { workspaceId: "test", remote: new Uint8Array([1]), knownAuthority: null,
    authorization: {} as WorkspaceAdmissionInput["authorization"], now: Date.now() }
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  workers.length = 0
  onlineListeners.length = 0
  vi.stubGlobal("window", { addEventListener: vi.fn((type: string, listener: () => void) => {
    if (type === "online") onlineListeners.push(listener)
  }) })
  vi.stubGlobal("navigator", { onLine: true })
  vi.stubGlobal("Worker", FakeWorker)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it("Given verified history in a warm worker, When checking access, Then the same worker validates rights without another WASM instance", async () => {
  const client = await import("./workspaceAdmissionClient")
  const admission = client.runWorkspaceAdmission(input())
  workers[0]!.ready()
  await vi.waitFor(() => expect(workers[0]!.requests).toHaveLength(1))
  workers[0]!.reply({ id: workers[0]!.requests[0]!.id, result })
  await admission
  const access = client.runWorkspaceAccess({ snapshot: { workspaceId: "test", document: new Uint8Array([1]) } }, true)
  await vi.waitFor(() => expect(workers[0]!.requests).toHaveLength(2))
  expect(workers).toHaveLength(1)
  const request = workers[0]!.requests[1]!
  expect(request).toMatchObject({ kind: "access", diagnosticsEnabled: true })
  workers[0]!.reply({ id: request.id, role: "owner" })
  await expect(access).resolves.toBe("owner")
})

it("rejects queued history and access checks after initialization failure and starts a fresh worker on retry", async () => {
  const { runWorkspaceAdmission, runWorkspaceAccess } = await import("./workspaceAdmissionClient")
  const first = runWorkspaceAdmission(input())
  const second = runWorkspaceAccess({ snapshot: { document: new Uint8Array([1]) } })
  const firstRejected = expect(first).rejects.toThrow("WASM unavailable")
  const secondRejected = expect(second).rejects.toThrow("WASM unavailable")
  const failed = workers[0]!
  failed.onmessage?.({ data: { type: "initialization-error", error: "WASM unavailable" } } as MessageEvent<WorkspaceAdmissionResponse>)
  await Promise.all([firstRejected, secondRejected])
  expect(failed.terminate).toHaveBeenCalledOnce()
  const retry = runWorkspaceAdmission(input())
  expect(workers).toHaveLength(2)
  workers[1]!.ready()
  await vi.waitFor(() => expect(workers[1]!.requests).toHaveLength(1))
  workers[1]!.reply({ id: workers[1]!.requests[0]!.id, result })
  await expect(retry).resolves.toEqual(result)
})

it("rejects a stalled worker, ignores its late result and leaves a new retry pending until its own result", async () => {
  const { runWorkspaceAdmission } = await import("./workspaceAdmissionClient")
  const stalled = runWorkspaceAdmission(input())
  workers[0]!.ready()
  await vi.waitFor(() => expect(workers[0]!.requests).toHaveLength(1))
  const rejected = expect(stalled).rejects.toThrow("timed out")
  const old = workers[0]!
  await vi.advanceTimersByTimeAsync(60_000)
  await rejected
  expect(old.terminate).toHaveBeenCalledOnce()
  const retry = runWorkspaceAdmission(input())
  let completed = false
  void retry.then(() => { completed = true })
  old.reply({ id: old.requests[0]!.id, result })
  old.ready()
  await Promise.resolve()
  expect(completed).toBe(false)
  expect(workers[1]!.requests).toHaveLength(0)
  workers[1]!.ready()
  await vi.waitFor(() => expect(workers[1]!.requests).toHaveLength(1))
  old.onerror?.({ preventDefault: vi.fn(), message: "late failure from retired worker" } as unknown as ErrorEvent)
  expect(workers[1]!.terminate).not.toHaveBeenCalled()
  workers[1]!.reply({ id: workers[1]!.requests[0]!.id, result })
  await expect(retry).resolves.toEqual(result)
})

it("keeps the initialized worker after a policy rejection so later valid admission can complete", async () => {
  const { runWorkspaceAdmission } = await import("./workspaceAdmissionClient")
  const invalid = runWorkspaceAdmission(input())
  workers[0]!.ready()
  await vi.waitFor(() => expect(workers[0]!.requests).toHaveLength(1))
  const rejected = expect(invalid).rejects.toThrow("Invalid signature")
  workers[0]!.reply({ id: workers[0]!.requests[0]!.id, error: "Invalid signature" })
  await rejected
  const valid = runWorkspaceAdmission(input())
  expect(workers).toHaveLength(1)
  await vi.waitFor(() => expect(workers[0]!.requests).toHaveLength(2))
  workers[0]!.reply({ id: workers[0]!.requests[1]!.id, result })
  await expect(valid).resolves.toEqual(result)
  expect(workers[0]!.terminate).not.toHaveBeenCalled()
})

it("starts the worker before an admission is requested and waits for runtime readiness", async () => {
  const { warmWorkspaceAdmissionWorker, runWorkspaceAdmission } = await import("./workspaceAdmissionClient")
  const warmed = warmWorkspaceAdmissionWorker()
  expect(workers).toHaveLength(1)
  let settled = false
  const admission = runWorkspaceAdmission(input()).then(value => { settled = true; return value })
  await Promise.resolve()
  expect(workers[0]!.requests).toHaveLength(0)
  expect(settled).toBe(false)
  workers[0]!.ready()
  await warmed
  await vi.waitFor(() => expect(workers[0]!.requests).toHaveLength(1))
  workers[0]!.reply({ id: workers[0]!.requests[0]!.id, result })
  await expect(admission).resolves.toEqual(result)
})

it("retries worker initialization after connectivity returns", async () => {
  const { warmWorkspaceAdmissionWorker } = await import("./workspaceAdmissionClient")
  const failedWarmup = warmWorkspaceAdmissionWorker()
  const failed = workers[0]!
  const failedResult = expect(failedWarmup).rejects.toThrow("module unavailable")
  failed.onmessage?.({ data: { type: "initialization-error", error: "module unavailable" } } as MessageEvent<WorkspaceAdmissionResponse>)
  await failedResult
  expect(failed.terminate).toHaveBeenCalledOnce()

  onlineListeners[0]!()
  await vi.waitFor(() => expect(workers).toHaveLength(2))
  workers[1]!.ready()
  await expect(warmWorkspaceAdmissionWorker()).resolves.toBeUndefined()
})
