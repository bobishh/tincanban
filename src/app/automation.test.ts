import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, canonicalizeJson, resetIdentityStorageForTest, verifyEnvelope } from "../domain/identity"
import { createDelegatedCertificate, certHashDefault } from "../domain/proofs"
import { profileFromIdentitySeedForDevice, identitySeedFromPrivateKey } from "@meta-uber/mesh-identity"
import { resolveSigningContext } from "../domain/signingContext"
import { createWorkspaceDoc } from "../domain/seeds"
import { prepareAutomationActivation, type AutomationWorkerIdentity } from "./automation"

beforeEach(resetIdentityStorageForTest)
afterEach(() => vi.useRealTimers())

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

it("Given explicit job-intake v2 approval, when creating the grant and definition, then source append is the exact added permission", async () => {
  const owner = await bootstrapIdentity("Owner")
  const doc = createWorkspaceDoc("automation-v2-test", "Test applications", owner.identity.personId, "job-search")
  resetIdentityStorageForTest()
  const worker = await bootstrapIdentity("Automation")
  const packet = await prepareAutomationActivation({ profile: owner, doc, bytes: new Uint8Array([1]),
    authorization: { version: 1, records: [], authority: { currentOwner: { personId: owner.identity.personId }, currentEpoch: 1 } },
    blind: { workspaceId: doc.id },
    worker: { personId: worker.identity.personId, identityPublicKey: worker.identity.publicKey,
      origin: "https://automation.example.test", deviceId: worker.device.deviceId,
      devicePublicKey: worker.device.publicKey, deviceCertificate: worker.certificate },
    expiresAt: Date.now() + 60_000,
    configuration: { name: "Job intake", type: "job-intake", typeVersion: 2, parameters: { sources: ["website"] } },
  })

  expect(packet.grant.payload.automation?.version).toBe(2)
  expect(packet.definition.payload.typeVersion).toBe(2)
  expect(packet.definition.payload.permissions).toEqual([
    "workspace.read", "board.lead.create", "board.application.advance", "board.application.source.append",
  ])
  expect(await verifyEnvelope(packet.grant, owner.device.publicKey)).toBe(true)
  expect(await verifyEnvelope(packet.definition, owner.device.publicKey)).toBe(true)
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
  const first = await prepareAutomationActivation({ ...input, configuration: {
    name: "Job intake", type: "job-intake", typeVersion: 1, parameters: { sources: ["website"] },
  } })
  expect(first.grant.payload.automation?.version).toBe(1)
  expect(first.definition.payload.typeVersion).toBe(1)
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

it("Given an expired paused approval, when owner explicitly renews, then keep typed definition identity and requested expiry", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"))
  const owner = await bootstrapIdentity("Owner")
  const doc = createWorkspaceDoc("automation-renewal", "Applications", owner.identity.personId, "job-search")
  resetIdentityStorageForTest()
  const worker = await bootstrapIdentity("Automation")
  const definitionId = "typed-existing"
  const legacyRouteId = "legacy-route"
  const initialExpiry = Date.now() + 1_000
  const requestedExpiry = initialExpiry + 120_000
  const workerDescriptor: AutomationWorkerIdentity = { origin: "https://automation.example.test", integrationId: legacyRouteId, definitionId,
    personId: worker.identity.personId, identityPublicKey: worker.identity.publicKey, deviceId: worker.device.deviceId,
    devicePublicKey: worker.device.publicKey, deviceCertificate: worker.certificate }
  const input = { profile: owner, doc, bytes: new Uint8Array([1]),
    authorization: { version: 1 as const, records: [], authority: { currentOwner: { personId: owner.identity.personId }, currentEpoch: 1 } },
    blind: { workspaceId: doc.id }, worker: workerDescriptor, expiresAt: initialExpiry }
  const initial = await prepareAutomationActivation({ ...input, configuration: {
    name: "Typed intake", type: "job-intake", typeVersion: 1, parameters: { sources: ["website", "email"] },
  } })
  expect(initial.definition.payload.id).toBe(definitionId)
  const entityId = `automation:${definitionId}`
  const pausedHead = crypto.randomUUID()
  doc.entities[entityId] = { id: entityId, kind: "automation", title: initial.definition.payload.name,
    definition: JSON.stringify(initial.definition.payload), approval: JSON.stringify({ definition: initial.definition, grant: initial.grant }),
    executor: { origin: workerDescriptor.origin, personId: worker.identity.personId },
    controls: { [pausedHead]: JSON.stringify({ state: "paused", supersedes: [] }) },
    placement: { parentId: initial.bindings.boardId, rank: "0/1" }, archivedAt: null,
    createdAt: "2026-10-15T10:00:00.000Z", updatedAt: "2026-10-15T10:00:00.000Z" }

  const retry = await prepareAutomationActivation({ ...input, expiresAt: requestedExpiry })
  expect(retry.grant).toEqual(initial.grant)
  expect(retry.definition).toEqual(initial.definition)
  expect(doc.entities[entityId]?.controls).toEqual({ [pausedHead]: JSON.stringify({ state: "paused", supersedes: [] }) })

  vi.setSystemTime(new Date(initialExpiry + 1))
  const renewed = await prepareAutomationActivation({ ...input, expiresAt: requestedExpiry, configuration: {
    name: "Typed intake", type: "job-intake", typeVersion: 1, parameters: { sources: ["website", "email"] },
  } })
  expect(renewed.grant.payload.automation?.expiresAt).toBe(requestedExpiry)
  expect(renewed.grant.payload.automation?.expiresAt).toBeGreaterThan(initial.grant.payload.automation!.expiresAt)
  expect(renewed.definition.payload.id).toBe(definitionId)
  expect(renewed.definition.payload.scope).toMatchObject({ workspaceId: doc.id, boardId: initial.bindings.boardId })
  expect(renewed.grant.payload.personId).toBe(initial.grant.payload.personId)
  expect(renewed.grant.payload.grantId).toBe(renewed.definition.payload.scope.grantId)
  expect(doc.entities[entityId]?.controls).toEqual({ [pausedHead]: JSON.stringify({ state: "paused", supersedes: [] }) })
})

it("Given an expired email approval, when the owner renews website-only access, then validate old scope before narrowing the new grant", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"))
  const owner = await bootstrapIdentity("Owner")
  const doc = createWorkspaceDoc("automation-narrow-renewal", "Applications", owner.identity.personId, "job-search")
  resetIdentityStorageForTest()
  const worker = await bootstrapIdentity("Automation")
  const workerDescriptor: AutomationWorkerIdentity = { origin: "https://automation.example.test", integrationId: "renewal-route",
    definitionId: "narrow-renewal", personId: worker.identity.personId, identityPublicKey: worker.identity.publicKey,
    deviceId: worker.device.deviceId, devicePublicKey: worker.device.publicKey, deviceCertificate: worker.certificate }
  const input = { profile: owner, doc, bytes: new Uint8Array([1]),
    authorization: { version: 1 as const, records: [], authority: { currentOwner: { personId: owner.identity.personId }, currentEpoch: 1 } },
    blind: { workspaceId: doc.id }, worker: workerDescriptor, expiresAt: Date.now() + 1_000 }
  const original = await prepareAutomationActivation({ ...input, configuration: {
    name: "Email intake", type: "job-intake", typeVersion: 1, parameters: { sources: ["website", "email"] },
  } })
  const entityId = `automation:${workerDescriptor.definitionId}`
  const controlId = crypto.randomUUID()
  const priorApproval = JSON.stringify({ definition: original.definition, grant: original.grant })
  doc.entities[entityId] = { id: entityId, kind: "automation", title: original.definition.payload.name,
    definition: JSON.stringify(original.definition.payload), approval: priorApproval,
    executor: { origin: workerDescriptor.origin, personId: worker.identity.personId },
    controls: { [controlId]: JSON.stringify({ state: "paused", supersedes: [] }) },
    placement: { parentId: original.bindings.boardId, rank: "0/1" }, archivedAt: null,
    createdAt: "2026-10-15T10:00:00.000Z", updatedAt: "2026-10-15T10:00:00.000Z" }

  vi.setSystemTime(new Date(Date.now() + 2_000))
  const renewed = await prepareAutomationActivation({ ...input, expiresAt: Date.now() + 120_000, configuration: {
    name: "Website-only intake", type: "job-intake", typeVersion: 1, parameters: { sources: ["website"] },
  } })
  expect(renewed.grant.payload.automation?.columns.applied).toBeUndefined()
  expect(renewed.grant.payload.grantId).not.toBe(original.grant.payload.grantId)
  expect(doc.entities[entityId]?.kind === "automation" && doc.entities[entityId].approval).toBe(priorApproval)
})

