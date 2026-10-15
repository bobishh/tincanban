import { expect, it, vi } from "vitest"
import type { LocalProfile } from "../domain/identity"
import type { WorkspaceSetStore } from "./workspaceSet"
import { lazyIdentityDevicePreferences } from "./lazyIdentityDevicePreferences"

const profile = { identity: { personId: "owner" } } as LocalProfile

it("Given the first private-preferences module load fails offline, when concurrent sync calls retry online, then share a fresh load and preserve successful initialization", async () => {
  const readMesh = vi.fn(async () => ({ received: true })), mergeMesh = vi.fn(async () => {})
  const withIdentityDevicePreferences = vi.fn(() => ({ readMesh, mergeMesh }) as unknown as WorkspaceSetStore)
  const module = { withIdentityDevicePreferences }
  let finish!: (value: typeof module) => void
  const online = new Promise<typeof module>(resolve => { finish = resolve })
  const load = vi.fn().mockRejectedValueOnce(new Error("Failed to fetch dynamically imported module"))
    .mockReturnValueOnce(online)
  const wrapped = lazyIdentityDevicePreferences({} as WorkspaceSetStore, profile, "owner", "remote", () => true, load)
  const offline = await Promise.allSettled([wrapped.readMesh!("board"), wrapped.mergeMesh!("board", {})])
  expect(offline.every(result => result.status === "rejected")).toBe(true)
  expect(load).toHaveBeenCalledOnce()
  const read = wrapped.readMesh!("board"), merge = wrapped.mergeMesh!("board", {})
  expect(load).toHaveBeenCalledTimes(2)
  finish(module)
  await expect(read).resolves.toEqual({ received: true })
  await merge
  await wrapped.readMesh!("board")
  expect(load).toHaveBeenCalledTimes(2)
  expect(withIdentityDevicePreferences).toHaveBeenCalledOnce()
})

it("Given a private module load is pending, when its same-person session loses authorization, then do not read or merge private state", async () => {
  let current = true, finish!: (value: { withIdentityDevicePreferences: () => WorkspaceSetStore }) => void
  const readMesh = vi.fn(), mergeMesh = vi.fn()
  const load = vi.fn(() => new Promise<{ withIdentityDevicePreferences: () => WorkspaceSetStore }>(resolve => { finish = resolve }))
  const wrapped = lazyIdentityDevicePreferences({} as WorkspaceSetStore, profile, "owner", "remote", () => current, load)
  const pending = wrapped.readMesh!("board")
  current = false
  finish({ withIdentityDevicePreferences: () => ({ readMesh, mergeMesh }) as unknown as WorkspaceSetStore })
  await expect(pending).rejects.toThrow(/session.*authorized/i)
  expect(readMesh).not.toHaveBeenCalled()
  await expect(wrapped.mergeMesh!("board", {})).rejects.toThrow(/session.*authorized/i)
  expect(mergeMesh).not.toHaveBeenCalled()
})

it("Given another person's session, when private lazy wrapping is considered, then return the original store without importing private preferences", () => {
  const store = {} as WorkspaceSetStore, load = vi.fn()
  expect(lazyIdentityDevicePreferences(store, profile, "someone-else", "remote", () => true, load)).toBe(store)
  expect(load).not.toHaveBeenCalled()
})
