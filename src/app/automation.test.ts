import { beforeEach, expect, it } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, verifyEnvelope } from "../domain/identity"
import { createWorkspaceDoc } from "../domain/seeds"
import { prepareAutomationActivation } from "./automation"

beforeEach(resetIdentityStorageForTest)

it("Given owner and job board, when approving Worker, then grants only bound columns and fields", async () => {
  const owner = await bootstrapIdentity("Owner")
  const doc = createWorkspaceDoc("automation-test", "Test applications", owner.identity.personId, "job-search")
  resetIdentityStorageForTest()
  const worker = await bootstrapIdentity("Automation")
  const authority = { currentOwner: { personId: owner.identity.personId }, currentEpoch: 1 }
  const packet = await prepareAutomationActivation({ profile: owner, doc, bytes: new Uint8Array([1]),
    authorization: { version: 1, records: [], authority }, blind: { workspaceId: doc.id },
    worker: { personId: worker.identity.personId, identityPublicKey: worker.identity.publicKey,
      origin: "https://automation.example.test",
      deviceId: worker.device.deviceId, devicePublicKey: worker.device.publicKey, deviceCertificate: worker.certificate },
    expiresAt: Date.now() + 60_000 })
  expect(packet.grant.payload.role).toBe("automation")
  expect(packet.grant.payload.personId).toBe(worker.identity.personId)
  expect(packet.grant.payload.automation?.columns).toEqual(packet.bindings.columns)
  expect(packet.grant.payload.automation?.fieldIds).toEqual(Object.values(packet.bindings.fieldIds))
  expect(packet.initial.document).toBe("AQ")
  expect(packet.version).toBe(2)
  expect(packet.definition.payload).toMatchObject({
    kind: "automation-definition", version: 1, type: "job-intake", typeVersion: 1,
    parameters: { sources: ["website", "email"] },
    scope: { workspaceId: doc.id, boardId: packet.bindings.boardId, grantId: packet.grant.payload.grantId },
  })
  expect(await verifyEnvelope(packet.definition, owner.device.publicKey)).toBe(true)
  await expect(prepareAutomationActivation({ profile: worker, doc, bytes: new Uint8Array([1]),
    authorization: { version: 1, records: [], authority }, blind: { workspaceId: doc.id },
    worker: { personId: worker.identity.personId, identityPublicKey: worker.identity.publicKey,
      origin: "https://automation.example.test",
      deviceId: worker.device.deviceId, devicePublicKey: worker.device.publicKey, deviceCertificate: worker.certificate },
    expiresAt: Date.now() + 60_000 })).rejects.toThrow(/owner/i)
})

it("Given an existing paused automation, when activation export retries, then it reuses the public approval and cannot resurrect a deleted instance", async () => {
  const owner = await bootstrapIdentity("Owner")
  const doc = createWorkspaceDoc("retry-automation", "Applications", owner.identity.personId, "job-search")
  resetIdentityStorageForTest()
  const worker = await bootstrapIdentity("Automation")
  const input = { profile: owner, doc, bytes: new Uint8Array([1]),
    authorization: { version: 1 as const, records: [], authority: { currentOwner: { personId: owner.identity.personId }, currentEpoch: 1 } },
    blind: { workspaceId: doc.id }, worker: { origin: "https://automation.example.test", integrationId: "intake-retry",
      personId: worker.identity.personId, identityPublicKey: worker.identity.publicKey, deviceId: worker.device.deviceId,
      devicePublicKey: worker.device.publicKey, deviceCertificate: worker.certificate }, expiresAt: Date.now() + 60_000 }
  const first = await prepareAutomationActivation(input)
  const id = `automation:${first.definition.payload.id}`
  const head = crypto.randomUUID()
  doc.entities[id] = { id, kind: "automation", title: first.definition.payload.name,
    definition: JSON.stringify(first.definition.payload), approval: JSON.stringify({ definition: first.definition, grant: first.grant }),
    executor: { origin: input.worker.origin, personId: worker.identity.personId },
    controls: { [head]: JSON.stringify({ state: "paused", supersedes: [] }) },
    placement: { parentId: first.bindings.boardId, rank: "0/1" }, archivedAt: null,
    createdAt: "2026-10-09T12:00:00.000Z", updatedAt: "2026-10-09T12:00:00.000Z" }
  const retry = await prepareAutomationActivation({ ...input, expiresAt: Date.now() + 120_000 })
  expect(retry.grant).toEqual(first.grant)
  expect(retry.definition).toEqual(first.definition)
  const renewed = await prepareAutomationActivation({ ...input, configuration: {
    name: "Job intake", type: "job-intake", typeVersion: 1, parameters: { sources: ["website", "email"] },
  } })
  expect(renewed.grant.payload.grantId).not.toBe(first.grant.payload.grantId)
  expect(renewed.grant.payload.personId).toBe(first.grant.payload.personId)
  expect(renewed.grant.payload.automation?.columns.applied).toBeDefined()
  const record = doc.entities[id]
  if (record.kind !== "automation") throw new Error("Missing record")
  record.controls[crypto.randomUUID()] = JSON.stringify({ state: "deleted", supersedes: [head] })
  await expect(prepareAutomationActivation(input)).rejects.toThrow(/deleted/i)
})
