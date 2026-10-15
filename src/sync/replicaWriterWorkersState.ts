import { isAutomationOrigin } from "../domain/automationLifecycle"

export type ReplicaWriterWorker = { origin: string; workspaceId: string; definitionId: string; executorPersonId: string; integrationId: string }
const routeId = /^[A-Za-z0-9_-]{1,128}$/

function parseWorkerRoute(value: unknown, workspaceId: string): ReplicaWriterWorker {
  if (!isRouteObject(value)) throw new Error("Invalid writer upgrade Worker fields")
  const item = value
  const { origin, definitionId, executorPersonId, integrationId } = item
  if (!validRouteCoordinates(origin, item.workspaceId, definitionId, integrationId, workspaceId)) {
    throw new Error("Invalid writer upgrade Worker coordinates")
  }
  if (!validExecutor(executorPersonId)) throw new Error("Invalid writer upgrade Worker executor")
  return { origin: origin as string, workspaceId, definitionId: definitionId as string,
    executorPersonId, integrationId: integrationId as string }
}

function isRouteObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  const keys = Object.keys(value)
  return (prototype === Object.prototype || prototype === null) && keys.length === 5 &&
    keys.every(key => ["origin", "workspaceId", "definitionId", "executorPersonId", "integrationId"].includes(key))
}

function validRouteCoordinates(origin: unknown, itemWorkspaceId: unknown, definitionId: unknown, integrationId: unknown,
  workspaceId: string): boolean {
  return typeof origin === "string" && isAutomationOrigin(origin) && itemWorkspaceId === workspaceId &&
    typeof definitionId === "string" && routeId.test(definitionId) &&
    typeof integrationId === "string" && routeId.test(integrationId)
}

function validExecutor(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value === value.trim() && value.length <= 256
}

/** Keep only public, authenticated routing coordinates in the local migration journal. */
export function parseReplicaWriterWorkers(value: unknown, workspaceId: string): ReplicaWriterWorker[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error("Invalid writer upgrade Worker cohort")
  if (typeof workspaceId !== "string" || !workspaceId.trim() || workspaceId !== workspaceId.trim() || workspaceId.length > 256) {
    throw new Error("Invalid writer upgrade workspace")
  }
  const seen = new Set<string>()
  return value.map((item: unknown) => {
    const route = parseWorkerRoute(item, workspaceId)
    const key = JSON.stringify([route.origin, route.definitionId, route.executorPersonId, route.integrationId])
    if (seen.has(key)) throw new Error("Writer upgrade Worker scope is mismatched or duplicated")
    seen.add(key)
    return route
  })
}
