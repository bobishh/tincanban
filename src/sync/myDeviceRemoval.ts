import type { MyDeviceRemoval } from "./myDeviceRemovalState"
export { myDeviceRemovalComplete, myDeviceRemovalsKey, type MyDeviceRemoval } from "./myDeviceRemovalState"

type RemovalPorts = { ensureCurrent: () => void; save: (job: MyDeviceRemoval) => Promise<void>;
  removeWorkspaces: (ids: string[]) => Promise<void>; revokeOrigin: (origin: string) => Promise<void> }

/** Explicit reset abandons only this server phase; no access is marked revoked. */
export function withoutDeviceRemovalOrigin(jobs: MyDeviceRemoval[], personId: string, origin: string): MyDeviceRemoval[] {
  return jobs.flatMap(job => {
    if (job.personId !== personId || !Object.hasOwn(job.origins, origin)) return [job]
    const next = structuredClone(job)
    delete next.origins[origin]
    return Object.keys(next.workspaces).length || Object.keys(next.origins).length ? [next] : []
  })
}

export async function continueMyDeviceRemoval(initial: MyDeviceRemoval, ports: RemovalPorts): Promise<void> {
  ports.ensureCurrent()
  const job = structuredClone(initial)
  const save = async () => { ports.ensureCurrent(); await ports.save(structuredClone(job)); ports.ensureCurrent() }
  const ids = Object.keys(job.workspaces).filter(id => job.workspaces[id] !== "removed")
  for (const id of ids) {
    ports.ensureCurrent()
    try { await ports.removeWorkspaces([id]); ports.ensureCurrent(); job.workspaces[id] = "removed"; if (job.workspaceErrors) delete job.workspaceErrors[id] }
    catch (cause) { ports.ensureCurrent(); (job.workspaceErrors ??= {})[id] = cause instanceof Error ? cause.message : "Workspace removal pending" }
    await save()
  }
  for (const [origin, state] of Object.entries(job.origins)) {
    ports.ensureCurrent()
    if (state.status === "removed") continue
    try { await ports.revokeOrigin(origin); ports.ensureCurrent(); job.origins[origin] = { status: "removed" } }
    catch (cause) { ports.ensureCurrent(); job.origins[origin] = { status: "pending", error: cause instanceof Error ? cause.message : "Rusty removal pending" } }
    await save()
  }
}
