import { expect, it, vi } from "vitest"
import { DeviceSyncController } from "./deviceSyncController"

const hostModule = vi.hoisted(() => ({ loaded: vi.fn(), generate: vi.fn(async () => {}) }))
vi.mock("./deviceSyncHost", () => {
  hostModule.loaded()
  return {
    generateWorkspaceInvite: hostModule.generate,
    WorkspaceAdmissionFailure: class WorkspaceAdmissionFailure extends Error {},
  }
})

it("Given Sync controller starts, then do not load workspace invitation hosting until requested", async () => {
  const controller = new DeviceSyncController({ workspace: {}, origin: () => "http://localhost" })
  expect(hostModule.loaded).not.toHaveBeenCalled()
  await controller.api().shutdown()
})

it("Given invitation generation waits for mesh initialization, when Sync closes, then cancel before loading the host", async () => {
  const controller = new DeviceSyncController({ workspace: {}, origin: () => "http://localhost" })
  const internal = controller as unknown as { ensureDurableMesh: () => Promise<undefined> }
  let finish!: () => void
  vi.spyOn(internal, "ensureDurableMesh").mockImplementationOnce(() => new Promise(resolve => {
    finish = () => resolve(undefined)
  }))

  const pending = controller.api().generateWorkspaceInvite()
  await controller.api().close()
  finish()
  await pending

  expect(hostModule.loaded).not.toHaveBeenCalled()
  expect(hostModule.generate).not.toHaveBeenCalled()
  await controller.api().shutdown()
})

it("Given the user explicitly generates a workspace invite, when initialization completes, then load and run the host", async () => {
  const controller = new DeviceSyncController({ workspace: {}, origin: () => "http://localhost" })
  hostModule.loaded.mockClear()
  hostModule.generate.mockClear()

  await controller.api().generateWorkspaceInvite()

  expect(hostModule.loaded).toHaveBeenCalledOnce()
  expect(hostModule.generate).toHaveBeenCalledOnce()
  await controller.api().shutdown()
})
