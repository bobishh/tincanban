import { describe, expect, it } from "vitest"
import { capturedException } from "../domain/exceptionCapture"

describe("OpenTelemetry exception capture", () => {
  it("Given an Error with a cause, When captured, Then type, readable message, stack, and bounded cause details use standard keys", () => {
    const cause = new TypeError("inner parse failed at field company")
    const outer = new Error("workspace restore failed after 3 attempts", { cause })
    outer.stack = "Error: workspace restore failed after 3 attempts\n    at restoreBoard (src/restore.ts:12:4)"
    cause.stack = "TypeError: inner parse failed at field company\n    at parseBoard (src/parse.ts:7:2)"
    expect(capturedException(outer)).toEqual({
      "exception.type": "Error",
      "exception.message": "workspace restore failed after 3 attempts",
      "exception.stacktrace": expect.stringContaining("Caused by TypeError: inner parse failed at field company"),
    })
    expect(capturedException(outer)["exception.stacktrace"]).toContain("src/restore.ts:12:4")
    expect(capturedException(outer)["exception.stacktrace"]).toContain("src/parse.ts:7:2")
  })

  it("Given an AggregateError, When captured, Then each cause is represented and cycles are bounded", () => {
    const first = new RangeError("first operation failed")
    const second = new Error("second operation failed")
    const aggregate = new AggregateError([first, second], "both operations failed")
    first.cause = aggregate
    const captured = capturedException(aggregate)
    expect(captured["exception.type"]).toBe("AggregateError")
    expect(captured["exception.message"]).toBe("both operations failed")
    expect(captured["exception.stacktrace"]).toContain("Caused by RangeError: first operation failed")
    expect(captured["exception.stacktrace"]).toContain("Caused by Error: second operation failed")
    expect(captured["exception.stacktrace"]!.length).toBeLessThanOrEqual(16_384)
  })

  it.each([
    [new Error("request failed: Bearer abc.def.ghi"), "request failed: Bearer [REDACTED]"],
    [new Error('failed password="my secret value" after retry'), 'failed password="[REDACTED]" after retry'],
    [new Error("Authorization: Basic dXNlcjpwYXNz failed"), "Authorization: Basic [REDACTED] failed"],
    [new Error('{"devicePrivateKeyPkcs8":"encoded-secret"}'), '{"devicePrivateKeyPkcs8":"[REDACTED]"}'],
    [new Error("bad key -----BEGIN PRIVATE KEY-----\nsecret-key-bytes\n-----END PRIVATE KEY----- while signing"), "bad key [REDACTED PRIVATE KEY] while signing"],
    [new Error("GET https://example.test/board?view=active&token=secret-token#card"), "GET https://example.test/board?view=active&token=[REDACTED]#card"],
    [new Error('{"privateKeys":{"identity":"secret-key"},"contentKey":"content-secret","readToken":"read-secret","writeToken":"write-secret"}'),
      '{"privateKeys":[REDACTED],"contentKey":"[REDACTED]","readToken":"[REDACTED]","writeToken":"[REDACTED]"}'],
  ])("Given an exception with a secret in its message, When captured, Then redact secret values and retain useful context", (error, expected) => {
    expect(capturedException(error)["exception.message"]).toBe(expected)
  })

  it("Given a plain thrown string, DOMException, or non-error value, When captured, Then return bounded attributes", () => {
    expect(capturedException("readToken=top-secret failed while opening board")).toMatchObject({
      "exception.type": "String", "exception.message": "readToken=[REDACTED] failed while opening board",
      "exception.stacktrace": "String: readToken=[REDACTED] failed while opening board",
    })
    expect(capturedException(new DOMException("Could not clone private payload", "DataCloneError"))).toMatchObject({
      "exception.type": "DataCloneError", "exception.message": "Could not clone private payload",
    })
    expect(capturedException({ message: "worker failed safely", name: "PrivateThing" })).toMatchObject({
      "exception.type": "Object", "exception.message": "worker failed safely",
    })
  })

  it("Given oversized message and stack data, When captured, Then bound output without dropping all context", () => {
    const error = new Error("failure " + "x".repeat(30_000))
    error.stack = "Error: " + error.message + "\n" + "at private (file.ts:1:1)\n".repeat(2_000)
    const captured = capturedException(error)
    expect(captured["exception.message"]).toMatch(/^failure x+/)
    expect(captured["exception.message"]!.length).toBeLessThanOrEqual(2_048)
    expect(captured["exception.stacktrace"]!.length).toBeLessThanOrEqual(16_384)
  })
})
