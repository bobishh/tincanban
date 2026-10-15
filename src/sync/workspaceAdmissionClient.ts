import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import type { WorkspaceAdmissionInput, WorkspaceAdmissionResult,
  WorkspaceAdmissionRequest, WorkspaceAdmissionResponse } from "./workspaceAdmissionCore"
import type { WorkspaceAccessInput } from "./workspaceAccessInput"
import type { WorkspaceRole } from "../domain/permissions"

type PolicyResult = WorkspaceAdmissionResult | WorkspaceRole
type PendingJob = { resolve(result: PolicyResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
let worker: Worker | undefined
let workerReady: Promise<void> | undefined
let resolveWorkerReady: (() => void) | undefined
let rejectReady: ((error: Error) => void) | undefined
let nextId = 0
const pending = new Map<number, PendingJob>()
const admissionDeadlineMs = 60_000
const workerReadinessDeadlineMs = 15_000
let onlineWarmupInstalled = false
let workerReadinessTimer: ReturnType<typeof setTimeout> | undefined

function failWorker(target: Worker, error: Error) {
  if (worker !== target) return
  if (workerReadinessTimer) clearTimeout(workerReadinessTimer)
  workerReadinessTimer = undefined
  rejectReady?.(error)
  rejectReady = undefined
  worker?.terminate()
  worker = undefined
  workerReady = undefined
  resolveWorkerReady = undefined
  for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error) }
  pending.clear()
}

function admissionWorker(): Worker {
  if (worker) return worker
  // Browser failures must reject admission, never fall back to blocking UI.
  const target = new Worker(new URL("./workspaceAdmissionWorker.ts", import.meta.url), { type: "module", name: "workspace-admission" })
  worker = target
  target.onmessage = (event: MessageEvent<WorkspaceAdmissionResponse>) => {
    if (worker !== target) return
    const response = event.data
    if ("type" in response) {
      if (response.type === "ready") {
        if (workerReadinessTimer) clearTimeout(workerReadinessTimer)
        workerReadinessTimer = undefined
        resolveWorkerReady?.()
        resolveWorkerReady = undefined
        rejectReady = undefined
      } else failWorker(target, new Error(response.error))
      return
    }
    const job = pending.get(response.id)
    if (!job) return
    if ("error" in response && response.fatal) { failWorker(target, new Error(response.error)); return }
    pending.delete(response.id)
    clearTimeout(job.timer)
    if ("error" in response) job.reject(new Error(response.error))
    else job.resolve("role" in response ? response.role : response.result)
  }
  target.onerror = event => { event.preventDefault(); failWorker(target, new Error(`Workspace admission worker failed: ${event.message}`)) }
  target.onmessageerror = () => failWorker(target, new Error("Workspace admission worker response could not be decoded"))
  workerReady = new Promise<void>((resolve, reject) => {
    resolveWorkerReady = resolve
    rejectReady = reject
  })
  workerReadinessTimer = setTimeout(() => failWorker(target, new Error("Workspace admission worker initialization timed out")), workerReadinessDeadlineMs)
  // Prewarming has no waiter yet; keep a rejected readiness promise handled.
  void workerReady.catch(() => {})
  return worker
}

export async function warmWorkspaceAdmissionWorker(): Promise<void> {
  if (typeof window === "undefined") return
  installOnlineWarmup()
  const target = admissionWorker()
  const ready = workerReady
  if (!ready) return
  await ready
  if (worker !== target) throw new Error("Workspace admission worker was replaced while starting")
}

function installOnlineWarmup() {
  if (onlineWarmupInstalled) return
  onlineWarmupInstalled = true
  window.addEventListener("online", () => { void warmWorkspaceAdmissionWorker().catch(() => {}) })
}

export async function runWorkspaceAdmission(input: WorkspaceAdmissionInput): Promise<WorkspaceAdmissionResult> {
  // The opaque Native baseline handle cannot cross the browser Worker boundary.
  // Keep compact-history admission on the same Native policy implementation.
  if (input.receivedBasis) {
    const { computeWorkspaceAdmission } = await import("./workspaceAdmissionCore")
    return computeWorkspaceAdmission(input, meshRustRuntime().state)
  }
  // Non-browser callers (CLI/unit fixtures) use the identical pure algorithm.
  if (typeof window === "undefined") {
    const { computeWorkspaceAdmission } = await import("./workspaceAdmissionCore")
    return computeWorkspaceAdmission(input, meshRustRuntime().state)
  }
  const result = await runPolicyRequest(input, "admission")
  if (typeof result === "string") throw new Error("Workspace admission response has the wrong type")
  return result
}

export async function runWorkspaceAccess(input: WorkspaceAccessInput, diagnosticsEnabled = false): Promise<WorkspaceRole> {
  const result = await runPolicyRequest(input, "access", diagnosticsEnabled)
  if (typeof result !== "string") throw new Error("Workspace access response has the wrong type")
  return result
}

async function runPolicyRequest(input: WorkspaceAdmissionInput | WorkspaceAccessInput,
  kind: "admission" | "access", diagnosticsEnabled = false): Promise<PolicyResult> {
  await warmWorkspaceAdmissionWorker()
  return new Promise<PolicyResult>((resolve, reject) => {
    const id = ++nextId
    try {
      const target = worker
      if (!target) throw new Error("Workspace admission worker is unavailable")
      const timer = setTimeout(() => failWorker(target, new Error("Workspace admission worker timed out")), admissionDeadlineMs)
      pending.set(id, { resolve, reject, timer })
      const request: WorkspaceAdmissionRequest = kind === "access"
        ? { id, kind, input: input as WorkspaceAccessInput, diagnosticsEnabled }
        : { id, input: input as WorkspaceAdmissionInput }
      const buffers = (request.kind === "access" ? [request.input.snapshot.document.buffer]
        : [request.input.remote.buffer, ...(request.input.local ? [request.input.local.buffer] : [])]) as ArrayBuffer[]
      target.postMessage(request, buffers)
    } catch (cause) {
      const job = pending.get(id)
      if (job) { clearTimeout(job.timer); pending.delete(id) }
      reject(cause instanceof Error ? cause : new Error(String(cause)))
    }
  })
}
