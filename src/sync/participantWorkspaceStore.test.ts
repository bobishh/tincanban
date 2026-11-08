import { expect, test, vi } from "vitest"
import { participantWorkspaceSession } from "./participantWorkspaceStore"
import { clearMeshTrace, meshTraceSnapshot } from "./meshTrace"

vi.mock("./workspaceSet", () => ({ liveAutomergeWorkspaceSync: () => ({
  done: new Promise(() => {}), close: async () => {}, publish: async () => {},
}) }))
vi.mock("./durablePeerHistoryGuard", () => ({ createDurablePeerHistoryGuard: () => async () => {} }))
vi.mock("./workspaceRustyExchange", () => ({ withWorkspaceRustyAccess: () => ({
  prepareRustyAccess: async () => ({ changed: false, failures: [new Error("Rusty access preparation failed", {
    cause: new Error("Workspace scope authority is required before sharing Rusty storage"),
  })] }),
}) }))

test("Given storage access preparation fails inside an admitted peer session, when retry is retained, then diagnostics expose its cause as a failure", async () => {
  clearMeshTrace()
  const live = participantWorkspaceSession({} as never, { workspaceId: "board", deviceId: "guest-device",
    remotePersonId: "guest", profile: { identity: { personId: "owner" }, device: { deviceId: "owner-device" } } } as never, false, {} as never, undefined, {})
  live.maintenance.start()
  try {
    await vi.waitFor(() => expect(meshTraceSnapshot()).toContainEqual(expect.objectContaining({
      event: "rusty.access.preparation.failed", workspaceId: "board", peerId: "guest-device",
      reason: "Workspace scope authority is required before sharing Rusty storage",
    })))
  } finally { await live.session.close() }
})
