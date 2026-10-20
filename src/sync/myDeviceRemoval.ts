export type MyDeviceRemoval = { version: 1; personId: string; signerDeviceId: string; deviceId: string; name: string;
  workspaces: Record<string, "pending" | "removed">; workspaceTitles?: Record<string, string>; workspaceErrors?: Record<string, string>;
  origins: Record<string, { status: "pending" | "removed"; error?: string }> }
type RemovalPorts = { ensureCurrent: () => void; save: (job: MyDeviceRemoval) => Promise<void>;
  removeWorkspaces: (ids: string[]) => Promise<void>; revokeOrigin: (origin: string) => Promise<void> }
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

export function myDeviceRemovalComplete(job: MyDeviceRemoval): boolean {
  return !Object.keys(job.workspaceErrors ?? {}).length && Object.values(job.workspaces).every(state => state === "removed") &&
    Object.values(job.origins).every(state => state.status === "removed")
}
