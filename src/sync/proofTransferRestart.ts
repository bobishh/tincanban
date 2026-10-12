import { MeshNetworkError } from "@meta-uber/mesh-transport"
import type { SyncConnection } from "./transport"
import { meshTrace } from "./meshTrace"

function requiresRestart(error: unknown): boolean {
  const message = error instanceof Error ? error.message : error
  return message === "Authorization authority changed; restart document sync" ||
    message === "Authorization records changed; restart document sync" ||
    message === "Authorization record identity mode changed; restart document sync" ||
    message === "No document awaiting authorization pages"
}

/** A fresh session must obtain current proofs; stale transfers cannot advance. */
export function createProofTransferRestarter(connection: SyncConnection, context: { workspaceId: string; peerId: string }) {
  let restarting = false
  return async (error: unknown): Promise<void> => {
    if (!requiresRestart(error)) return
    if (!restarting) {
      restarting = true
      meshTrace("mesh.document.proof.restart", { ...context, phase: "fresh_authorization", errorCode: "authorization_transfer_restart" }, "warn", error)
      await connection.close()
    }
    throw new MeshNetworkError("Authorization changed during transfer; reconnect for fresh proofs", { cause: error })
  }
}
