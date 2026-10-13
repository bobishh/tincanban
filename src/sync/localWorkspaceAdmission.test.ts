import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity } from "../domain/identity"
import { createWorkspaceDoc } from "../domain/seeds"
import { executeCommand } from "../domain/commands"
import { evaluateIncomingWorkspaceAdmission, exportDocumentAuthorizationBundle,
  prepareLocalChangeAuthorizations, recordGenesisAuthority } from "./changeAuthorization"
import { persistDeltaCommand, reusableDeltaAdmission } from "../stateDeltaAdmission"
import { WorkspaceStorage } from "../storage"
import { putRecords } from "./workspaceChangeProofStore"
import { peerStore, type WorkspaceAuthorityRecord } from "./peerStore"

const stored = vi.hoisted(() => ({ authority: null as WorkspaceAuthorityRecord | null }))
vi.mock("./peerStore", () => ({ peerStore: {
  getWorkspaceAuthority: async () => stored.authority,
  getWorkspaceCredential: async () => null,
} }))
beforeEach(() => { stored.authority = null })
beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

async function fixture() {
  const profile = await bootstrapIdentity("Checkpoint test")
  const base = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Board", profile.identity.personId, "blank"))
  await recordGenesisAuthority(base, profile)
  const bundle = await exportDocumentAuthorizationBundle(base, profile)
  const admitted = await evaluateIncomingWorkspaceAdmission(base, base, bundle)
  const evidence = { bytes: admitted.rawBytes, decisions: admitted.decisions,
    authorizationEvidence: admitted.authorizationEvidence, admissionCheckpoint: admitted.admissionCheckpoint }
  const storage = new WorkspaceStorage()
  await storage.commitWorkspace(base.id, base, Automerge.save(base), admitted.verifiedAuthorizations, undefined, evidence)
  expect(await reusableDeltaAdmission(base, storage, profile)).toBeDefined()
  const result = await executeCommand(base, { kind: "renameWorkspace", title: "Local edit" }, profile)
  if (!result.ok) throw new Error(result.error.message)
  const { newDoc, receipt } = result.value
  const changeBytes = Automerge.getLastLocalChange(newDoc)!
  const authorizations = await prepareLocalChangeAuthorizations(newDoc, profile, [receipt.changeHash])
  const authority: WorkspaceAuthorityRecord = { version: 1, workspaceId: base.id, ownerPersonId: profile.identity.personId,
    ownerPublicKey: profile.identity.publicKey, ownerCertificates: [profile.certificate], epoch: 2,
    updatedAt: new Date().toISOString(), catalog: {} }
  const extend = () => persistDeltaCommand(base, result.value, changeBytes, authorizations, profile, storage, "owner")
  return { base, profile, authorizations, authority, extend, storage }
}

it.each(["rights", "proofs"])("Given changed %s after admission, When a local command saves, Then the checkpoint cannot extend", async changed => {
  const f = await fixture()
  if (changed === "rights") stored.authority = f.authority
  else await putRecords(f.base.id, f.authorizations)
  await expect(f.extend()).resolves.toBeUndefined()
})

it("Given an unavailable legacy catalog writer, When a local delta commits, Then success and catalog recovery use the atomic frontier", async () => {
  const f = await fixture()
  const register = vi.spyOn(f.storage, "registerWorkspace").mockRejectedValue(new Error("Legacy catalog unavailable"))
  try {
    expect((await f.extend())?.title).toBe("Local edit")
    expect(register).not.toHaveBeenCalled()
    expect((await new WorkspaceStorage().loadWorkspaceDoc(f.base.id))?.doc.title).toBe("Local edit")
    expect((await new WorkspaceStorage().listWorkspaces()).find(record => record.id === f.base.id)?.title).toBe("Local edit")
  } finally { register.mockRestore() }
})

it("Given an authority change during local validation, When extending the checkpoint, Then no admitted result is returned", async () => {
  const f = await fixture()
  const authority = vi.spyOn(peerStore, "getWorkspaceAuthority")
    .mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(f.authority)
  try {
    await expect(f.extend()).rejects.toThrow(/authority changed during validation/)
    expect((await f.storage.readDeltaFrontier(f.base.id))?.revision).toBe(0)
    expect((await f.storage.loadWorkspaceDoc(f.base.id))?.doc.title).toBe(f.base.title)
  }
  finally { authority.mockRestore() }
})
