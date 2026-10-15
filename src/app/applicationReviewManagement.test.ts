import { beforeEach, describe, expect, it, vi, type Mock } from "vitest"
import { createWorkspaceDoc } from "../domain/seeds"
import { canonicalizeJson } from "../domain/identity"
import { parseAutomationDefinition, automationTypes, type AutomationDefinition } from "../domain/automationContract"
import { automationEntityId } from "../domain/automationLifecycle"
import type { LocalProfile } from "../domain/identity"
import type { ApplicationBindingProof } from "../domain/applicationBinding"
import type { ApplicationReviewOption, ApplicationReviewResponse } from "../domain/applicationReviewData"
import type { WorkspaceDocumentV2, WorkspaceEntity } from "../domain/model"
import { createApplicationReviewManagement } from "./applicationReviewManagement"

const origin = "https://automation.example.test"
const timestamp = "2026-10-14T10:00:00.000Z"
const mockFns = vi.hoisted(() => ({
  discover: vi.fn(), read: vi.fn(), save: vi.fn(), retry: vi.fn(), resolveContext: vi.fn(), createBinding: vi.fn(), validate: vi.fn(),
  workspaceRole: vi.fn(), admissionAuthority: vi.fn(),
}))

vi.mock("./applicationReviewClient", () => ({
  discoverApplicationReview: mockFns.discover,
  readApplicationReview: mockFns.read,
  saveApplicationBinding: mockFns.save,
  retryApplicationBinding: mockFns.retry,
}))
vi.mock("../domain/localSigningContext", () => ({ resolveLocalSigningContext: mockFns.resolveContext }))
vi.mock("../domain/applicationBinding", () => ({ createApplicationBinding: mockFns.createBinding }))
vi.mock("./applicationReviewSelection", () => ({ validateApplicationReviewSelection: mockFns.validate }))
vi.mock("../sync/changeAuthorization", () => ({
  workspaceRole: mockFns.workspaceRole,
  localWorkspaceAdmissionAuthority: mockFns.admissionAuthority,
}))

type State = {
  profile: LocalProfile
  doc: WorkspaceDocumentV2
  definition: AutomationDefinition
  option: ApplicationReviewOption
  response: ApplicationReviewResponse
  host: { getActiveDoc: () => WorkspaceDocumentV2 | undefined; getCurrentProfile: () => LocalProfile | undefined;
    owner: () => boolean; syncNow: Mock<() => Promise<void>>; changed: Mock<() => Promise<void>> }
  setProfile: (profile: LocalProfile | undefined) => void
  setOwner: (owner: boolean) => void
}