it("Given an owner profile with another device's private key, when preparing activation, then reject before returning signed approval", async () => {
  const owner = await bootstrapIdentity("Owner")
  const doc = createWorkspaceDoc("bad-owner-key", "Applications", owner.identity.personId, "job-search")
  resetIdentityStorageForTest()
  const worker = await bootstrapIdentity("Automation")
  owner.privateKeys.devicePrivateKey = worker.privateKeys.devicePrivateKey
  await expect(prepareAutomationActivation({ profile: owner, doc, bytes: new Uint8Array([1]),
    authorization: { version: 1, records: [], authority: { currentOwner: { personId: owner.identity.personId }, currentEpoch: 1 } },
    blind: { workspaceId: doc.id }, worker: { origin: "https://automation.example.test", personId: worker.identity.personId,
      identityPublicKey: worker.identity.publicKey, deviceId: worker.device.deviceId, devicePublicKey: worker.device.publicKey,
      deviceCertificate: worker.certificate }, expiresAt: Date.now() + 60_000 })).rejects.toThrow(/key|sign|certificate/i)
})

it("Given an owner device with a certified ancestor, when approving, then sign grant and definition with complete leaf evidence", async () => {
  const root = await bootstrapIdentity("Owner root")
  const seed = await identitySeedFromPrivateKey(root.privateKeys.identityPrivateKey!, root.identity.personId)
  const issuer = await profileFromIdentitySeedForDevice(seed, "Owner issuer", new Uint8Array(32).fill(31))
  const child = await profileFromIdentitySeedForDevice(seed, "Owner delegated device", new Uint8Array(32).fill(47))
  const leaf = await createDelegatedCertificate(issuer.privateKeys.devicePrivateKey, issuer.device.deviceId,
    root.identity.personId, child.device.deviceId, child.device.publicKey, await certHashDefault(issuer.certificate))
  const owner = { ...child, certificate: leaf }
  const doc = createWorkspaceDoc("delegated-owner", "Applications", root.identity.personId, "job-search")
  resetIdentityStorageForTest()
  const worker = await bootstrapIdentity("Automation")
  const authority = { currentOwner: { personId: root.identity.personId,
    publicKey: root.identity.publicKey, certificates: [issuer.certificate] }, currentEpoch: 1 as const }
  const authorization = { version: 1 as const, records: [], authority }
  const packet = await prepareAutomationActivation({ profile: owner, doc, bytes: new Uint8Array([1]), authorization,
    blind: { workspaceId: doc.id }, worker: { origin: "https://automation.example.test", personId: worker.identity.personId,
      identityPublicKey: worker.identity.publicKey, deviceId: worker.device.deviceId, devicePublicKey: worker.device.publicKey,
      deviceCertificate: worker.certificate }, expiresAt: Date.now() + 60_000,
    configuration: { name: "Delegated intake", type: "job-intake", typeVersion: 1, parameters: { sources: ["email"] } },
    signingContext: (purpose, binding) => resolveSigningContext({ profile: owner, certificates: [leaf, issuer.certificate],
      purpose, binding, authorityRevision: canonicalizeJson(authority), current: async () => ({
        personId: owner.identity.personId, deviceId: owner.device.deviceId, authorityRevision: canonicalizeJson(authority),
      }) }) })
  expect(packet.grant.signerKeyId).toBe(child.device.deviceId)
  expect(packet.definition.signerKeyId).toBe(child.device.deviceId)
  expect(packet.grant.payload.personId).toBe(worker.identity.personId)
  expect(packet.initial.authorization.authority.currentOwner.certificates).toEqual(expect.arrayContaining([leaf, issuer.certificate]))
  expect(packet.initial.authorization.authority.currentOwner.certificates).toHaveLength(2)
  expect(authorization.authority.currentOwner.certificates).toEqual([issuer.certificate])
  expect(await verifyEnvelope(packet.grant, child.device.publicKey)).toBe(true)
  expect(await verifyEnvelope(packet.definition, child.device.publicKey)).toBe(true)
})

