import { beforeEach, expect, it, vi } from "vitest"

const ports = vi.hoisted(() => ({
  events: [] as string[],
  storage: {
    listWorkspaceCatalog: vi.fn(async () => { ports.events.push("catalog"); return { available: [], archived: [] } }),
    loadPersonalRoot: vi.fn(async () => null),
  },
  bootstrap: vi.fn(async () => ({ identity: { personId: "person" }, device: { deviceId: "device" } })),
  resume: vi.fn(async () => { ports.events.push("projection") }),
}))
vi.mock("./storage", () => ({ defaultStorage: ports.storage }))
vi.mock("./crdt", () => ({ initializeAutomerge: vi.fn() }))
vi.mock("./domain/identity", () => ({ bootstrapIdentity: ports.bootstrap }))
vi.mock("./sync/startupDiagnostics", () => ({
  diagnoseStartupStep: async (_name: string, step: () => unknown) => step(),
  setStartupDiagnosticDevice: vi.fn(),
}))
vi.mock("./sync/workspaceHistoryRecoveryProjection", () => ({ resumeWorkspaceHistoryRecoveryProjection: ports.resume }))

import { prepareLocalState } from "./statePersistence"

beforeEach(() => {
  ports.events.length = 0
  vi.clearAllMocks()
})

it("Given a durable identity with pending private recovery, when preparing local state, then resume projection before reading workspace catalog", async () => {
  await prepareLocalState(ports.storage as never)
  expect(ports.resume).toHaveBeenCalledWith("person", expect.any(Function))
  expect(ports.events).toEqual(["projection", "catalog"])
})
