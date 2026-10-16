import { WasmStateCore } from "@meta-uber/mesh-transport/wasm"
import type { AccessWorkerRequest } from "./workspaceAccessInput"
import { diagnoseStartupStep } from "./startupDiagnostics"
import type { WorkspaceRole } from "../domain/permissions"

export async function decideWorkspaceAccessInWorker(data: AccessWorkerRequest, runtime: Promise<{ memory: WebAssembly.Memory }>) {
  const diagnose = data.diagnosticsEnabled ? diagnoseStartupStep : async <T>(_stage: string, step: () => T | Promise<T>) => step()
  const detail = { workspaceId: data.input.snapshot.workspaceId, bytes: 0 }
  let wasm: { memory: WebAssembly.Memory }
  try {
    wasm = await diagnose("access-worker-wasm", async () => {
      const wasm = await runtime
      detail.bytes = wasm.memory.buffer.byteLength
      return wasm
    }, detail)
    detail.bytes = wasm.memory.buffer.byteLength
  } catch (error) {
    return { id: data.id, error: String(error), fatal: true }
  }
  try {
    const input = await diagnose("access-worker-decode", () => ({ ...data.input,
      snapshot: { ...data.input.snapshot, document: Array.from(data.input.snapshot.document) } }),
    { workspaceId: detail.workspaceId, bytes: data.input.snapshot.document.byteLength })
    const role = await diagnose("access-worker-decide", () => {
      const result = WasmStateCore.decideWorkspaceAccess(input, Date.now()) as WorkspaceRole
      detail.bytes = wasm.memory.buffer.byteLength
      return result
    }, detail)
    return { id: data.id, role }
  } catch (error) {
    return { id: data.id, error: error instanceof Error ? error.message : String(error) }
  }
}