it("Given mutable activation inputs, when caller changes them immediately, then sign the original captured intent", async () => {
  const owner = await bootstrapIdentity("Owner")
  const doc = createWorkspaceDoc("capture-original", "Applications", owner.identity.personId, "job-search")
  resetIdentityStorageForTest()
  const worker = await bootstrapIdentity("Automation")
  const bytes = new Uint8Array([1])
  const workerDescriptor: AutomationWorkerIdentity = { origin: "https://automation.example.test", personId: worker.identity.personId,
    identityPublicKey: worker.identity.publicKey, deviceId: worker.device.deviceId, devicePublicKey: worker.device.publicKey,
    deviceCertificate: worker.certificate }
  const configuration = { name: "Original intake", type: "job-intake" as const, typeVersion: 1 as const,
    parameters: { sources: ["website", "email"] as Array<"website" | "email"> } }
  const blind = { workspaceId: doc.id }
  const authority = { currentOwner: { personId: owner.identity.personId }, currentEpoch: 1 }
  const input = { profile: owner, doc, bytes, authorization: { version: 1 as const, records: [], authority }, blind,
    worker: workerDescriptor, expiresAt: Date.now() + 60_000, configuration }
  const pending = prepareAutomationActivation(input)
  workerDescriptor.personId = "mutated-person"
  workerDescriptor.origin = "https://mutated.example.test"
  configuration.name = "Mutated intake"
  configuration.parameters.sources.splice(0, 2, "website")
  doc.id = "mutated-workspace"
  blind.workspaceId = "mutated-workspace"
  bytes[0] = 9
  const packet = await pending
  expect(packet.workspaceId).toBe("capture-original")
  expect(packet.definition.payload.id).toBe(worker.identity.personId)
  expect(packet.definition.payload.name).toBe("Original intake")
  expect(packet.definition.payload.parameters.sources).toEqual(["website", "email"])
  expect(packet.grant.payload.personId).toBe(worker.identity.personId)
  expect(packet.initial.document).toBe("AQ")
})

