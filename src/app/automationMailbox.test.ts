import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LocalProfile } from "../domain/identity"
import type { AutomationObservation } from "../domain/automationProtocol"
import { UnsupportedApplicationReviewError } from "./applicationReviewClient"
import { discoverApplicationReview, readApplicationReviewMailbox, retryUnboundApplicationReview } from "./applicationReviewClient"
import { observeAutomation, readAutomationEmail, retryAutomationEmail } from "./automationClient"
import { readAutomationMailbox, retryUnboundAutomationMailbox } from "./automationMailbox"

vi.mock("./applicationReviewClient", () => ({
  UnsupportedApplicationReviewError: class UnsupportedApplicationReviewError extends Error {},
  discoverApplicationReview: vi.fn(),
  readApplicationReviewMailbox: vi.fn(),
  retryUnboundApplicationReview: vi.fn(),
}))
vi.mock("./automationClient", () => ({ observeAutomation: vi.fn(), readAutomationEmail: vi.fn(), retryAutomationEmail: vi.fn() }))

const profile = { identity: { personId: "owner-person" } } as LocalProfile
const input = { origin: "https://worker.example.test", workspaceId: "workspace-1", definitionId: "definition-1",
  personId: "executor-person", grantId: "grant-1" }
const guards = { ensureCurrent: vi.fn() }
const observation = { kind: "automation-observation", version: 1, origin: input.origin, integrationId: input.definitionId,
  workspaceId: input.workspaceId, grantId: input.grantId, nonce: "nonce", issuedAt: 10, state: "active", heads: ["head"] }
const mailbox = { origin: input.origin, workspaceId: input.workspaceId, definitionId: input.definitionId,
  integrationId: "legacy_worker-1", route: { address: "inbox@example.test", mailbox: "inbox" },
  receipt: { confirmation: null, events: [{ eventId: "A".repeat(32), status: "pending", createdAt: 10,
    subject: "Reply", bindingId: "5f1bd4ce-13ca-4d45-a32d-40a2165df521" }] }, observation,
  verifiedObservation: observation }

