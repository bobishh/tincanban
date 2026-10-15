import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, sha256Base64Url } from "../domain/identity"
import { createWorkspaceDoc } from "../domain/seeds"
import { executeCommand } from "../domain/commands"
import { authorizeLocalChanges, evaluateIncomingWorkspaceAdmission, exportDocumentAuthorizationBundle, recordGenesisAuthority } from "./changeAuthorization"
import type { WorkspaceDocumentV2 } from "../domain/model"

vi.mock("./peerStore", () => ({ peerStore: {
  getWorkspaceAuthority: async () => null, getWorkspaceCredential: async () => null,
} }))
beforeEach(() => { resetIdentityStorageForTest() })
beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

async function fixture() {
  const profile = await bootstrapIdentity("Applicant")
  let document = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Applications", profile.identity.personId, "blank"))
  await recordGenesisAuthority(document, profile)
  const column = Object.values(document.entities).find(entity => entity.kind === "column")!
  const created = await executeCommand(document, { kind: "createItem", id: "application", parentId: column.id, title: "Editable label" }, profile)
  if (!created.ok) throw new Error(created.error.message)
  document = created.value.newDoc
  await authorizeLocalChanges(document, profile, [created.value.receipt.changeHash])
  const text = "Original employer description"
  const captured = await executeCommand(document, { kind: "recordApplicationSource", data: {
    kind: "application-source-observation", version: 1, recordId: "original", workspaceId: document.id,
    cardId: "application", applicationId: `${document.id}:application`, observation: {
      phase: "original", origin: "website", status: "available", observedAt: "2026-10-14T10:00:00.000Z",
      company: "Employer", title: "Original vacancy title", text, extractorVersion: "fixture-v1",
      contentDigest: await sha256Base64Url(new TextEncoder().encode(text)), jobUrl: "https://example.com/jobs/123",
    },
  } }, profile)
  if (!captured.ok) throw new Error(captured.error.message)
  document = captured.value.newDoc
  await authorizeLocalChanges(document, profile, [captured.value.receipt.changeHash])
  return { document, profile, sourceHash: captured.value.receipt.changeHash }
}

it("Given a real signed source command, When browser policy admits its packet, Then the original independent record remains available", async () => {
  const f = await fixture(), bundle = await exportDocumentAuthorizationBundle(f.document, f.profile)
  const admission = await evaluateIncomingWorkspaceAdmission(undefined, f.document, bundle)
  expect(admission.quarantinedHashes).toEqual([])
  expect(admission.admittedHashes).toContain(f.sourceHash)
  const projected = Automerge.load<WorkspaceDocumentV2>(admission.authorizedDocument)
  try { expect(projected.entities["application-source:original"]).toEqual(f.document.entities["application-source:original"]) }
  finally { Automerge.free(projected) }
})

it("Given a source kind encoded as browser text, When an owner signs a disguised namespace, Then browser policy quarantines it without dropping the original", async () => {
  const f = await fixture()
  const invalid = Automerge.change(Automerge.clone(f.document), { message: JSON.stringify({
    kind: "workspace-change-metadata", version: 1, personId: f.profile.identity.personId,
    deviceId: f.profile.device.deviceId, transactionId: crypto.randomUUID(), action: "sourceAlias", entityIds: ["alias"],
  }) }, draft => {
    draft.entities.alias = { ...f.document.entities["application-source:original"]!, id: "alias" }
  })
  const hash = Automerge.getChangesMetaSince(invalid, Automerge.getHeads(f.document))[0]!.hash
  await authorizeLocalChanges(invalid, f.profile, [hash])
  const bundle = await exportDocumentAuthorizationBundle(invalid, f.profile)
  const admission = await evaluateIncomingWorkspaceAdmission(f.document, invalid, bundle)
  expect(admission.quarantinedHashes).toContain(hash)
  const projected = Automerge.load<WorkspaceDocumentV2>(admission.authorizedDocument)
  try {
    expect(projected.entities.alias).toBeUndefined()
    expect(projected.entities["application-source:original"]).toEqual(f.document.entities["application-source:original"])
  } finally { Automerge.free(projected) }
})

it.each(["edit", "delete"] as const)("Given an admitted source, When an owner signs a network %s beside an independent valid edit, Then quarantine only that branch", async action => {
  const f = await fixture()
  const metadata = { kind: "workspace-change-metadata", version: 1, personId: f.profile.identity.personId,
    deviceId: f.profile.device.deviceId, transactionId: crypto.randomUUID(), action: "maliciousSourceEdit",
    entityIds: ["application-source:original"] }
  const invalid = Automerge.change(Automerge.clone(f.document), { message: JSON.stringify(metadata) }, draft => {
    if (action === "delete") delete draft.entities["application-source:original"]
    else draft.entities["application-source:original"]!.title = "Substituted original"
  })
  const invalidHash = Automerge.getChangesMetaSince(invalid, Automerge.getHeads(f.document))[0]!.hash
  await authorizeLocalChanges(invalid, f.profile, [invalidHash])
  const valid = await executeCommand(f.document, { kind: "patchItem", entityId: "application", title: "Valid new label" }, f.profile)
  if (!valid.ok) throw new Error(valid.error.message)
  await authorizeLocalChanges(valid.value.newDoc, f.profile, [valid.value.receipt.changeHash])
  const rawUnion = Automerge.merge(invalid, valid.value.newDoc)
  const bundle = await exportDocumentAuthorizationBundle(rawUnion, f.profile)
  const admission = await evaluateIncomingWorkspaceAdmission(f.document, rawUnion, bundle)
  expect(admission.quarantinedHashes).toContain(invalidHash)
  expect(admission.admittedHashes).toContain(valid.value.receipt.changeHash)
  const projected = Automerge.load<WorkspaceDocumentV2>(admission.authorizedDocument)
  try {
    expect(projected.entities["application-source:original"]).toEqual(f.document.entities["application-source:original"])
    expect(projected.entities.application!.title).toBe("Valid new label")
    expect(Automerge.getChangesMetaSince(rawUnion, []).some(change => change.hash === invalidHash)).toBe(true)
  } finally { Automerge.free(projected) }
})
