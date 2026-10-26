import { expect, it, vi } from "vitest"
import { DeviceSyncController } from "./deviceSyncController"

const ownerModule = vi.hoisted(() => ({ loaded: vi.fn() }))
vi.mock("./deviceSyncOwnerReconnectSession", () => {
  ownerModule.loaded()
  throw new Error("Owner reconnect module download failed")
})

it("Given board startup needs no owner exchange, when its optional module later fails to load, then keep ordinary Sync usable and show a settled error", async () => {
  const sync = new DeviceSyncController({ workspace: {}, origin: () => "http://localhost" }).api()
  expect(ownerModule.loaded).not.toHaveBeenCalled()
  await sync.close()
  expect(ownerModule.loaded).not.toHaveBeenCalled()

  await expect(sync.startOwnerReconnect()).resolves.toBeUndefined()

  expect(ownerModule.loaded).toHaveBeenCalledOnce()
  expect(sync.step.value).toBe("error")
  expect(sync.error.value).toMatch(/owner reconnect/i)
  await sync.shutdown()
})