function fixture(): State {
  const profile = localProfile("person-one", "device-one")
  const doc = createWorkspaceDoc("workspace-one", "Applications", profile.identity.personId, "job-search", timestamp)
  const board = Object.values(doc.entities).find(entity => entity.kind === "board")!
  if (board.kind !== "board") throw new Error("Expected board")
  const definition = parseAutomationDefinition({ kind: "automation-definition", version: 1, id: "typed-intake", name: "Job intake",
    type: "job-intake", typeVersion: 2, parameters: { sources: ["email"] },
    permissions: [...automationTypes.find(type => type.version === 2)!.permissions],
    scope: { workspaceId: doc.id, boardId: board.id, grantId: "grant-one" } })
  const columnId = board.preset!.bindings["status.applied"]!
  const cardId = "card-one"
  doc.entities[cardId] = { id: cardId, title: "Current card label", body: "", values: { company: "Visible Co", role: "Current role" },
    placement: { parentId: columnId, rank: "0/1" }, archivedAt: null, createdAt: timestamp, updatedAt: timestamp,
    workflow: JSON.stringify({ columnId, changedAt: timestamp }) }
  const sourceData = { kind: "application-source-observation" as const, version: 1 as const, recordId: "source-one",
    workspaceId: doc.id, cardId, applicationId: `${doc.id}:${cardId}`, observation: { phase: "original" as const,
      origin: "website" as const, status: "available" as const, observedAt: timestamp,
      jobUrl: "https://jobs.example.test/role/1", company: "Original Co", title: "Original Role", text: "Original listing",
      extractorVersion: "fixture-v1", contentDigest: "D".repeat(43) } }
  const sourceEntity: WorkspaceEntity = { id: "application-source:source-one", kind: "application_source", title: "Application source",
    placement: { parentId: cardId, rank: "0/1" }, archivedAt: null, createdAt: timestamp, updatedAt: timestamp,
    data: canonicalizeJson(sourceData) } as WorkspaceEntity
  doc.entities[sourceEntity.id] = sourceEntity
  const automationId = automationEntityId(definition.id)
  const controlId = "00000000-0000-4000-8000-000000000001"
  const automation: WorkspaceEntity = { id: automationId, kind: "automation", title: "Job intake",
    placement: { parentId: board.id, rank: "20/1" }, archivedAt: null, createdAt: timestamp, updatedAt: timestamp,
    definition: canonicalizeJson(definition), approval: "{}", executor: { origin, personId: "executor-person" },
    controls: { [controlId]: JSON.stringify({ state: "active", supersedes: [] }) } }
  doc.entities[automationId] = automation
  const option: ApplicationReviewOption = { cardId, displayTitle: "Current card label", sourceRecordId: "source-one",
    sourceHash: "S".repeat(43), sourceTitle: "Original Role", sourceCompany: "Original Co", sourceStatus: "available",
    workflow: { columnId, changedAt: timestamp } }
  const response: ApplicationReviewResponse = { kind: "automation-application-review", version: 1, origin,
    integrationId: "legacy-route", definitionId: definition.id, workspaceId: doc.id, eventId: "E".repeat(43),
    eventHash: "H".repeat(43), decisionHash: "D".repeat(43), decisionEvent: "rejection", status: "review",
    subject: "Application update", text: "The application was declined.", sentAt: timestamp, grantId: "grant-one",
    accessEpoch: 1, automationState: "active", binding: null, options: [option], total: 1, offset: 0, hasMore: false }
  let activeProfile: LocalProfile | undefined = profile
  let owner = true
  const host = { getActiveDoc: () => doc, getCurrentProfile: () => activeProfile, owner: () => owner,
    syncNow: vi.fn(async (): Promise<void> => {}), changed: vi.fn(async (): Promise<void> => {}) }
  const state = { profile, doc, definition, option, response, host,
    setProfile: (next: LocalProfile | undefined) => { activeProfile = next }, setOwner: (next: boolean) => { owner = next } }
  return state
}

function localProfile(personId: string, deviceId: string): LocalProfile {
  return { identity: { personId, publicKey: `pub-${personId}`, displayName: "Owner" },
    device: { deviceId, publicKey: `pub-${deviceId}`, displayName: "Owner's device" },
    certificate: { signature: `cert-${deviceId}` }, privateKeys: {} } as unknown as LocalProfile
}

