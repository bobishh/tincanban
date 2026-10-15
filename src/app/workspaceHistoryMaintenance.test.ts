import { createSSRApp } from "vue"
import { renderToString } from "@vue/server-renderer"
import { expect, it } from "vitest"
import WorkspaceHistoryMaintenance from "../components/WorkspaceHistoryMaintenance.vue"
import type { BlindReplicationController } from "./blindReplication"
import { clearReplicationSessionState, createReplicationState } from "../sync/privateReplicationState"

it("Given completed history for one workspace, when another workspace opens, then hide the unrelated completion", async () => {
  const state = createReplicationState()
  state.historyNotices.value.board = "Older history archived. Previous versions remain available."
  const controller = { ...state, compactWorkspaceHistory: async () => {} } as unknown as BlindReplicationController
  const render = (workspaceId: string) => renderToString(createSSRApp(WorkspaceHistoryMaintenance, { controller, workspaceId, owner: true }))
  expect(await render("board")).toContain("Older history archived.")
  expect(await render("other")).not.toContain("Older history archived.")
  clearReplicationSessionState(state)
  expect(await render("board")).not.toContain("Older history archived.")
})
