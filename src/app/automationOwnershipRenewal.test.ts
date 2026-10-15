import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { beforeAll, beforeEach, expect, it, vi } from "vitest"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, verifyEnvelope } from "../domain/identity"
import { executeCommand as executeCommandWithoutSigningContext } from "../domain/commands"
import { automationEntityId } from "../domain/automationLifecycle"
import { createWorkspaceDoc } from "../domain/seeds"
import { resolveSigningContext } from "../domain/signingContext"
import { createWorkspaceDeviceRevocation, createWorkspaceOwnershipTransfer } from "../../vendor/meta-mesh/packages/mesh-workspace/src/index"
import { prepareAutomationActivation, type AutomationWorkerIdentity } from "./automation"
import { authorizeHistoricalChanges as authorizeLocalChanges, recordHistoricalGenesis as recordGenesisAuthority } from "../sync/workspaceSigning.testSupport"
import type { WorkspaceDocumentV2 } from "../domain/model"

async function executeFixtureCommand(...args: Parameters<typeof executeCommandWithoutSigningContext>) {
  const [doc, command, profile, actorId, authorityGrantHash] = args
  const revision = `fixture:${profile.identity.personId}:${profile.device.deviceId}`
  return executeCommandWithoutSigningContext(doc, command, profile, actorId, authorityGrantHash,
    (purpose, binding) => resolveSigningContext({ profile, certificates: [profile.certificate], purpose, binding,
      authorityRevision: revision, current: async () => ({ personId: profile.identity.personId,
        deviceId: profile.device.deviceId, authorityRevision: revision }) }))
}

beforeEach(resetIdentityStorageForTest)

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  await Automerge.initializeWasm(new Uint8Array(wasm))
  await initializeAutomerge()
})

async function ownershipFixture() {
  const owner = await bootstrapIdentity("Original owner")
  resetIdentityStorageForTest()
  const successor = await bootstrapIdentity("Successor")
  resetIdentityStorageForTest()
  const worker = await bootstrapIdentity("Automation executor")
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Applications", owner.identity.personId, "job-search"))
  const records = await recordGenesisAuthority(doc, owner)
  const workerDescriptor: AutomationWorkerIdentity = { origin: "https://automation.example.test",
    integrationId: "legacy-route-id", definitionId: "typed-owner-renewal", personId: worker.identity.personId,
    identityPublicKey: worker.identity.publicKey, deviceId: worker.device.deviceId,
    devicePublicKey: worker.device.publicKey, deviceCertificate: worker.certificate }
  const genesisOwner = { personId: owner.identity.personId, publicKey: owner.identity.publicKey,
    certificates: [owner.certificate] }
  const successorAuthority = { personId: successor.identity.personId, publicKey: successor.identity.publicKey,
    certificates: [successor.certificate] }
  const initialAuthority = { genesisOwner, genesisEpoch: 1, currentOwner: genesisOwner, currentEpoch: 1,
    ownershipTransfers: [], successionClaims: [], revocations: [], deviceRevocations: [], departures: [] }
  const configuration = { name: "Owner approved intake", type: "job-intake" as const, typeVersion: 1 as const,
    parameters: { sources: ["website", "email"] as Array<"website" | "email"> } }
  const expiresAt = Date.now() + 60 * 60_000
  const first = await prepareAutomationActivation({ profile: owner, doc, bytes: Automerge.save(doc),
    authorization: { version: 1 as const, records, authority: initialAuthority }, blind: { workspaceId: doc.id },
    worker: workerDescriptor, expiresAt, configuration })
  const created = await executeFixtureCommand(doc, { kind: "createAutomation", definition: first.definition.payload,
    approval: JSON.stringify({ definition: first.definition, grant: first.grant }),
    executor: { origin: workerDescriptor.origin, personId: worker.identity.personId } }, owner)
  if (!created.ok) throw new Error(created.error.message)
  let current = created.value.newDoc
  records.push(...await authorizeLocalChanges(current, owner, [created.value.receipt.changeHash]))
  Automerge.free(doc)
  const paused = await executeFixtureCommand(current, { kind: "setAutomationState", automationId: automationEntityId(workerDescriptor.definitionId!),
    state: "paused" }, owner)
  if (!paused.ok) throw new Error(paused.error.message)
  records.push(...await authorizeLocalChanges(paused.value.newDoc, owner, [paused.value.receipt.changeHash]))
  Automerge.free(current)
  current = paused.value.newDoc
  const transfer = await createWorkspaceOwnershipTransfer(owner, current.id, successorAuthority,
    Automerge.getHeads(current), 2)
  const authority = { genesisOwner, genesisEpoch: 1, currentOwner: successorAuthority, currentEpoch: 2,
    ownershipTransfers: [transfer], successionClaims: [], revocations: [], deviceRevocations: [], departures: [] }
  const authorization = { version: 1 as const, records: structuredClone(records), authority }
  const renewedInput = { profile: successor, doc: current as unknown as WorkspaceDocumentV2, bytes: Automerge.save(current),
    authorization, blind: { workspaceId: current.id }, worker: workerDescriptor,
    expiresAt: Date.now() + 2 * 60 * 60_000, configuration }
  return { owner, successor, worker, workerDescriptor, current, records, transfer, authority, authorization, configuration,
    first, renewedInput, expiresAt }
}

