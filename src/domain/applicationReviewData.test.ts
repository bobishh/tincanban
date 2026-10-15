import { describe, expect, it } from "vitest"
import { parseApplicationReviewBody, parseApplicationReviewDiscovery, parseApplicationReviewReceipt,
  parseApplicationReviewMailbox, parseApplicationReviewResponse, type ApplicationReviewResponse } from "./applicationReviewData"
import type { ApplicationBindingProof } from "./applicationBinding"

const proof = {
  publicKey: "public-key",
  certificates: [{ payload: { kind: "device-certificate", version: 1, personId: "person-1", deviceId: "device-1",
    devicePublicKey: "device-public-key", issuerCertificateHash: null, canEnrollDevices: false }, signerKeyId: "person-1", signature: "sig" }],
  signed: { signerKeyId: "device-1", signature: "sig", payload: {
    kind: "automation-application-binding", version: 1, bindingId: "5f1bd4ce-13ca-4d45-a32d-40a2165df521",
    previousBindingId: null, origin: "https://automation.example.test", integrationId: "worker-1", definitionId: "definition-1",
    workspaceId: "workspace-1", cardId: "card-1", grantId: "grant-1", eventId: "A".repeat(32),
    eventHash: "A".repeat(43), decisionHash: "B".repeat(43), sourceRecordId: "source-1", sourceHash: "C".repeat(43),
    accessEpoch: 4, workflow: { columnId: "applied", changedAt: "2026-10-14T10:00:00.000Z" },
    personId: "person-1", deviceId: "device-1", issuedAt: 1_797_000_000_000,
  } },
} as unknown as ApplicationBindingProof

function response(overrides: Partial<ApplicationReviewResponse> = {}): ApplicationReviewResponse {
  return {
    kind: "automation-application-review", version: 1, origin: "https://automation.example.test",
    integrationId: "worker-1", definitionId: "definition-1", workspaceId: "workspace-1", eventId: "A".repeat(32),
    eventHash: "A".repeat(43), decisionHash: "B".repeat(43), decisionEvent: "applied", status: "review",
    subject: "Application update", text: "Please review this message.", sentAt: "2026-10-14T10:00:00.000Z",
    grantId: "grant-1", accessEpoch: 4, automationState: "active", binding: null,
    options: [{ cardId: "card-1", displayTitle: "Senior Engineer", sourceRecordId: "source-1", sourceHash: "C".repeat(43),
      sourceTitle: "Senior Engineer", sourceCompany: "Example Co", sourceStatus: "available",
      workflow: { columnId: "applied", changedAt: "2026-10-14T10:00:00.000Z" } }],
    total: 1, offset: 0, hasMore: false,
    ...overrides,
  }
}

