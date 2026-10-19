import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { withRecoveryCheckpoint, reportPreviousRecoveryDiagnostic } from "./recoveryDiagnostics"
import { record } from "./telemetry"

vi.mock("./telemetryConfig", () => ({ telemetryConfig: () => ({ enabled: true }) }))
vi.mock("./telemetry", () => ({ record: vi.fn() }))
const storage = new Map<string, string>()
beforeEach(() => {
  storage.clear()
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
  vi.mocked(record).mockClear()
})
afterEach(() => vi.unstubAllGlobals())
const checkpoint = () => JSON.parse(storage.get("tincanban.recovery.checkpoint.v1")!)

it("Given a pending recovery parent, when its child completes, then retain the parent and omit private details", async () => {
  await withRecoveryCheckpoint("recovery.save", { "server.address": "worker.example", secret: "never-store-this" }, async () => {
    await withRecoveryCheckpoint("recovery.verify", {}, async () => {})
    expect(checkpoint()).toMatchObject({ phase: "recovery.save", status: "started" })
    expect(JSON.stringify(checkpoint())).not.toContain("never-store-this")
  })
  expect(checkpoint().status).toBe("completed")
})

it("Given a deep native failure followed by an outer failure, when reloading, then report the original stage and error", async () => {
  await expect(withRecoveryCheckpoint("recovery.save", {}, async () => {
    try { await withRecoveryCheckpoint("recovery.verifySignature", {}, () => { throw new Error("first failure") }) }
    catch { throw new Error("secondary failure") }
  })).rejects.toThrow("secondary failure")
  expect(checkpoint()).toMatchObject({ phase: "recovery.verifySignature", status: "failed", failure: { "exception.message": "first failure" } })
  reportPreviousRecoveryDiagnostic()
  expect(record).toHaveBeenCalledWith("rusty.credential-recovery.previous.failed",
    expect.objectContaining({ phase: "recovery.verifySignature", error: expect.objectContaining({ message: "first failure" }) }), "error")
})
