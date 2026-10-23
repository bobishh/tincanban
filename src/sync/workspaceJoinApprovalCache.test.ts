import { afterEach, expect, it, vi } from "vitest"
import { createWorkspaceJoinApprovalCache, type PendingJoinApproval } from "./workspaceJoinApprovalCache"

const approval = (): PendingJoinApproval => ({ personId: "person-a", invitationId: "invite-a",
  expiresAt: new Date(Date.now() + 5_000).toISOString(), workspaceIds: ["workspace-a", "workspace-b"],
  deviceId: "device-a", role: "editor" })

afterEach(() => vi.useRealTimers())

it("Given a pending join approval, when identity, device, invite or scope changes, then approval cannot be reused", () => {
  const cache = createWorkspaceJoinApprovalCache()
  const saved = approval()
  cache.set(saved)

  expect(cache.get({ ...saved, personId: "person-b" })).toBeUndefined()
  cache.set(saved)
  expect(cache.get({ ...saved, deviceId: "device-b" })).toBeUndefined()
  cache.set(saved)
  expect(cache.get({ ...saved, invitationId: "invite-b" })).toBeUndefined()
  cache.set(saved)
  expect(cache.get({ ...saved, workspaceIds: ["workspace-a"] })).toBeUndefined()
  cache.clear()
})

it("Given an approved join awaiting snapshot preparation, when invite expires or host stops, then approval is evicted", () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-23T09:00:00.000Z"))
  const cache = createWorkspaceJoinApprovalCache()
  const saved = { ...approval(), expiresAt: new Date(Date.now() + 1_000).toISOString() }
  cache.set(saved)
  expect(cache.get(saved)).toMatchObject({ personId: saved.personId, role: "editor" })
  vi.advanceTimersByTime(1_000)
  expect(cache.get(saved)).toBeUndefined()

  const next = { ...saved, expiresAt: new Date(Date.now() + 1_000).toISOString() }
  cache.set(next)
  cache.clear()
  expect(cache.get(next)).toBeUndefined()
})
