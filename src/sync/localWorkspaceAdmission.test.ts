import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity } from "../domain/identity"
import { createWorkspaceDoc } from "../domain/seeds"
import { executeCommand } from "../domain/commands"
import { evaluateIncomingWorkspaceAdmission, exportDocumentAuthorizationBundle,
  extendLocalWorkspaceAdmission, prepareLocalChangeAuthorizations, recordGenesisAuthority } from "./changeAuthorization"
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
  const result = await executeCommand(base, { kind: "renameWorkspace", title: "Local edit" }, profile)
  if (!result.ok) throw new Error(result.error.message)
  const { newDoc, receipt } = result.value
  const changeBytes = Automerge.getLastLocalChange(newDoc)!
  const authorizations = await prepareLocalChangeAuthorizations(newDoc, profile, [receipt.changeHash])
  const authority: WorkspaceAuthorityRecord = { version: 1, workspaceId: base.id, ownerPersonId: profile.identity.personId,
    ownerPublicKey: profile.identity.publicKey, ownerCertificates: [profile.certificate], epoch: 2,
    updatedAt: new Date().toISOString(), catalog: {} }
  const extend = () => extendLocalWorkspaceAdmission(base, newDoc, evidence, bundle, authorizations, receipt, changeBytes, "owner", profile)
  return { base, profile, authorizations, authority, extend }
}

it.each(["rights", "proofs"])("Given changed %s after admission, When a local command saves, Then the checkpoint cannot extend", async changed => {
  const f = await fixture()
  if (changed === "rights") stored.authority = f.authority
  else await putRecords(f.base.id, f.authorizations)
  await expect(f.extend()).resolves.toBeUndefined()
})

it("Given an authority change during local validation, When extending the checkpoint, Then no admitted result is returned", async () => {
  const f = await fixture()
  const authority = vi.spyOn(peerStore, "getWorkspaceAuthority")
    .mockResolvedValueOnce(null).mockResolvedValueOnce(f.authority)
  try { await expect(f.extend()).rejects.toThrow(/authority changed during validation/) }
  finally { authority.mockRestore() }
})
