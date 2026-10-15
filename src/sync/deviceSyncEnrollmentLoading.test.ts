import { expect, it, vi } from "vitest"
import { DeviceSyncController } from "./deviceSyncController"

const enrollment = vi.hoisted(() => ({ loaded: vi.fn(), select: vi.fn(async () => {}), request: vi.fn(async () => {}) }))
vi.mock("./deviceSyncEnrollment", () => {
  enrollment.loaded()
  return { selectDeviceEnrollment: enrollment.select, requestDeviceEnrollment: enrollment.request }
})

it("Given local startup initializes Sync controls, when no enrollment is requested, then do not load the enrollment transfer implementation", async () => {
  const controller = new DeviceSyncController({ workspace: {}, origin: () => "http://localhost" })
  expect(enrollment.loaded).not.toHaveBeenCalled()
  expect(enrollment.select).not.toHaveBeenCalled()
  await controller.api().shutdown()
})

it("Given Add my device is selected, when its implementation loads, then continue the original enrollment flow", async () => {
  const controller = new DeviceSyncController({ workspace: {}, origin: () => "http://localhost" })
  try {
    await controller.api().selectSyncAll()
    expect(enrollment.loaded).toHaveBeenCalledOnce()
    expect(enrollment.select).toHaveBeenCalledOnce()
    expect(enrollment.select).toHaveBeenCalledWith(expect.objectContaining({ currentRun: expect.any(Function), nextRun: expect.any(Function) }))
  } finally { await controller.api().shutdown() }
})

it("Given enrollment setup is awaiting runtime initialization, when the user closes Sync before it completes, then do not start the delayed enrollment", async () => {
  const controller = new DeviceSyncController({ workspace: {}, origin: () => "http://localhost" })
  const internal = controller as unknown as { ensureDurableMesh: () => Promise<undefined> }
  let finish!: () => void
  vi.spyOn(internal, "ensureDurableMesh").mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(undefined) }))
  enrollment.select.mockClear()
  const pending = controller.api().selectSyncAll()
  await controller.api().close()
  finish()
  await pending
  expect(enrollment.select).not.toHaveBeenCalled()
  await controller.api().shutdown()
})
