import { describe, expect, it } from "vitest"
import { parseReplicaWriterWorkers } from "./replicaWriterWorkersState"

const workspaceId = "workspace-1"
const route = (integrationId = "integration-1", overrides: Record<string, unknown> = {}) => ({
  origin: "https://automation.example.test", workspaceId, definitionId: "typed-definition",
  executorPersonId: "executor-person", integrationId, ...overrides,
})

describe("replica writer route journal parser", () => {
  it("returns detached route records and accepts the bounded 64-worker cohort", () => {
    const input = Array.from({ length: 64 }, (_, index) => route(`integration-${index}`))
    const parsed = parseReplicaWriterWorkers(input, workspaceId)
    expect(parsed).toHaveLength(64)
    expect(parsed[0]).toEqual(route("integration-0"))
    ;(input[0] as { origin: string }).origin = "https://changed.example.test"
    expect(parsed[0]!.origin).toBe("https://automation.example.test")
  })

  it("rejects oversized cohorts and exact duplicate routes", () => {
    expect(() => parseReplicaWriterWorkers(Array.from({ length: 65 }, (_, index) => route(`route-${index}`)), workspaceId))
      .toThrow(/cohort/i)
    expect(() => parseReplicaWriterWorkers([route(), route()], workspaceId)).toThrow(/duplicated/i)
  })

  it("rejects non-route secrets and extra persisted fields", () => {
    for (const key of ["grantId", "readToken", "writeToken", "contentKey", "privateKey", "servicePublicKey"]) {
      expect(() => parseReplicaWriterWorkers([route("integration-1", { [key]: "secret" })], workspaceId)).toThrow()
    }
  })

  it("rejects route substitution, invalid origins, malformed IDs and whitespace", () => {
    for (const item of [
      route("integration-1", { workspaceId: "other-workspace" }),
      route("integration-1", { workspaceId: " workspace-1 " }),
      route("integration-1", { origin: "http://automation.example.test" }),
      route("integration-1", { origin: "https://automation.example.test/path" }),
      route("integration-1", { origin: "https://user:secret@automation.example.test" }),
      route("bad id"),
      route("integration-1", { definitionId: "bad id" }),
      route("integration-1", { executorPersonId: "" }),
      route("integration-1", { executorPersonId: "   " }),
      route("integration-1", { executorPersonId: " executor-person " }),
      route("integration-1", { executorPersonId: "x".repeat(257) }),
    ]) {
      expect(() => parseReplicaWriterWorkers([item], workspaceId)).toThrow()
    }
    expect(() => parseReplicaWriterWorkers([], " workspace-1 ")).toThrow()
  })

  it("rejects a route object with an untrusted prototype", () => {
    const inherited = Object.assign(Object.create({ token: "secret" }) as Record<string, unknown>, route())
    expect(() => parseReplicaWriterWorkers([inherited], workspaceId)).toThrow()
  })
})
