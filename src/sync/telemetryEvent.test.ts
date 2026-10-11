import { describe, expect, it } from "vitest"
import { diagnosticEvent, entityTraceId } from "./telemetryEvent"

const context = { project: "match", sessionId: "session-a", deviceId: "device-a", timestamp: 1_791_381_600_000, level: "info" }
describe("telemetry event contract", () => {
  it("Given a startup error type, When encoded for intake, Then the error code is a lowercase identifier", async () => {
    const event = await diagnosticEvent("startup.phase.failed", { errorCode: "TypeError" }, { ...context, level: "warn" })
    expect(event.attrs.error_code).toBe("type_error")
  })
  it("Given an authority race, When diagnostics reach Cloudflare, Then stage and changed field names survive without authority values", async () => {
    const event = await diagnosticEvent("workspace.admission.authority-changed", {
      stage: "admit-history", changedFields: ["updatedAt", "catalog"], previousEpoch: 1, currentEpoch: 1,
      catalog: { secret: "private-proof" }, elapsedMs: 1200,
    }, { ...context, level: "warn" })
    expect(event.attrs).toMatchObject({ stage: "admit-history", changed_fields: ["updatedAt", "catalog"], previous_epoch: 1, current_epoch: 1 })
    expect(JSON.stringify(event)).not.toContain("private-proof")
  })
  it("Given the same signed entity on two devices, when recorded, then trace correlation survives differing sessions", async () => {
    const detail = { workspaceId: "workspace-full-0123456789", recordId: "device-a:message-full-0123456789", phase: "local" }
    const sent = await diagnosticEvent("chat.persisted", detail, context)
    const received = await diagnosticEvent("chat.dom.updated", { ...detail, phase: "remote" }, { ...context, sessionId: "session-b", deviceId: "device-b" })
    expect(sent.entity_id).toBe(detail.recordId)
    expect(sent.workspace_id).toBe(detail.workspaceId)
    expect(sent.trace_id).toMatch(/^[0-9a-f]{32}$/)
    expect(received.trace_id).toBe(sent.trace_id)
    expect(received.device_id).not.toBe(sent.device_id)
    expect(received.event_id).not.toBe(sent.event_id)
    expect(sent.span_id).toBe("")
    expect(await entityTraceId("other-project", detail.workspaceId, "message", detail.recordId)).not.toBe(sent.trace_id)
  })
  it("Given diagnostic detail containing content and secrets, when encoded, then only typed allowed fields remain", async () => {
    const event = await diagnosticEvent("document.persisted", {
      workspaceId: "workspace-full", recordId: "change-hash-full", elapsedMs: 12.75,
      peerId: "full-peer-0123456789", bytes: 1234, attempt: 2, heads: ["full-head"], phase: "remote",
      body: "secret-body", reason: "secret-error", url: "https://secret.example/token", proof: "secret-proof", name: "secret-name",
      peerCount: NaN, changeCount: -1, outcome: "saved",
    }, context)
    expect(event.duration_ms).toBe(12.75)
    expect(event.attrs).toEqual({ phase: "remote", peer_id: "full-peer-0123456789", bytes: 1234, attempt: 2, heads: ["full-head"] })
    expect(JSON.stringify(event)).not.toContain("secret")
    expect(event.status).toBe("saved")
  })
})
