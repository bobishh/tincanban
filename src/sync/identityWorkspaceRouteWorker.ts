import { initializePolicyBrowserRuntime } from "../iroh"
import { processIdentityWorkspaceRoutes } from "./identityWorkspaceRouteCatalog"
import { PeerStore } from "./peerStore"
import type { RouteWorkerRequest, RouteWorkerResponse } from "./identityWorkspaceRouteWorkerContract"

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<RouteWorkerRequest>) => void) | null
  postMessage(response: RouteWorkerResponse): void
}
const ready = initializePolicyBrowserRuntime()
void ready.catch(() => undefined)
let pending = Promise.resolve()

scope.onmessage = ({ data: { id, operation, databaseName } }) => {
  pending = pending.then(async () => {
    try { await ready }
    catch (error) { scope.postMessage({ id, error: String(error), fatal: true }); return }
    const store = databaseName === undefined ? undefined : new PeerStore(databaseName)
    try {
      scope.postMessage({ id, result: await processIdentityWorkspaceRoutes(operation, store) })
    } catch (error) {
      scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
    } finally { store?.close() }
  }).catch(() => undefined)
}
