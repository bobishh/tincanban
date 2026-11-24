import { peerStore, type PeerStore } from "./peerStore"
import type { RouteOperation, RouteResult, RouteResults, RouteWorkerRequest, RouteWorkerResponse } from "./identityWorkspaceRouteWorkerContract"

type Job = { resolve(value: RouteResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
let worker: Worker | undefined
let requestId = 0
const jobs = new Map<number, Job>()

function fail(target: Worker, error: Error) {
  if (worker !== target) return
  target.terminate()
  worker = undefined
  for (const job of jobs.values()) {
    clearTimeout(job.timer)
    job.reject(error)
  }
  jobs.clear()
}

function getWorker() {
  if (worker) return worker
  const target = new Worker(new URL("./identityWorkspaceRouteWorker.ts", import.meta.url),
    { type: "module", name: "identity-workspace-routes" })
  worker = target
  target.onmessage = ({ data }: MessageEvent<RouteWorkerResponse>) => {
    if ("error" in data && data.fatal) { fail(target, new Error(data.error)); return }
    const job = jobs.get(data.id)
    if (!job) return
    jobs.delete(data.id)
    clearTimeout(job.timer)
    if ("error" in data) job.reject(new Error(data.error))
    else job.resolve(data.result)
  }
  target.onerror = event => { event.preventDefault(); fail(target, new Error(`Identity routes worker failed: ${event.message}`)) }
  target.onmessageerror = () => fail(target, new Error("Identity routes result could not be decoded"))
  return target
}

export async function runIdentityWorkspaceRoutes<Request extends RouteOperation>(operation: Request,
  store: PeerStore = peerStore): Promise<RouteResults[Request["kind"]]> {
  if (typeof window === "undefined") {
    const { processIdentityWorkspaceRoutes } = await import("./identityWorkspaceRouteCatalog")
    return structuredClone(await processIdentityWorkspaceRoutes(operation, store)) as RouteResults[Request["kind"]]
  }
  const target = getWorker()
  return new Promise<RouteResult>((resolve, reject) => {
    const id = ++requestId
    const timer = setTimeout(() => fail(target, new Error("Identity routes worker timed out")), 60_000)
    jobs.set(id, { resolve, reject, timer })
    const request: RouteWorkerRequest = { id, operation, ...(store !== peerStore ? { databaseName: store.databaseName } : {}) }
    try { target.postMessage(request) }
    catch (error) { fail(target, error instanceof Error ? error : new Error(String(error))) }
  }) as Promise<RouteResults[Request["kind"]]>
}


export async function warmIdentityWorkspaceRoutes(): Promise<void> {
  await runIdentityWorkspaceRoutes({ kind: "warm" })
}