describe("automation mailbox adapter", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("Given signed review support, When reading the mailbox, Then use the discovered legacy route and return verified setup", async () => {
    vi.mocked(discoverApplicationReview).mockResolvedValue({ integrationId: "legacy_worker-1", personId: input.personId })
    vi.mocked(readApplicationReviewMailbox).mockResolvedValue(mailbox as never)
    const result = await readAutomationMailbox(profile, input, guards)
    expect(discoverApplicationReview).toHaveBeenCalledWith(profile, {
      origin: input.origin, workspaceId: input.workspaceId, definitionId: input.definitionId, personId: input.personId,
    }, guards)
    expect(readApplicationReviewMailbox).toHaveBeenCalledWith(profile, { origin: input.origin, workspaceId: input.workspaceId,
      definitionId: input.definitionId, integrationId: "legacy_worker-1", personId: input.personId, grantId: input.grantId }, guards)
    expect(result).toEqual({ setup: { route: mailbox.route, receipt: mailbox.receipt }, observation, integrationId: "legacy_worker-1" })
    expect(observeAutomation).not.toHaveBeenCalled()
    expect(readAutomationEmail).not.toHaveBeenCalled()
  })

  it("Given an older Worker without review capability, When reading, Then fall back to definition-ID observation and email", async () => {
    vi.mocked(discoverApplicationReview).mockRejectedValue(new UnsupportedApplicationReviewError())
    vi.mocked(observeAutomation).mockResolvedValue(observation as AutomationObservation)
    vi.mocked(readAutomationEmail).mockResolvedValue({ route: null, receipt: { confirmation: null, events: [] } })
    const result = await readAutomationMailbox(profile, input, guards)
    expect(observeAutomation).toHaveBeenCalledWith(profile, { origin: input.origin, workspaceId: input.workspaceId,
      personId: input.personId, grantId: input.grantId, integrationId: input.definitionId })
    expect(readAutomationEmail).toHaveBeenCalledWith(profile, { origin: input.origin, workspaceId: input.workspaceId,
      integrationId: input.definitionId })
    expect(result).toEqual({ setup: { route: null, receipt: { confirmation: null, events: [] } }, observation,
      integrationId: input.definitionId })
    expect(guards.ensureCurrent).toHaveBeenCalled()
  })

  it("Given authorization, network or proof failure, When list fails, Then never invoke legacy fallback", async () => {
    for (const error of [new Error("Worker returned 403"), new Error("offline"), new Error("invalid proof")]) {
      vi.clearAllMocks()
      vi.mocked(discoverApplicationReview).mockResolvedValue({ integrationId: "legacy_worker-1", personId: input.personId })
      vi.mocked(readApplicationReviewMailbox).mockRejectedValue(error)
      await expect(readAutomationMailbox(profile, input)).rejects.toBe(error)
      expect(observeAutomation).not.toHaveBeenCalled()
      expect(readAutomationEmail).not.toHaveBeenCalled()
    }
  })

  it("Given authority changes between list and response, When guarded, Then reject and do not fall back", async () => {
    const ensureCurrent = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValue(new Error("identity changed"))
    const currentGuards = { ensureCurrent }
    vi.mocked(discoverApplicationReview).mockResolvedValue({ integrationId: "legacy_worker-1", personId: input.personId })
    vi.mocked(readApplicationReviewMailbox).mockResolvedValue(mailbox as never)
    await expect(readAutomationMailbox(profile, input, currentGuards)).rejects.toThrow("identity changed")
    expect(observeAutomation).not.toHaveBeenCalled()
    expect(readAutomationEmail).not.toHaveBeenCalled()
  })

  it("Given signed review support, When retrying unbound mail, Then use discovered legacy route and preserve event receipt", async () => {
    vi.mocked(discoverApplicationReview).mockResolvedValue({ integrationId: "legacy_worker-1", personId: input.personId })
    const receipt = { eventId: "B".repeat(32), status: "pending" as const, duplicate: false }
    vi.mocked(retryUnboundApplicationReview).mockResolvedValue(receipt)
    await expect(retryUnboundAutomationMailbox(profile, { ...input, eventId: receipt.eventId }, guards)).resolves.toEqual(receipt)
    expect(discoverApplicationReview).toHaveBeenCalledWith(profile, { origin: input.origin, workspaceId: input.workspaceId,
      definitionId: input.definitionId, personId: input.personId }, guards)
    expect(retryUnboundApplicationReview).toHaveBeenCalledWith(profile, { origin: input.origin, workspaceId: input.workspaceId,
      definitionId: input.definitionId, integrationId: "legacy_worker-1", eventId: receipt.eventId }, guards)
    expect(retryAutomationEmail).not.toHaveBeenCalled()
  })

  it("Given an old Worker or route without retry support, When explicitly unsupported, Then use the definition route fallback", async () => {
    const eventId = "C".repeat(32)
    const oldReceipt = { eventId, status: "pending", duplicate: false }
    vi.mocked(discoverApplicationReview).mockRejectedValue(new UnsupportedApplicationReviewError())
    vi.mocked(retryAutomationEmail).mockResolvedValue(oldReceipt)
    await expect(retryUnboundAutomationMailbox(profile, { ...input, eventId }, guards)).resolves.toEqual(oldReceipt)
    expect(retryAutomationEmail).toHaveBeenCalledWith(profile, { origin: input.origin, integrationId: input.definitionId,
      workspaceId: input.workspaceId }, eventId)
    vi.clearAllMocks()
    vi.mocked(discoverApplicationReview).mockResolvedValue({ integrationId: "legacy_worker-1", personId: input.personId })
    vi.mocked(retryUnboundApplicationReview).mockRejectedValue(new UnsupportedApplicationReviewError())
    vi.mocked(retryAutomationEmail).mockResolvedValue(oldReceipt)
    await expect(retryUnboundAutomationMailbox(profile, { ...input, eventId })).resolves.toEqual(oldReceipt)
    expect(retryAutomationEmail).toHaveBeenCalledWith(profile, { origin: input.origin, integrationId: input.definitionId,
      workspaceId: input.workspaceId }, eventId)
    vi.mocked(retryAutomationEmail).mockResolvedValue({ ...oldReceipt, eventId: "D".repeat(32) })
    await expect(retryUnboundAutomationMailbox(profile, { ...input, eventId }, guards)).rejects.toThrow(/another saved message/i)
  })

  it("Given delayed route discovery, When caller mutates input and profile, Then keep captured retry coordinates", async () => {
    let release!: (route: { integrationId: string; personId: string }) => void
    let entered!: () => void
    const discoveryStarted = new Promise<void>(resolve => { entered = resolve })
    vi.mocked(discoverApplicationReview).mockImplementation(() => new Promise(resolve => { release = resolve; entered() }))
    vi.mocked(retryUnboundApplicationReview).mockResolvedValue({ eventId: "E".repeat(32), status: "pending", duplicate: false })
    const mutableProfile = structuredClone(profile)
    const mutableInput = { ...input, eventId: "E".repeat(32) }
    const pending = retryUnboundAutomationMailbox(mutableProfile, mutableInput)
    await discoveryStarted
    mutableInput.eventId = "F".repeat(32)
    mutableProfile.identity.personId = "changed-person"
    release({ integrationId: "legacy_worker-1", personId: input.personId })
    await expect(pending).resolves.toMatchObject({ eventId: "E".repeat(32) })
    expect(retryUnboundApplicationReview).toHaveBeenCalledWith(profile, { origin: input.origin, workspaceId: input.workspaceId,
      definitionId: input.definitionId, integrationId: "legacy_worker-1", eventId: "E".repeat(32) }, undefined)
  })

  it("Given authority changes after retry, When response arrives, Then reject it without legacy fallback", async () => {
    const ensureCurrent = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("identity changed"))
    vi.mocked(discoverApplicationReview).mockResolvedValue({ integrationId: "legacy_worker-1", personId: input.personId })
    vi.mocked(retryUnboundApplicationReview).mockResolvedValue({ eventId: "G".repeat(32), status: "pending", duplicate: false })
    await expect(retryUnboundAutomationMailbox(profile, { ...input, eventId: "G".repeat(32) }, { ensureCurrent }))
      .rejects.toThrow("identity changed")
    expect(retryAutomationEmail).not.toHaveBeenCalled()
  })

  it("Given a bound-event, authorization, proof or network failure, When retrying, Then never fall back", async () => {
    vi.mocked(discoverApplicationReview).mockResolvedValue({ integrationId: "legacy_worker-1", personId: input.personId })
    for (const error of [new Error("bound event needs signed binding"), new Error("Forbidden"), new Error("offline")]) {
      vi.clearAllMocks()
      vi.mocked(discoverApplicationReview).mockResolvedValue({ integrationId: "legacy_worker-1", personId: input.personId })
      vi.mocked(retryUnboundApplicationReview).mockRejectedValue(error)
      await expect(retryUnboundAutomationMailbox(profile, { ...input, eventId: "D".repeat(32) })).rejects.toBe(error)
      expect(retryAutomationEmail).not.toHaveBeenCalled()
    }
    vi.clearAllMocks()
    vi.mocked(discoverApplicationReview).mockRejectedValue(new Error("signature failure"))
    await expect(retryUnboundAutomationMailbox(profile, { ...input, eventId: "D".repeat(32) })).rejects.toThrow("signature failure")
    expect(retryAutomationEmail).not.toHaveBeenCalled()
  })
})
