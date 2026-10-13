import { readFile, writeFile } from "node:fs/promises"
import { expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "./crdt"
import { bootstrapIdentity } from "./domain/identity"
import { createWorkspaceDoc } from "./domain/seeds"
import { executeCommand } from "./domain/commands"
import * as authorization from "./sync/changeAuthorization"
import { putRecords, type WorkspaceChangeAuthorization } from "./sync/workspaceChangeProofStore"
import { WorkspaceStorage } from "./storage"
import { persistAuthorizedCommand } from "./statePersistence"

it.runIf(process.env.TINCANBAN_LOCAL_SAVE_BENCHMARK === "1")("Given growing admitted histories, When one card changes, Then compare full replay with checkpoint extension", async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
  const profile = await bootstrapIdentity("Synthetic benchmark")
  const storage = new WorkspaceStorage()
  const timings: unknown[] = []
  for (const count of [10, 100, 1000]) {
    let doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Synthetic board", profile.identity.personId, "blank"))
    await authorization.recordGenesisAuthority(doc, profile)
    const parent = Object.values(doc.entities).find(entity => entity.kind === "column")!
    const created = await executeCommand(doc, { kind: "createItem", id: "measured", parentId: parent.id,
      title: "Measured card", body: "Source description. ".repeat(150) }, profile)
    if (!created.ok) throw new Error(created.error.message)
    doc = created.value.newDoc
    const proofs: WorkspaceChangeAuthorization[] = []
    proofs.push(...await authorization.prepareLocalChangeAuthorizations(doc, profile, [created.value.receipt.changeHash]))
    for (let index = 1; index < count; index++) {
      doc = Automerge.change(doc, draft => { draft.entities.measured!.title = `Card edit ${index}` })
      const hash = Automerge.decodeChange(Automerge.getLastLocalChange(doc)!).hash
      proofs.push(...await authorization.prepareLocalChangeAuthorizations(doc, profile, [hash]))
    }
    await putRecords(doc.id, proofs)
    const admitted = await authorization.evaluateIncomingWorkspaceAdmission(doc, doc,
      await authorization.exportDocumentAuthorizationBundle(doc, profile))
    await storage.commitWorkspace(doc.id, doc, Automerge.save(doc), admitted.verifiedAuthorizations, undefined, {
      bytes: admitted.rawBytes, decisions: admitted.decisions, authorizationEvidence: admitted.authorizationEvidence,
      admissionCheckpoint: admitted.admissionCheckpoint,
    })
    const extension = vi.spyOn(authorization, "extendLocalWorkspaceAdmission").mockResolvedValueOnce(undefined)
    const fullStarted = performance.now()
    let saved: typeof doc
    try { saved = await persistAuthorizedCommand(doc, { kind: "setEntityArchived", entityId: "measured", archived: true }, profile, storage) }
    finally { extension.mockRestore() }
    const fullReplayMs = Math.round(performance.now() - fullStarted)
    const replay = vi.spyOn(authorization, "evaluateIncomingWorkspaceAdmission")
    const localStarted = performance.now()
    try {
      await persistAuthorizedCommand(saved, { kind: "restoreAndMove", entityId: "measured", parentId: parent.id, beforeId: null }, profile, storage)
      expect(replay).not.toHaveBeenCalled()
    } finally { replay.mockRestore() }
    timings.push({ historyChanges: count + 2, fullReplayMs, checkpointExtensionMs: Math.round(performance.now() - localStarted) })
  }
  await writeFile("/tmp/tincanban-local-save-benchmark.json", JSON.stringify(timings, null, 2))
}, 120_000)
