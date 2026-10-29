import { beforeEach, expect, it } from "vitest"
import { applyReleaseObservation, assertClientReleaseWritable, releaseState, resetReleaseStateForTest } from "./runtimeRelease"

beforeEach(resetReleaseStateForTest)

function cohort(minimumWriterVersion = 2) {
  return { kind: "tincanban-release-cohort", version: 1, cohortId: "a".repeat(64),
    components: { frontend: { sourceSha: "b".repeat(40), candidateId: "next-build", artifactSha256: "b".repeat(64) } },
    contract: { minimumWriterVersion, readers: { frontend: { identityDevice: 1, privateReplicas: 4, workspaceSnapshot: 1 } } } }
}
it("Given a newer incompatible cohort, when this tab observes it, then retain data and block writes while allowing verified reads", () => {
  applyReleaseObservation(cohort(3), "a".repeat(40))
  expect(releaseState.value.status).toBe("upgrade-required")
  expect(() => assertClientReleaseWritable("workspace-changes")).toThrow(/update|required/i)
  expect(() => assertClientReleaseWritable("blob-request")).not.toThrow()
})
it("Given newer assets with the same reader contract, when the tab checks release state, then offer reload without claiming this device upgraded", () => {
  applyReleaseObservation(cohort(), "a".repeat(40))
  expect(releaseState.value.status).toBe("update-available")
  expect(releaseState.value.acknowledgedArtifact).toBeNull()
  expect(() => assertClientReleaseWritable("workspace-changes")).not.toThrow()
})
it("Given the running commit matches the active artifact, when observed, then acknowledge this tab even when the CI candidate differs", () => {
  applyReleaseObservation(cohort(), "b".repeat(40))
  expect(releaseState.value.status).toBe("current")
  expect(releaseState.value.acknowledgedArtifact).toBe("b".repeat(64))
})

it("Given a higher observed writer floor, when an older edge response arrives, then retain the upgrade barrier", () => {
  applyReleaseObservation(cohort(3), "a".repeat(40))
  applyReleaseObservation(cohort(2), "a".repeat(40))
  expect(releaseState.value.status).toBe("upgrade-required")
})
