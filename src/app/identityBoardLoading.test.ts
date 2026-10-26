import { beforeEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, clearInMemoryProfileForReloadTest, resetIdentityStorageForTest } from "../domain/identity"
import { beginIdentityBoardLoading, confirmIdentityCatalogInstalled, hasPendingIdentityBoardLoading,
  IdentityCatalogApprovalRequired, resumeIdentityBoardLoading } from "./identityBoardLoading"

const f = vi.hoisted(() => ({ loadBoards: vi.fn() }))
vi.mock("./loadIdentityBoards", () => ({ loadIdentityBoards: f.loadBoards }))
beforeEach(() => { resetIdentityStorageForTest(); vi.clearAllMocks() })

it("Given unavailable catalog access, when the approved profile reloads, then preserve pending access without pretending its catalog is empty", async () => {
  const profile = await bootstrapIdentity("Approved app")
  await beginIdentityBoardLoading(profile)
  clearInMemoryProfileForReloadTest()
  const restored = await bootstrapIdentity()
  await expect(resumeIdentityBoardLoading({ getCurrentProfile: () => restored } as never)).rejects.toBeInstanceOf(IdentityCatalogApprovalRequired)
  expect(await hasPendingIdentityBoardLoading(restored)).toBe(true)
  expect(f.loadBoards).not.toHaveBeenCalled()
})

it("Given installed catalog access and an interrupted pull, when reloaded and retried, then resume without another Identity approval", async () => {
  let profile = await bootstrapIdentity("Approved app")
  await confirmIdentityCatalogInstalled(profile, await beginIdentityBoardLoading(profile))
  const app = { getCurrentProfile: () => profile }
  f.loadBoards.mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(undefined)
  await expect(resumeIdentityBoardLoading(app as never)).rejects.toThrow("Offline")
  clearInMemoryProfileForReloadTest()
  profile = await bootstrapIdentity()
  expect(await hasPendingIdentityBoardLoading(profile)).toBe(true)
  await resumeIdentityBoardLoading(app as never, "/boards/original")
  expect(f.loadBoards).toHaveBeenLastCalledWith(app, "/boards/original")
  expect(await hasPendingIdentityBoardLoading(profile)).toBe(false)
})

it("Given a newer catalog approval while an old load completes, when acknowledging the old delivery, then keep the newer intent", async () => {
  const profile = await bootstrapIdentity("Approved app")
  await confirmIdentityCatalogInstalled(profile, await beginIdentityBoardLoading(profile))
  f.loadBoards.mockImplementationOnce(() => beginIdentityBoardLoading(profile))
  await resumeIdentityBoardLoading({ getCurrentProfile: () => profile } as never)
  expect(await hasPendingIdentityBoardLoading(profile)).toBe(true)
  await expect(resumeIdentityBoardLoading({ getCurrentProfile: () => profile } as never)).rejects.toBeInstanceOf(IdentityCatalogApprovalRequired)
})
