import { offlineRetryDelay } from "./offlineRetry"
import type { ScopedInvitation } from "@meta-uber/mesh-pairing"
import { userMessage, type DeviceSyncState } from "./deviceSyncState"
import { record } from "./telemetry"
import type { connectWorkspaceJoin as ConnectWorkspaceJoin } from "./workspaceJoinBrowserFlow"

type WorkspaceJoinInvite = Extract<ScopedInvitation, { kind: "workspace-join" }>

export async function connectWorkspaceJoin(...args: Parameters<typeof ConnectWorkspaceJoin>) {
  while (args[0].currentRun() === args[1] && !navigator.onLine) {
    args[0].state.step.value = "workspace-reconnecting"
    await args[0].waitToReconnect(offlineRetryDelay(1))
  }
  if (args[0].currentRun() !== args[1]) return
  const module = await import("./workspaceJoinBrowserFlow")
  if (args[0].currentRun() !== args[1]) return
  return module.connectWorkspaceJoin(...args)
}

export function isWorkspacePairingLocation(rawUrl: string, prepare: (url: string) => void) {
  const url = new URL(rawUrl)
  const pairing = url.pathname.replace(/\/$/, "") === "/pair"
  try { record("pairing.route.checked", { phase: pairing ? "pairing" : "ordinary", mode: url.hash ? "fragment_present" : "fragment_absent" }) }
  catch { /* Route diagnostics never change invitation admission. */ }
  if (!pairing || !url.hash) return false
  prepare(rawUrl)
  return true
}


export function reportWorkspaceJoinFailure(state: DeviceSyncState, currentRun: number, run: number, invite: WorkspaceJoinInvite, error: unknown) {
  if (run !== currentRun) return
  state.directLive.value = false
  state.step.value = "error"
  if (/access revoked/i.test(error instanceof Error ? error.message : String(error))) {
    state.revokedWorkspaceIds.value = [...new Set([...state.revokedWorkspaceIds.value, ...invite.workspaces.map(item => item.id)])]
  }
  console.error("Workspace sync failed", error)
  state.error.value = userMessage(error, "Couldn’t save the received workspaces.")
}