it("Given an existing typed executor transferred at causal heads, When its successor explicitly renews, Then issue a successor-signed epoch grant without changing prior approval or controls", async () => {
  const fixture = await ownershipFixture()
  try {
  const entity = fixture.current.entities[automationEntityId(fixture.workerDescriptor.definitionId!)]
  if (entity?.kind !== "automation") throw new Error("Expected typed automation entity")
  const originalApproval = entity.approval
  const originalControls = structuredClone(entity.controls)

  const renewed = await prepareAutomationActivation(fixture.renewedInput)

  expect(renewed.definition.payload.id).toBe(fixture.first.definition.payload.id)
  expect(renewed.definition.payload.scope).toMatchObject({ workspaceId: fixture.current.id,
    boardId: fixture.first.bindings.boardId })
  expect(renewed.grant.payload.personId).toBe(fixture.worker.identity.personId)
  expect(renewed.grant.payload.accessEpoch).toBe(2)
  expect(renewed.grant.payload.automation?.expiresAt).toBe(fixture.renewedInput.expiresAt)
  expect(renewed.grant.payload.grantId).not.toBe(fixture.first.grant.payload.grantId)
  expect(renewed.grant.signerKeyId).toBe(fixture.successor.device.deviceId)
  expect(renewed.definition.signerKeyId).toBe(fixture.successor.device.deviceId)
  expect(await verifyEnvelope(renewed.grant, fixture.successor.device.publicKey)).toBe(true)
  expect(await verifyEnvelope(renewed.definition, fixture.successor.device.publicKey)).toBe(true)
  expect(entity.approval).toBe(originalApproval)
  expect(entity.controls).toEqual(originalControls)

  await expect(prepareAutomationActivation({ ...fixture.renewedInput, configuration: undefined }))
    .rejects.toThrow(/renew|approval|owner|transfer/i)
  } finally { Automerge.free(fixture.current) }
})

