import { shallowRef } from "vue"
import { z } from "zod"
import supported from "../../release/readers.json" with { type: "json" }

type ReleaseState = { status: "unknown" | "current" | "update-available" | "upgrade-required";
  cohortId: string | null; acknowledgedArtifact: string | null }
export const releaseState = shallowRef<ReleaseState>({ status: "unknown", cohortId: null, acknowledgedArtifact: null })
const readers: Record<string, number> = supported.frontend
const writerVersion = supported.writerVersions.frontend
let retainedWriterFloor = 1
const retainedReaderFloors = new Map<string, number>()
const readPurposes = new Set(["blob-request", "attachment-read", "identity-device-recovery", "rusty-management-policy-status", "rusty-controller-proof", "workspace-record-proof"])

export function assertClientReleaseWritable(purpose: string): void {
  if (releaseState.value.status === "upgrade-required" && !readPurposes.has(purpose)) {
    throw new Error("Update required: this tab cannot write the active release contract. Reload to continue; local data is preserved.")
  }
}

const releaseFloor = z.number().int().positive().refine(Number.isSafeInteger)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const cohortSchema = z.object({
  kind: z.literal("tincanban-release-cohort"), version: z.literal(1), cohortId: digest,
  components: z.object({ frontend: z.object({ candidateId: z.string(), artifactSha256: digest }) }),
  contract: z.object({ minimumWriterVersion: releaseFloor,
    readers: z.object({ frontend: z.record(z.string(), releaseFloor).refine(value => Object.keys(value).length > 0) }) }),
})

export function applyReleaseObservation(value: unknown, runningCandidate: string): void {
  const result = cohortSchema.safeParse(value)
  if (!result.success) throw new Error("Invalid release compatibility metadata")
  const cohort = result.data
  const frontend = cohort.components.frontend
  const floor = cohort.contract.readers.frontend
  const minimumWriter = cohort.contract.minimumWriterVersion
  retainedWriterFloor = Math.max(retainedWriterFloor, Number(minimumWriter))
  for (const [schema, version] of Object.entries(floor)) retainedReaderFloors.set(schema, Math.max(retainedReaderFloors.get(schema) ?? 0, Number(version)))
  const incompatible = retainedWriterFloor > writerVersion || [...retainedReaderFloors].some(([schema, version]) =>
    (Object.hasOwn(readers, schema) ? readers[schema]! : 0) < version)
  const current = frontend.candidateId === runningCandidate
  releaseState.value = { status: incompatible ? "upgrade-required" : current ? "current" : "update-available",
    cohortId: cohort.cohortId, acknowledgedArtifact: current && !incompatible ? frontend.artifactSha256 : null }
}

/** A failed check cannot clear a previously observed upgrade barrier or erase local data. */
export function beginReleaseMonitor(): () => void {
  const candidate = typeof __TINCANBAN_RELEASE_CANDIDATE__ === "undefined" ? "dev" : __TINCANBAN_RELEASE_CANDIDATE__
  if (candidate === "dev") return () => {}
  let stopped = false
  let checking = false
  const check = async () => {
    if (stopped || checking || document.visibilityState === "hidden") return
    checking = true
    try {
      const response = await fetch("/release-cohort.json", { cache: "no-store", credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(10000) })
      if (!response.ok || stopped) return
      const bytes = await response.text()
      if (bytes.length > 2 * 1024 * 1024 || stopped) return
      applyReleaseObservation(JSON.parse(bytes), candidate)
    } catch { /* Offline tabs retain their last confirmed compatibility state. */ }
    finally { checking = false }
  }
  const visible = () => { void check() }
  document.addEventListener("visibilitychange", visible)
  const interval = setInterval(visible, 60000)
  void check()
  return () => { stopped = true; clearInterval(interval); document.removeEventListener("visibilitychange", visible) }
}

export function resetReleaseStateForTest() {
  retainedWriterFloor = 1
  retainedReaderFloors.clear()
  releaseState.value = { status: "unknown", cohortId: null, acknowledgedArtifact: null }
}
