import { beforeEach, describe, expect, it } from "vitest"
import { createApplicationBinding, parseApplicationBindingProof, verifyApplicationBinding, type ApplicationBindingInput } from "./applicationBinding"
import { bootstrapIdentity, resetIdentityStorageForTest, signEnvelope, type LocalProfile } from "./identity"
import { certHashDefault, createDelegatedCertificate } from "./proofs"
import { resolveSigningContext, type VerifiedSigningContext } from "./signingContext"

const origin = "https://automation.example.test"
const digest = "a".repeat(43)

function input(): ApplicationBindingInput {
  return {
    bindingId: crypto.randomUUID(), previousBindingId: null, origin, integrationId: "application-worker", definitionId: "application-definition",
    workspaceId: "workspace-1", cardId: "card-1", grantId: "grant-1", eventId: "A".repeat(32),
    eventHash: digest, decisionHash: "b".repeat(43), sourceRecordId: "source-record-1", sourceHash: "c".repeat(43),
    accessEpoch: 4, workflow: { columnId: "applied", changedAt: "2026-10-14T10:00:00.000Z" },
  }
}

async function contextFor(profile: LocalProfile, scope = input(), current: () => Promise<{ personId: string; deviceId: string; authorityRevision: string }> = async () => ({
  personId: profile.identity.personId, deviceId: profile.device.deviceId, authorityRevision: "authority-1",
})) {
  return resolveSigningContext({ profile, certificates: [], purpose: "automation-application-binding", authorityRevision: "authority-1",
    binding: { origin: scope.origin, integrationId: scope.integrationId, definitionId: scope.definitionId,
      workspaceId: scope.workspaceId, cardId: scope.cardId,
      grantId: scope.grantId, eventId: scope.eventId, eventHash: scope.eventHash, decisionHash: scope.decisionHash,
      sourceRecordId: scope.sourceRecordId, sourceHash: scope.sourceHash, accessEpoch: scope.accessEpoch }, current })
}

function expected(scope: ApplicationBindingInput, ownerPersonId: string) {
  return { ownerPersonId, origin: scope.origin, integrationId: scope.integrationId, definitionId: scope.definitionId,
    workspaceId: scope.workspaceId,
    cardId: scope.cardId, grantId: scope.grantId, eventId: scope.eventId, eventHash: scope.eventHash,
    decisionHash: scope.decisionHash, sourceRecordId: scope.sourceRecordId, sourceHash: scope.sourceHash,
    accessEpoch: scope.accessEpoch, workflow: scope.workflow }
}