function bindingProof(bindingId = "00000000-0000-4000-8000-000000000099"): ApplicationBindingProof {
  const value = {
    publicKey: "owner-public-key", certificates: [], signed: {
      signerKeyId: "device-one", signature: "signed-proof", payload: {
        kind: "automation-application-binding", version: 1, bindingId, previousBindingId: null,
        origin, integrationId: "legacy-route", definitionId: "typed-intake", workspaceId: "workspace-one",
        cardId: "card-one", grantId: "grant-one", eventId: "E".repeat(43), eventHash: "H".repeat(43),
        decisionHash: "D".repeat(43), sourceRecordId: "source-one", sourceHash: "S".repeat(43), accessEpoch: 1,
        workflow: { columnId: "applied-column", changedAt: timestamp }, personId: "person-one", deviceId: "device-one", issuedAt: 1,
      },
    },
  }
  return value as unknown as ApplicationBindingProof
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

async function openAndSelect(state: State) {
  mockFns.discover.mockResolvedValue({ integrationId: "legacy-route", personId: "executor-person" })
  mockFns.read.mockResolvedValue(state.response)
  mockFns.validate.mockResolvedValue({ source: {}, workflow: state.option.workflow })
  const controller = createApplicationReviewManagement(state.host)
  await controller.open({ definition: state.definition, entity: { executor: { origin, personId: "executor-person" } } }, state.response.eventId)
  expect(controller.review.value).toEqual(state.response)
  controller.select(state.option)
  return controller
}

describe("application review management", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFns.workspaceRole.mockResolvedValue("owner")
    mockFns.admissionAuthority.mockImplementation(async (_doc: WorkspaceDocumentV2, profile: LocalProfile) => ({
      authority: { currentEpoch: 1, currentOwner: { personId: profile.identity.personId } }, fingerprint: "authority-fingerprint" }))
    mockFns.resolveContext.mockResolvedValue({ verified: true })
    mockFns.createBinding.mockImplementation(async (_context: unknown, input: { bindingId?: string }) => bindingProof(input.bindingId))
    mockFns.save.mockResolvedValue({ bindingId: "00000000-0000-4000-8000-000000000099", duplicate: false })
    mockFns.retry.mockResolvedValue({ eventId: "E".repeat(43), status: "pending", duplicate: false })
  })

  it("Given an explicit selected application, When saving, Then store its proof without automatically retrying the mail", async () => {
    const state = fixture()
    const controller = await openAndSelect(state)
    await controller.save()
    expect(mockFns.save).toHaveBeenCalledTimes(1)
    expect(mockFns.retry).not.toHaveBeenCalled()
    expect(controller.saved.value).toBe(true)
    const submitted = mockFns.save.mock.calls[0]?.[1] as { proof: ApplicationBindingProof }
    expect(controller.review.value?.binding).toEqual(submitted.proof)
    expect(state.host.changed).toHaveBeenCalledTimes(1)
  })

  it("Given a lost save response, When saving again, Then reuse the exact pending binding proof and do not retry automatically", async () => {
    const state = fixture()
    const controller = await openAndSelect(state)
    mockFns.save.mockRejectedValueOnce(new Error("Response was lost"))
    await controller.save()
    expect(controller.saved.value).toBe(false)
    expect(controller.failure.value).toContain("Response was lost")
    await controller.save()
    const submitted = mockFns.save.mock.calls.map(([, input]) => input as { proof: ApplicationBindingProof })
    expect(submitted).toHaveLength(2)
    expect(submitted[1]!.proof).toEqual(submitted[0]!.proof)
    expect(submitted[1]!.proof.signed.payload.bindingId).toBe(submitted[0]!.proof.signed.payload.bindingId)
    expect(submitted[1]!.proof.signed.signature).toBe(submitted[0]!.proof.signed.signature)
    expect(mockFns.createBinding).toHaveBeenCalledTimes(1)
    expect(mockFns.retry).not.toHaveBeenCalled()
    expect(controller.saved.value).toBe(true)
  })

  it("Given identity changes during save, When the response arrives, Then do not publish that late binding", async () => {
    const state = fixture()
    const controller = await openAndSelect(state)
    const requestEntered = deferred<void>()
    const response = deferred<{ bindingId: string; duplicate: boolean }>()
    mockFns.save.mockImplementation(async (_profile: LocalProfile, _input: unknown, guards?: { ensureCurrent?: () => void | Promise<void> }) => {
      await guards?.ensureCurrent?.()
      requestEntered.resolve()
      const result = await response.promise
      await guards?.ensureCurrent?.()
      return result
    })
    const pending = controller.save()
    await requestEntered.promise
    state.setProfile(localProfile("person-two", "device-two"))
    response.resolve({ bindingId: "00000000-0000-4000-8000-000000000099", duplicate: false })
    await pending
    expect(controller.review.value?.binding).toBeNull()
    expect(controller.saved.value).toBe(false)
    expect(state.host.changed).not.toHaveBeenCalled()
    expect(controller.failure.value).toMatch(/changed|reopen/i)
  })

  it("Given owner access is revoked before saving, When save runs, Then do not publish a binding request", async () => {
    const state = fixture()
    const controller = await openAndSelect(state)
    state.setOwner(false)
    await controller.save()
    expect(mockFns.resolveContext).not.toHaveBeenCalled()
    expect(mockFns.save).not.toHaveBeenCalled()
    expect(controller.saved.value).toBe(false)
    expect(state.host.changed).not.toHaveBeenCalled()
    expect(controller.failure.value).toMatch(/owner|changed/i)
  })
})
