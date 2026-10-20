import { expect, it } from "vitest"
import { continueMyDeviceRemoval, type MyDeviceRemoval } from "./myDeviceRemoval"

it("Given two Rusty origins and an offline server, when removing my device and reloading, then retain target and per-origin failure and retry only unfinished work", async () => {
  let saved: MyDeviceRemoval = { version: 1, personId: "me", signerDeviceId: "current", deviceId: "old", name: "JoyfulPapaya", workspaces: { board: "pending" }, origins: { online: { status: "pending" }, offline: { status: "pending" } } }
  const calls: string[] = []
  const ports = { ensureCurrent: () => {}, save: async (job: MyDeviceRemoval) => { saved = structuredClone(job) }, removeWorkspaces: async () => { calls.push("board") }, revokeOrigin: async (origin: string) => { calls.push(origin); if (origin === "offline") throw new Error("Offline") } }
  await continueMyDeviceRemoval(saved, ports)
  expect(saved.origins.online.status).toBe("removed")
  expect(saved.origins.offline).toEqual({ status: "pending", error: "Offline" })
  expect(saved.workspaces.board).toBe("removed")
  await continueMyDeviceRemoval(structuredClone(saved), { ...ports, revokeOrigin: async origin => { calls.push(origin) } })
  expect(calls).toEqual(["board", "online", "offline", "offline"])
  expect(saved.origins.offline.status).toBe("removed")
})

it("Given changed identity authority, when resuming removal, then no revocation or success mutation occurs", async () => {
  const job: MyDeviceRemoval = { version: 1, personId: "me", signerDeviceId: "current", deviceId: "old", name: "Old", workspaces: {}, origins: { server: { status: "pending" } } }
  await expect(continueMyDeviceRemoval(job, { ensureCurrent: () => { throw new Error("Identity changed") }, save: async () => { throw new Error("Must not save") }, removeWorkspaces: async () => { throw new Error("Must not remove") }, revokeOrigin: async () => { throw new Error("Must not revoke") } })).rejects.toThrow("Identity changed")
})

it("Given the first workspace is denied and the second succeeds, when removal continues, then retain the first workspace's exact required action", async () => {
  let saved: MyDeviceRemoval = { version: 1, personId: "me", signerDeviceId: "current", deviceId: "old", name: "Old", workspaces: { denied: "pending", allowed: "pending" }, origins: {} }
  await continueMyDeviceRemoval(saved, { ensureCurrent: () => {}, save: async job => { saved = structuredClone(job) }, removeWorkspaces: async ids => { if (ids[0] === "denied") throw new Error("Only the board owner can remove this device") }, revokeOrigin: async () => {} })
  expect(saved.workspaces).toEqual({ denied: "pending", allowed: "removed" })
  expect(saved.workspaceErrors?.denied).toBe("Only the board owner can remove this device")
})
