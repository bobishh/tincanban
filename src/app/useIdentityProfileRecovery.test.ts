import { afterEach, expect, it, vi } from "vitest"
import { ref, shallowRef } from "vue"
import type * as Vue from "vue"
import type { LocalProfile } from "../domain/identity"
import { identityDevicePreferencesChanged } from "../sync/identityDevicePreferenceEvents"

const recovery = vi.hoisted(() => ({ cleanup: [] as Array<() => void>,
  retry: vi.fn(async (_person: string, guard: () => void) => { guard(); return { projected: 0, pending: [] as Array<{ workspaceId: string; reason: string }> } }),
}))
vi.mock("vue", async original => ({ ...await original<typeof Vue>(),
  onBeforeUnmount: (cleanup: () => void) => recovery.cleanup.push(cleanup),
}))
vi.mock("../sync/identityDeviceActivationLoader", () => ({ retryPendingIdentityProfiles: recovery.retry }))

async function fixture(ready = true) {
  const { useIdentityProfileRecovery } = await import("./useIdentityProfileRecovery")
  const profile = shallowRef({ identity: { personId: "person-a", publicKey: "root-a" },
    device: { deviceId: "device-a" }, certificate: { signature: "certificate-a" } } as LocalProfile)
  const app = { ready: ref(ready), availableWorkspaces: ref([{ id: "workspace-a" }]), activeWorkspace: { id: "workspace-a" },
    docVersion: ref(0), getCurrentProfile: () => profile.value, refreshIdentity: async () => {}, subscribeLocalChanges: () => () => {} } as unknown as Parameters<typeof useIdentityProfileRecovery>[0]
  return { app, profile, controller: useIdentityProfileRecovery(app) }
}

afterEach(() => {
  for (const cleanup of recovery.cleanup.splice(0)) cleanup()
  recovery.retry.mockReset().mockImplementation(async (_person, guard) => { guard(); return { projected: 0, pending: [] } })
})

it("Given an unready workspace, when hydration finishes and later another workspace installs, then retry private profiles at both actual availability transitions", async () => {
  const f = await fixture(false)
  expect(recovery.retry).not.toHaveBeenCalled()
  f.app.ready.value = true
  await vi.waitFor(() => expect(recovery.retry).toHaveBeenCalledTimes(1))
  f.app.availableWorkspaces.value.push({ id: "workspace-b" } as never)
  await vi.waitFor(() => expect(recovery.retry).toHaveBeenCalledTimes(2))
})

it("Given private delivery finishes after workspace installation, when same-person state changes, then retry it and ignore unrelated identities", async () => {
  await fixture()
  await vi.waitFor(() => expect(recovery.retry).toHaveBeenCalledTimes(1))
  identityDevicePreferencesChanged("someone-else")
  expect(recovery.retry).toHaveBeenCalledTimes(1)
  identityDevicePreferencesChanged("person-a")
  await vi.waitFor(() => expect(recovery.retry).toHaveBeenCalledTimes(2))
})

it("Given recovery is awaiting storage, when identity switches, then invalidate the old guard and never publish old pending state", async () => {
  let release!: () => void, oldGuard!: () => void
  recovery.retry.mockImplementationOnce(async (_person, guard) => {
    oldGuard = guard
    await new Promise<void>(resolve => { release = resolve })
    guard()
    return { projected: 0, pending: [{ workspaceId: "old", reason: "old problem" }] }
  })
  const f = await fixture()
  await vi.waitFor(() => expect(release).toBeDefined())
  f.profile.value = { ...f.profile.value, identity: { ...f.profile.value.identity, personId: "person-b" } }
  f.app.docVersion.value++
  expect(() => oldGuard()).toThrow(/Identity changed/)
  release()
  await vi.waitFor(() => expect(recovery.retry).toHaveBeenCalledWith("person-b", expect.any(Function)))
  expect(f.controller.pending.value).toEqual([])
  expect(f.controller.error.value).toBe("")
})

it("Given projection is pending or storage failed, when recovery reports state and succeeds on retry, then retain exact reasons and clear only current results", async () => {
  recovery.retry.mockResolvedValueOnce({ projected: 0, pending: [{ workspaceId: "workspace-a", reason: "Workspace not installed" }] })
  const f = await fixture()
  await vi.waitFor(() => expect(f.controller.pending.value[0]?.reason).toBe("Workspace not installed"))
  recovery.retry.mockRejectedValueOnce(new Error("Private queue unreadable"))
  await f.controller.retry()
  expect(f.controller.error.value).toBe("Private queue unreadable")
  await f.controller.retry()
  expect(f.controller.pending.value).toEqual([])
  expect(f.controller.error.value).toBe("")
})
