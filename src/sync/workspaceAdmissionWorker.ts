import policyInit, { WasmStateCore } from "@meta-uber/mesh-transport/wasm"
import { initializeAutomerge } from "../crdt"
import { computeWorkspaceAdmission } from "../product-replica"
import type { WorkspaceAdmissionRequest, WorkspaceAdmissionResponse } from "./workspaceAdmissionWorkerContract"
import { decideWorkspaceAccessInWorker } from "./workspaceAccessWorker"

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkspaceAdmissionRequest>) => void) | null
  postMessage(response: WorkspaceAdmissionResponse): void
}
const ready = Promise.all([initializeAutomerge(), policyInit()])
void ready.then(
  () => scope.postMessage({ type: "ready" }),
  error => scope.postMessage({ type: "initialization-error", error: error instanceof Error ? error.message : String(error) }),
)
let queue = Promise.resolve()
scope.onmessage = event => {
  queue = queue.then(() => handleAdmission(event.data)).catch(() => undefined)
}

async function handleAdmission(request: WorkspaceAdmissionRequest) {
  const { id } = request
  try { await ready }
  catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error), fatal: true })
    return
  }
  if (request.kind === "access") {
    scope.postMessage(await decideWorkspaceAccessInWorker(request, ready.then(([, wasm]) => wasm)))
    return
  }
  let response: WorkspaceAdmissionResponse
  try {
    response = { id, result: computeWorkspaceAdmission({ ...request.input, now: Date.now() }, WasmStateCore) }
  } catch (error) {
    response = { id, error: error instanceof Error ? error.message : String(error) }
  }
  scope.postMessage(response)
}
