import { describe, expect, it, vi } from "vitest"
import { ExportResultCode, type ExportResult } from "@opentelemetry/core"
import { exportOtlpBatches } from "./otlpBodyBudget"

describe("OTLP body budget", () => {
  it("Given split bodies and one failed request, when requests settle, then stop the unsent tail and release it without dropping the successful request", async () => {
    const requests: Array<{ records: string[]; complete: (result: ExportResult) => void }> = []
    const started = vi.fn()
    const finished = vi.fn()
    const callback = vi.fn()
    const records = ["a", "b", "c"].map(value => value.repeat(40_000))
    exportOtlpBatches(records, {
      serialize: group => new TextEncoder().encode(JSON.stringify(group)), active: () => true,
      exporter: { export: (group, complete) => { requests.push({ records: group, complete }) } }, started, finished,
    }, callback)
    expect(requests).toHaveLength(2)
    expect(callback).not.toHaveBeenCalled()
    requests[1]!.complete({ code: ExportResultCode.FAILED, error: new Error("intake unavailable") })
    expect(requests).toHaveLength(2)
    expect(callback).not.toHaveBeenCalled()
    requests[0]!.complete({ code: ExportResultCode.SUCCESS })
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    expect(callback).toHaveBeenCalledExactlyOnceWith({ code: ExportResultCode.FAILED, error: expect.any(Error) })
    expect(finished.mock.calls.filter(([, result]) => result.code === ExportResultCode.FAILED).reduce((count, [size]) => count + size, 0)).toBe(2)
    expect(requests.flatMap(request => request.records)).toEqual(records.slice(0, 2))
  })

  it("Given an oversized single record, when a batch also has valid records, then reject only that record locally and still send valid bodies", async () => {
    const sent: string[] = []
    const finished = vi.fn()
    const callback = vi.fn()
    exportOtlpBatches(["x".repeat(70_000), "valid-a", "valid-b"], {
      serialize: group => new TextEncoder().encode(JSON.stringify(group)), active: () => true,
      exporter: { export: (group, complete) => { sent.push(...group); complete({ code: ExportResultCode.SUCCESS }) } },
      started: vi.fn(), finished,
    }, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    expect(sent).toEqual(["valid-a", "valid-b"])
    expect(finished.mock.calls.filter(([, result]) => result.code === ExportResultCode.FAILED).reduce((count, [size]) => count + size, 0)).toBe(1)
    expect(callback).toHaveBeenCalledExactlyOnceWith({ code: ExportResultCode.FAILED, error: expect.any(Error) })
  })
})