it("Given invalid ownership evidence or a changed old approval, When successor requests renewal, Then reject before requesting a signing context", async () => {
  const fixture = await ownershipFixture()
  try {
  const signingContext = vi.fn(async (purpose: string, binding: Record<string, string | number>) => {
    return resolveSigningContext({ profile: fixture.successor, certificates: [fixture.successor.certificate], purpose, binding,
      authorityRevision: "test-current-successor", current: async () => ({ personId: fixture.successor.identity.personId,
        deviceId: fixture.successor.device.deviceId, authorityRevision: "test-current-successor" }) })
  })
  const attempt = (input: typeof fixture.renewedInput) => prepareAutomationActivation({ ...input, signingContext })

  const forgedTransfer = structuredClone(fixture.renewedInput)
  const transfer = forgedTransfer.authorization.authority.ownershipTransfers[0]!
  transfer.signature = `${transfer.signature[0] === "A" ? "B" : "A"}${transfer.signature.slice(1)}`
  await expect(attempt(forgedTransfer)).rejects.toThrow()
  expect(signingContext).not.toHaveBeenCalled()

  const wrongOwnerClaim = structuredClone(fixture.renewedInput)
  wrongOwnerClaim.authorization.authority.currentOwner = {
    personId: fixture.owner.identity.personId, publicKey: fixture.owner.identity.publicKey,
    certificates: [fixture.owner.certificate],
  }
  await expect(attempt(wrongOwnerClaim)).rejects.toThrow(/owner/i)
  expect(signingContext).not.toHaveBeenCalled()

  const otherWorkspaceTransfer = await createWorkspaceOwnershipTransfer(fixture.owner, "different-workspace",
    { personId: fixture.successor.identity.personId, publicKey: fixture.successor.identity.publicKey,
      certificates: [fixture.successor.certificate] }, Automerge.getHeads(fixture.current), 2)
  const wrongWorkspace = structuredClone(fixture.renewedInput)
  wrongWorkspace.authorization.authority.ownershipTransfers = [otherWorkspaceTransfer]
  await expect(attempt(wrongWorkspace)).rejects.toThrow()
  expect(signingContext).not.toHaveBeenCalled()

  const alteredDoc = JSON.parse(JSON.stringify(fixture.renewedInput.doc)) as WorkspaceDocumentV2
  const stored = alteredDoc.entities[automationEntityId(fixture.workerDescriptor.definitionId!)]
  if (stored?.kind !== "automation") throw new Error("Expected typed automation entity")
  const approval = JSON.parse(stored.approval) as { definition: { signature: string }; grant: { signature: string } }
  approval.definition.signature = `${approval.definition.signature[0] === "A" ? "B" : "A"}${approval.definition.signature.slice(1)}`
  stored.approval = JSON.stringify(approval)
  await expect(attempt({ ...fixture.renewedInput, doc: alteredDoc })).rejects.toThrow()
  expect(signingContext).not.toHaveBeenCalled()
  } finally { Automerge.free(fixture.current) }
})

it("Given a transferred workspace whose successor device is revoked, When that device asks to renew, Then deny before signing", async () => {
  const fixture = await ownershipFixture()
  try {
    const revoked = await createWorkspaceDeviceRevocation(fixture.successor, fixture.current.id,
      fixture.successor.identity.personId, fixture.successor.device.deviceId, Automerge.getHeads(fixture.current),
      [fixture.successor.certificate])
    const authorization = { ...fixture.authorization, authority: { ...fixture.authorization.authority,
      deviceRevocations: [{ record: revoked.record, signer: revoked.authority }] } }
    const signingContext = vi.fn(async (purpose: string, binding: Record<string, string | number>) =>
      resolveSigningContext({ profile: fixture.successor, certificates: [fixture.successor.certificate], purpose, binding,
        authorityRevision: "revoked-successor-device", current: async () => ({ personId: fixture.successor.identity.personId,
          deviceId: fixture.successor.device.deviceId, authorityRevision: "revoked-successor-device" }) }))

    await expect(prepareAutomationActivation({ ...fixture.renewedInput, authorization, signingContext })).rejects.toThrow(/revok|authorized|device/i)
    expect(signingContext).not.toHaveBeenCalled()
  } finally { Automerge.free(fixture.current) }
})

it("Given a workspace with an unsigned document branch, When the current successor requests renewal, Then do not launder that history into a new grant", async () => {
  const fixture = await ownershipFixture()
  const altered = Automerge.change(Automerge.clone(fixture.current), draft => { draft.title = "Unsigned alteration" })
  try {
    const signingContext = vi.fn(async (purpose: string, binding: Record<string, string | number>) =>
      resolveSigningContext({ profile: fixture.successor, certificates: [fixture.successor.certificate], purpose, binding,
        authorityRevision: "unsigned-branch", current: async () => ({ personId: fixture.successor.identity.personId,
          deviceId: fixture.successor.device.deviceId, authorityRevision: "unsigned-branch" }) }))

    await expect(prepareAutomationActivation({ ...fixture.renewedInput, doc: altered as unknown as WorkspaceDocumentV2,
      bytes: Automerge.save(altered), signingContext })).rejects.toThrow()
    expect(signingContext).not.toHaveBeenCalled()
    expect(fixture.current.title).not.toBe("Unsigned alteration")
  } finally {
    Automerge.free(altered)
    Automerge.free(fixture.current)
  }
})
