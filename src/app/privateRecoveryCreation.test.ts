import { expect, it, vi } from "vitest"
import { createPrivateRecoveryForSelectedWorkspace } from "./privateRecoveryCreation"

it("Given backup creation starts before lazy loading and the board changes, when loading finishes, then export the original workspace and keep its scope beside its words", async () => {
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const profile = { identity: { personId: "identity" }, device: { deviceId: "device" }, certificate: { signature: "certificate" } }
  const core = { tincanban: { activeWorkspace: { id: "original-board", title: "Original board" }, getCurrentProfile: () => profile } }
  const create = vi.fn(async () => ({ file: new Blob(["encrypted"]), words: "specific file words", coverage: "complete" as const, missingCount: 0 }))
  const creating = createPrivateRecoveryForSelectedWorkspace(core as never, async () => { await gate; return { createPrivateWorkspaceRecovery: create } })
  core.tincanban.activeWorkspace = { id: "other-board", title: "Other board" }
  release()
  const result = await creating
  expect(create).toHaveBeenCalledWith(core, "original-board")
  expect(result).toMatchObject({ workspaceId: "original-board", workspaceTitle: "Original board", words: "specific file words" })
})

it("Given the identity changes during lazy loading, when backup creation resumes, then refuse before opening the workspace or using the new identity", async () => {
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let personId = "original-person"
  const core = { tincanban: { activeWorkspace: { id: "board", title: "Board" }, getCurrentProfile: () => ({ identity: { personId }, device: { deviceId: "device" }, certificate: { signature: "certificate" } }) } }
  const create = vi.fn()
  const creating = createPrivateRecoveryForSelectedWorkspace(core as never, async () => { await gate; return { createPrivateWorkspaceRecovery: create } })
  personId = "another-person"
  release()
  await expect(creating).rejects.toThrow("Identity changed")
  expect(create).not.toHaveBeenCalled()
})
