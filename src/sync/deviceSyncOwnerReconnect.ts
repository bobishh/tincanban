import { meshTrace } from "./meshTrace"
import type { createDeviceSyncOwnerReconnect as createSession } from "./deviceSyncOwnerReconnectSession"
import type { OwnerReconnectInvitation } from "@meta-uber/mesh-pairing"
export type { OwnerReconnectAdapter } from "./deviceSyncOwnerReconnectSession"

type Session = ReturnType<typeof createSession>

/** Keep optional owner exchange out of board startup; closing Sync never downloads it. */
export function createDeviceSyncOwnerReconnect(options: Parameters<typeof createSession>[0]) {
  let session: Session | undefined
  let loading: Promise<Session> | undefined
  const load = () => loading ??= import("./deviceSyncOwnerReconnectSession").then(module => {
    session = module.createDeviceSyncOwnerReconnect(options)
    return session
  })
  return {
    async startHost() {
      options.state.step.value = "owner-reconnect-preparing"
      try { await (await load()).startHost() }
      catch (cause) {
        meshTrace("owner.reconnect.load.failed", { errorType: cause instanceof Error ? cause.name : "unknown" })
        options.state.step.value = "error"
        options.state.error.value = "Owner reconnect could not load. Reload the app and try again."
      }
    },
    connect: async (invitation: OwnerReconnectInvitation) => (await load()).connect(invitation),
    approve: () => session?.approve(),
    cancel: async () => { await session?.cancel() },
    close: async () => { await session?.close() },
  }
}
