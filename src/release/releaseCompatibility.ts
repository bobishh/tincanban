import { z } from "zod"
import supported from "../../release/readers.json" with { type: "json" }

type ReleaseState = Readonly<{ status: "unknown" | "current" | "update-available" | "upgrade-required";
  cohortId: string | null; acknowledgedArtifact: string | null }>
let state: ReleaseState = Object.freeze({ status: "unknown", cohortId: null, acknowledgedArtifact: null })
const readers: Record<string, number> = supported.frontend
const writerVersion = supported.writerVersions.frontend
let retainedWriterFloor = 1
const retainedReaderFloors = new Map<string, number>()
const readPurposes = new Set(["blob-request", "attachment-read", "identity-device-recovery", "rusty-management-policy-status", "rusty-controller-proof", "workspace-record-proof"])

export function currentReleaseCompatibility(): ReleaseState { return state }

export function assertClientReleaseWritable(purpose: string): void {
  if (state.status === "upgrade-required" && !readPurposes.has(purpose)) {
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

export function observeReleaseCompatibility(value: unknown, runningCandidate: string): ReleaseState {
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
  state = Object.freeze({ status: incompatible ? "upgrade-required" : current ? "current" : "update-available",
    cohortId: cohort.cohortId, acknowledgedArtifact: current && !incompatible ? frontend.artifactSha256 : null })
  return state
}

export function resetReleaseCompatibilityForTest(): ReleaseState {
  retainedWriterFloor = 1
  retainedReaderFloors.clear()
  state = Object.freeze({ status: "unknown", cohortId: null, acknowledgedArtifact: null })
  return state
}