describe("application review wire data", () => {
  it("Given a signed-mailbox envelope, When parsing, Then validate exact scope and bounded receipt shapes while detaching input", () => {
    const value = { origin: "https://automation.example.test", workspaceId: "workspace-1", definitionId: "definition-1",
      integrationId: "worker-1", route: { address: "inbox@example.test", mailbox: "inbox" },
      receipt: { confirmation: { eventId: "A".repeat(32), url: "https://mail.google.com/mail/u/0/#inbox" },
        events: [{ eventId: "B".repeat(32), status: "pending", createdAt: 1, subject: "Reply", result: { reason: "queued" } }] },
      observation: { opaque: true } }
    const parsed = parseApplicationReviewMailbox(value)
    value.receipt.events[0]!.subject = "mutated"
    expect(parsed.receipt.events[0]!.subject).toBe("Reply")
    expect(parsed.observation).toEqual({ opaque: true })
    expect(parseApplicationReviewBody("list", { workspaceId: "workspace-1", definitionId: "definition-1", integrationId: "worker-1" }))
      .toEqual({ workspaceId: "workspace-1", definitionId: "definition-1", integrationId: "worker-1" })
    expect(() => parseApplicationReviewBody("list", { workspaceId: "workspace-1", definitionId: "definition-1" })).toThrow()
    for (const changed of [
      { ...value, extra: true },
      { ...value, receipt: { ...value.receipt, confirmation: { eventId: "A".repeat(32), url: "https://evil.example/" } } },
      { ...value, receipt: { ...value.receipt, events: Array.from({ length: 21 }, (_, i) => ({ eventId: String(i).padStart(20, "A"), status: "pending", createdAt: 1, subject: "" })) } },
      { ...value, route: { address: "a".repeat(321), mailbox: "inbox" } },
    ]) expect(() => parseApplicationReviewMailbox(changed)).toThrow()
  })

  it("Given bind and retry responses, When parsing receipts, Then accept only the action-specific exact wire shape", () => {
    const bindingId = "5f1bd4ce-13ca-4d45-a32d-40a2165df521"
    expect(parseApplicationReviewReceipt("bind", { bindingId, duplicate: false })).toEqual({ bindingId, duplicate: false })
    expect(parseApplicationReviewReceipt("retry", { eventId: "A".repeat(32), status: "pending", duplicate: true }))
      .toEqual({ eventId: "A".repeat(32), status: "pending", duplicate: true })
    expect(() => parseApplicationReviewReceipt("bind", { eventId: "A".repeat(32), status: "applied", duplicate: true })).toThrow()
    expect(() => parseApplicationReviewReceipt("retry", { bindingId, duplicate: true })).toThrow()
    expect(() => parseApplicationReviewReceipt("bind", { bindingId, duplicate: false, extra: true })).toThrow()
    expect(() => parseApplicationReviewReceipt("retry", { eventId: "short", status: "applied", duplicate: false })).toThrow()
  })

  it("Given application-review discovery data, When parsing, Then validate origin, exact shape and unique integrations", () => {
    const value = { origin: "https://automation.example.test", workspaceId: "workspace-1", definitionId: "definition-1",
      integrations: [{ integrationId: "worker-1", personId: "person-1" }] }
    const parsed = parseApplicationReviewDiscovery(value)
    value.integrations[0]!.personId = "changed"
    expect(parsed.integrations[0]!.personId).toBe("person-1")
    expect(() => parseApplicationReviewDiscovery({ ...value, integrations: [
      { integrationId: "worker-1", personId: "person-1" }, { integrationId: "worker-1", personId: "person-2" },
    ] })).toThrow(/duplicate/i)
    expect(() => parseApplicationReviewDiscovery({ ...value, origin: "http://public.example.test" })).toThrow()
    expect(() => parseApplicationReviewDiscovery({ ...value, extra: true })).toThrow()
  })

  it("Given each request action, When parsing exact input, Then normalize pagination and preserve a detached proof", () => {
    expect(parseApplicationReviewBody("discover", { workspaceId: "workspace-1", definitionId: "definition-1" }))
      .toEqual({ workspaceId: "workspace-1", definitionId: "definition-1" })
    expect(parseApplicationReviewBody("review", { workspaceId: "workspace-1", definitionId: "definition-1",
      integrationId: "worker-1", eventId: "A".repeat(32) })).toMatchObject({ offset: 0 })
    const value = { workspaceId: "workspace-1", definitionId: "definition-1", integrationId: "worker-1", proof }
    const parsed = parseApplicationReviewBody("bind", value)
    value.proof.signed.payload.cardId = "changed"
    expect(parsed).toMatchObject({ proof: { signed: { payload: { cardId: "card-1" } } } })
    expect(parseApplicationReviewBody("retry", { ...value, proof })).toMatchObject({ integrationId: "worker-1" })
  })

  it("Given request bodies with extra, invalid or mutated data, When parsing, Then reject extras and retain entry snapshot", () => {
    expect(() => parseApplicationReviewBody("discover", { workspaceId: "w", definitionId: "d", extra: true })).toThrow()
    expect(() => parseApplicationReviewBody("review", { workspaceId: "w", definitionId: "d", integrationId: "i",
      eventId: "short", offset: -1 })).toThrow()
    expect(() => parseApplicationReviewBody("bind", { workspaceId: "w", definitionId: "d", integrationId: "i", proof, extra: 1 })).toThrow()
    const value = { workspaceId: "workspace-1", definitionId: "definition-1" }
    const parsed = parseApplicationReviewBody("discover", value)
    value.workspaceId = "mutated"
    expect(parsed).toEqual({ workspaceId: "workspace-1", definitionId: "definition-1" })
  })

  it("Given valid paginated review data, When parsing, Then detach nested values and enforce exact page arithmetic", () => {
    const input = response({ offset: 20, total: 25, hasMore: true, options: [] })
    const parsed = parseApplicationReviewResponse(input)
    input.options.push({ cardId: "later", displayTitle: "Later", sourceRecordId: null, sourceHash: null,
      sourceTitle: null, sourceCompany: null, sourceStatus: null, workflow: null })
    expect(parsed.options).toHaveLength(0)
    for (const invalid of [
      response({ offset: 21, total: 20, hasMore: false, options: [] }),
      response({ offset: 0, total: 2, hasMore: false, options: [] }),
      response({ offset: 0, total: 1, hasMore: false, options: [{ ...response().options[0]!, cardId: "one" },
        { ...response().options[0]!, cardId: "two" }] }),
    ]) expect(() => parseApplicationReviewResponse(invalid)).toThrow()
  })

  it("Given source metadata, When fields are partial or contradict availability, Then reject the option", () => {
    const option = response().options[0]!
    for (const changed of [
      { ...option, sourceHash: null },
      { ...option, sourceStatus: null },
      { ...option, sourceStatus: "unavailable" as const },
      { ...option, sourceStatus: "available" as const, sourceCompany: null },
      { ...option, sourceRecordId: null, sourceHash: null, sourceStatus: null, sourceTitle: "orphan" },
    ]) expect(() => parseApplicationReviewResponse(response({ options: [changed] }))).toThrow()
    expect(() => parseApplicationReviewResponse(response({ text: "x".repeat(48_001) }))).toThrow()
  })

  it("Given a retained binding, When parsing a review response, Then require exact route, event and authority scope", () => {
    const good = response({ binding: proof })
    expect(parseApplicationReviewResponse(good).binding).toEqual(proof)
    for (const changed of [
      { ...proof, signed: { ...proof.signed, payload: { ...proof.signed.payload, origin: "https://other.example.test" } } },
      { ...proof, signed: { ...proof.signed, payload: { ...proof.signed.payload, integrationId: "other-worker" } } },
      { ...proof, signed: { ...proof.signed, payload: { ...proof.signed.payload, workspaceId: "other-workspace" } } },
      { ...proof, signed: { ...proof.signed, payload: { ...proof.signed.payload, eventHash: "D".repeat(43) } } },
    ]) expect(() => parseApplicationReviewResponse(response({ binding: changed as typeof proof }))).toThrow()
  })

  it("Given a historical binding from an earlier grant, When parsing a newer response, Then retain signed historical grant and epoch", () => {
    const historical = { ...proof, signed: { ...proof.signed, payload: {
      ...proof.signed.payload, grantId: "previous-grant", accessEpoch: 3,
    } } }
    expect(() => parseApplicationReviewResponse(response({ binding: historical as typeof proof }))).not.toThrow()
    expect(parseApplicationReviewResponse(response({ binding: historical as typeof proof })).binding)
      .toMatchObject({ signed: { payload: { grantId: "previous-grant", accessEpoch: 3 } } })
  })

  it("Given malformed or oversized response data, When parsing, Then reject it", () => {
    expect(() => parseApplicationReviewResponse({ ...response(), status: "queued" })).toThrow()
    expect(() => parseApplicationReviewResponse({ ...response(), unknown: "field" })).toThrow()
    expect(() => parseApplicationReviewResponse({ ...response(), origin: "http://public.example.test" })).toThrow()
  })
})