describe("owner-signed application binding proof", () => {
  beforeEach(() => resetIdentityStorageForTest())

  it("Given a verified owner signing context, When creating a binding proof, Then verify the exact source, event, grant and workflow", async () => {
    const owner = await bootstrapIdentity("Application owner")
    const scope = input()
    const proof = await createApplicationBinding(await contextFor(owner, scope), scope)
    expect(parseApplicationBindingProof(proof)).toEqual(proof)
    expect(proof.signed.payload).toMatchObject({ kind: "automation-application-binding", version: 1,
      personId: owner.identity.personId, deviceId: owner.device.deviceId, ...scope })
    expect(await verifyApplicationBinding(proof, expected(scope, owner.identity.personId))).toMatchObject(scope)
  })

  it("Given a valid proof, When any signed binding field is altered or expected scope differs, Then reject it", async () => {
    const owner = await bootstrapIdentity("Application owner")
    const scope = input()
    const proof = await createApplicationBinding(await contextFor(owner, scope), scope)
    const mutations: Array<(payload: Record<string, unknown>) => void> = [
      payload => { payload.bindingId = crypto.randomUUID() },
      payload => { payload.previousBindingId = crypto.randomUUID() },
      payload => { payload.origin = "https://other.example.test" },
      payload => { payload.integrationId = "other-worker" },
      payload => { payload.definitionId = "other-definition" },
      payload => { payload.workspaceId = "workspace-2" },
      payload => { payload.cardId = "card-2" },
      payload => { payload.grantId = "grant-2" },
      payload => { payload.eventId = "B".repeat(32) },
      payload => { payload.eventHash = "d".repeat(43) },
      payload => { payload.decisionHash = "e".repeat(43) },
      payload => { payload.sourceRecordId = "source-record-2" },
      payload => { payload.sourceHash = "f".repeat(43) },
      payload => { payload.accessEpoch = 5 },
      payload => { payload.workflow = { columnId: "interview", changedAt: "2026-10-14T10:00:00.000Z" } },
      payload => { payload.issuedAt = 1 },
      payload => { payload.personId = "another-person" },
      payload => { payload.deviceId = "another-device" },
    ]
    for (const mutate of mutations) {
      const altered = structuredClone(proof)
      mutate(altered.signed.payload as unknown as Record<string, unknown>)
      await expect(verifyApplicationBinding(altered, expected(scope, owner.identity.personId))).rejects.toThrow()
    }
    for (const key of ["origin", "integrationId", "definitionId", "workspaceId", "cardId", "grantId", "eventId", "eventHash",
      "decisionHash", "sourceRecordId", "sourceHash", "accessEpoch", "workflow"] as const) {
      const alteredExpected = { ...expected(scope, owner.identity.personId), [key]: key === "workflow" ? { ...scope.workflow, columnId: "other" }
        : key === "accessEpoch" ? scope.accessEpoch + 1 : `other-${key}` }
      await expect(verifyApplicationBinding(proof, alteredExpected)).rejects.toThrow()
    }
  })

  it("Given a proof from one identity, When another owner or a replaced root key verifies it, Then reject it", async () => {
    const owner = await bootstrapIdentity("Application owner")
    resetIdentityStorageForTest()
    const other = await bootstrapIdentity("Different owner")
    const scope = input()
    const proof = await createApplicationBinding(await contextFor(owner, scope), scope)
    await expect(verifyApplicationBinding(proof, expected(scope, other.identity.personId))).rejects.toThrow(/owner|identity|signature/i)
    await expect(verifyApplicationBinding({ ...proof, publicKey: other.identity.publicKey }, expected(scope, owner.identity.personId)))
      .rejects.toThrow(/owner|identity|signature/i)
  })

  it("Given a delegated owner device, When its complete chain signs a binding, Then verify it and reject a missing ancestor", async () => {
    const owner = await bootstrapIdentity("Application owner")
    resetIdentityStorageForTest()
    const temporary = await bootstrapIdentity("Temporary device")
    const leaf = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
      owner.identity.personId, temporary.device.deviceId, temporary.device.publicKey, await certHashDefault(owner.certificate))
    const delegated: LocalProfile = { ...temporary, identity: owner.identity, certificate: leaf,
      privateKeys: { devicePrivateKey: temporary.privateKeys.devicePrivateKey } }
    const scope = input()
    const context = await resolveSigningContext({ profile: delegated, certificates: [owner.certificate],
      purpose: "automation-application-binding", authorityRevision: "authority-1",
      binding: { origin: scope.origin, integrationId: scope.integrationId, definitionId: scope.definitionId,
        workspaceId: scope.workspaceId,
        cardId: scope.cardId, grantId: scope.grantId, eventId: scope.eventId, eventHash: scope.eventHash,
        decisionHash: scope.decisionHash, sourceRecordId: scope.sourceRecordId, sourceHash: scope.sourceHash,
        accessEpoch: scope.accessEpoch },
      current: async () => ({ personId: owner.identity.personId, deviceId: delegated.device.deviceId, authorityRevision: "authority-1" }) })
    const proof = await createApplicationBinding(context, scope)
    expect(proof.certificates).toHaveLength(2)
    expect(await verifyApplicationBinding(proof, expected(scope, owner.identity.personId))).toMatchObject(scope)
    await expect(verifyApplicationBinding({ ...proof, certificates: [leaf] }, expected(scope, owner.identity.personId)))
      .rejects.toThrow(/certificate|ancestor|chain/i)
  })

  it("Given an untrusted or stale context, When creating a binding, Then reject without trusting caller authority", async () => {
    const owner = await bootstrapIdentity("Application owner")
    const scope = input()
    await expect(createApplicationBinding({ personId: owner.identity.personId, deviceId: owner.device.deviceId,
      purpose: "automation-application-binding", domain: "MATCH/1", authorityRevision: "authority-1" } as VerifiedSigningContext, scope))
      .rejects.toThrow(/forged|unknown|context/i)

    let authorityRevision = "authority-1"
    let block = false
    let entered!: () => void
    let release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const context = await contextFor(owner, scope, async () => {
      if (block) { entered(); await gate }
      return { personId: owner.identity.personId, deviceId: owner.device.deviceId, authorityRevision }
    })
    block = true
    const pending = createApplicationBinding(context, scope)
    await waiting
    authorityRevision = "revoked-or-replaced"
    release()
    await expect(pending).rejects.toThrow(/stale|authority/i)
  })

  it("Given caller input changes during asynchronous signing, When creating a binding, Then sign the entry snapshot", async () => {
    const owner = await bootstrapIdentity("Application owner")
    const scope = input()
    let block = false
    let entered!: () => void
    let release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const context = await contextFor(owner, scope, async () => {
      if (block) { entered(); await gate }
      return { personId: owner.identity.personId, deviceId: owner.device.deviceId, authorityRevision: "authority-1" }
    })
    block = true
    const pending = createApplicationBinding(context, scope)
    await waiting
    scope.cardId = "mutated-card"
    scope.eventHash = "z".repeat(43)
    release()
    const proof = await pending
    expect(proof.signed.payload.cardId).toBe("card-1")
    expect(proof.signed.payload.eventHash).toBe(digest)
  })

  it("Given historical signed evidence, When verifying after its issued time, Then audit signature without imposing freshness", async () => {
    const owner = await bootstrapIdentity("Application owner")
    const scope = input()
    const context = await contextFor(owner, scope)
    const proof = await createApplicationBinding(context, scope)
    const payload = { ...proof.signed.payload, issuedAt: 1 }
    const signed = await signEnvelope(owner.privateKeys.devicePrivateKey, payload, owner.device.deviceId)
    expect(await verifyApplicationBinding({ ...proof, signed }, expected(scope, owner.identity.personId))).toMatchObject({ issuedAt: 1 })
  })

  it("Given malformed or oversized proof data, When parsing, Then reject unknown schema and invalid workflow", async () => {
    const owner = await bootstrapIdentity("Application owner")
    const scope = input()
    const proof = await createApplicationBinding(await contextFor(owner, scope), scope)
    expect(() => parseApplicationBindingProof({ ...proof, unknown: true })).toThrow()
    const invalidWorkflow = structuredClone(proof)
    ;(invalidWorkflow.signed.payload.workflow as { changedAt: string }).changedAt = "yesterday"
    expect(() => parseApplicationBindingProof(invalidWorkflow)).toThrow()
    const oversized = { ...proof, extension: "x".repeat(130_000) }
    expect(() => parseApplicationBindingProof(oversized)).toThrow(/size|schema/i)
  })
})