it("Given owner authority changes while signer resolves, when approval resumes, then reject stale owner authority", async () => {
  const owner = await bootstrapIdentity("Owner")
  const doc = createWorkspaceDoc("stale-authority", "Applications", owner.identity.personId, "job-search")
  resetIdentityStorageForTest()
  const worker = await bootstrapIdentity("Automation")
  const other = "different-owner"
  const authority = { currentOwner: { personId: owner.identity.personId }, currentEpoch: 1 }
  const snapshot = canonicalizeJson(authority)
  let entered!: () => void
  let release!: () => void
  const atSigner = new Promise<void>(resolve => { entered = resolve })
  const holdSigner = new Promise<void>(resolve => { release = resolve })
  let first = true
  const signingContext = async (purpose: string, binding: Record<string, string | number>) => {
    if (first) { first = false; entered(); await holdSigner }
    return resolveSigningContext({ profile: owner, certificates: [owner.certificate], purpose, binding,
      authorityRevision: snapshot, current: async () => ({ personId: owner.identity.personId, deviceId: owner.device.deviceId,
        authorityRevision: canonicalizeJson(authority) }) })
  }
  const pending = prepareAutomationActivation({ profile: owner, doc, bytes: new Uint8Array([1]),
    authorization: { version: 1 as const, records: [], authority }, blind: { workspaceId: doc.id },
    worker: { origin: "https://automation.example.test", personId: worker.identity.personId,
      identityPublicKey: worker.identity.publicKey, deviceId: worker.device.deviceId, devicePublicKey: worker.device.publicKey,
      deviceCertificate: worker.certificate }, expiresAt: Date.now() + 60_000,
    configuration: { name: "Current approval", type: "job-intake", typeVersion: 1, parameters: { sources: ["email"] } },
    signingContext })
  await atSigner
  authority.currentOwner.personId = other
  release()
  await expect(pending).rejects.toThrow(/stale|authority/i)
})
