import { computed, ref } from "vue"
import { expect, it, vi } from "vitest"
import { useAppActions } from "./useAppActions"
import type { useAppCore } from "./useAppCore"
import type { useAppBoard } from "./useAppBoard"

function fixture() {
  const selectedItemId = ref<string | null>(null), selectedLeadId = ref<string | null>("lead")
  const executeCommandAsync = vi.fn().mockResolvedValue(undefined), readArchivedItemVersion = vi.fn()
  const core = { selectedItemId, selectedLeadId, historyRestoreSaving: ref(false), historyRestoreError: ref(""), historyRestoreNotice: ref(""),
    tincanban: { activeWorkspace: { id: "workspace" }, executeCommandAsync } } as unknown as ReturnType<typeof useAppCore>
  const board = { selectedHistoryItemId: computed(() => selectedItemId.value ?? selectedLeadId.value), readArchivedItemVersion } as unknown as ReturnType<typeof useAppBoard>
  return { core, selectedLeadId, executeCommandAsync, readArchivedItemVersion, actions: useAppActions(core, board) }
}

it("Given an open job-search lead and an archived version, when restoring, then restore that lead with archived evidence", async () => {
  const f = fixture()
  const archived = { baselineId: "baseline", historyEpoch: 2, observation: "admitted", item: { id: "lead" } }
  f.readArchivedItemVersion.mockResolvedValue(archived)
  await f.actions.restoreSelectedItemVersion("original")
  expect(f.executeCommandAsync).toHaveBeenCalledWith({ kind: "restoreItemVersion", entityId: "lead", changeHash: "original", archived })
  expect(f.core.historyRestoreNotice.value).toBe("Version restored")
  expect(f.core.historyRestoreSaving.value).toBe(false)
})

it("Given a pending archived lead version, when another lead is selected, then never restore into the changed selection", async () => {
  const f = fixture()
  let complete!: (value: undefined) => void
  f.readArchivedItemVersion.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  const pending = f.actions.restoreSelectedItemVersion("original")
  f.selectedLeadId.value = "other-lead"
  complete(undefined)
  await pending
  expect(f.executeCommandAsync).not.toHaveBeenCalled()
  expect(f.core.historyRestoreError.value).toContain("History selection changed")
  expect(f.core.historyRestoreSaving.value).toBe(false)
})
