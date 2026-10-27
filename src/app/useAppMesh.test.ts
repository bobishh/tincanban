import { effectScope, ref } from "vue"
import { expect, test, vi } from "vitest"
import { useAppMesh } from "./useAppMesh"
vi.mock("../sync/workspaceParticipants", () => ({ readWorkspaceParticipants: async () => [
  { personId: "owner", role: "owner" }, { personId: "editor", role: "editor" },
] }))
test("Given a restored board retains participant access but no transport peers, when opening Sync, then show the other participant offline without inventing devices", async () => {
  const scope = effectScope()
  const input = { activeWorkspace: { id: "restored" }, currentRole: ref("owner"), currentWorkspaceOwnerId: ref("owner"),
    chat: { personId: ref("owner"), displayName: ref("Bo"), members: ref([
      { personId: "owner", name: "Bo" }, { personId: "editor", name: "Ray" }, { personId: "removed", name: "Removed person" },
    ]) },
    sync: { isOpen: ref(true), meshPeers: ref([]), localDeviceId: ref("owner-device"), localUserAgent: ref(""),
      meshRetryAt: ref({}), meshSuccession: ref([]), isEnabled: ref(true), networkOnline: ref(true),
      isWorkspaceLive: () => false, isWorkspaceAccessRevoked: () => false },
    blindReplication: { configs: ref([]), statuses: ref({}), now: ref(Date.now()) },
  } as unknown as Parameters<typeof useAppMesh>[0]
  try {
    const model = scope.run(() => useAppMesh(input))!
    await vi.waitFor(() => expect(model.meshMembers.value).toContainEqual(expect.objectContaining({
      personId: "editor", name: "Ray", role: "editor", online: false, devices: 0, deviceList: [],
    })))
    expect(model.meshMembers.value.some(person => person.personId === "removed")).toBe(false)
  } finally { scope.stop() }
})
