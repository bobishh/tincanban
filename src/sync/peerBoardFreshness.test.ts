import { expect, it, vi } from "vitest"
import { createPeerBoardChecks } from "./peerBoardFreshness"
import { replicaConfirmationLifetime } from "./replicationHealth"

const board = "board", peer = "peer"
const source = { workspaceId: board, deviceId: peer, online: true }
const ensureCurrent = async () => {}

it("Given a live peer, when it reports a frontier, then confirm only after the saved board covers it", async () => {
  const covers = vi.fn(async () => false)
  const checks = createPeerBoardChecks(covers)
  const status = (now = Date.now()) => checks.status(board, [source], now)
  expect(status().phase).toBe("checking")
  await checks.observe(board, peer, ["missing"], ensureCurrent)
  expect(status().phase).toBe("checking")

  covers.mockResolvedValueOnce(true)
  await checks.observe(board, peer, ["saved"], ensureCurrent)
  const confirmed = status()
  expect(confirmed.phase).toBe("checked")
  expect(status(Date.now() + replicaConfirmationLifetime + 1).phase).toBe("overdue")
  expect(checks.status(board, [{ ...source, online: false }], Date.now()).phase).toBe("unavailable")
  expect(checks.status("other-board", [source], Date.now()).phase).toBe("unknown")
})

it("Given a pending peer observation, when its binding is reset or a newer frontier arrives, then ignore the old confirmation", async () => {
  const first = Promise.withResolvers<boolean>()
  const second = Promise.withResolvers<boolean>()
  const covers = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(false)
  const checks = createPeerBoardChecks(covers)
  const status = () => checks.status(board, [source], Date.now())
  const oldBinding = checks.observe(board, peer, ["old-binding"], ensureCurrent)
  checks.reset()
  first.resolve(true)
  await oldBinding
  expect(status().phase).toBe("checking")

  const oldFrontier = checks.observe(board, peer, ["old-frontier"], ensureCurrent)
  await checks.observe(board, peer, ["new-frontier"], ensureCurrent)
  second.resolve(true)
  await oldFrontier
  expect(status().phase).toBe("checking")
})
