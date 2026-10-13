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
import * as deltaAdmission from "./stateDeltaAdmission"

vi.mock("@automerge/automerge/slim", async () => {
  const actual = await vi.importActual<typeof Automerge>("@automerge/automerge/slim")
  return { ...actual, save: vi.fn(actual.save) }
})

it.runIf(process.env.TINCANBAN_LOCAL_SAVE_BENCHMARK === "1")("Given growing admitted histories, When Archive and Applied alternate repeatedly, Then only new deltas serialize and warm saves stay below 250ms", async () => {
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
    const extension = vi.spyOn(deltaAdmission, "persistDeltaCommand").mockResolvedValueOnce(undefined)
    const fullStarted = performance.now()
    let saved: typeof doc
    try { saved = await persistAuthorizedCommand(doc, { kind: "setEntityArchived", entityId: "measured", archived: true }, profile, storage) }
    finally { extension.mockRestore() }
    const fullReplayMs = Math.round(performance.now() - fullStarted)
    expect(await deltaAdmission.reusableDeltaAdmission(saved, storage, profile)).toBeDefined()
    const replay = vi.spyOn(authorization, "evaluateIncomingWorkspaceAdmission")
    const save = vi.mocked(Automerge.save)
    save.mockClear()
    const snapshots = vi.spyOn(storage, "commitWorkspace")
    const localMs: number[] = []
    try {
      for (let index = 0; index < 6; index++) {
        const localStarted = performance.now()
        saved = await persistAuthorizedCommand(saved, index % 2
          ? { kind: "setEntityArchived", entityId: "measured", archived: true }
          : { kind: "restoreAndMove", entityId: "measured", parentId: parent.id, beforeId: null }, profile, storage)
        localMs.push(performance.now() - localStarted)
      }
      expect(replay).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      expect(snapshots).not.toHaveBeenCalled()
      expect(Math.max(...localMs)).toBeLessThan(250)
    } finally { replay.mockRestore(); snapshots.mockRestore() }
    timings.push({ historyChanges: count + 2, fullReplayMs, deltaSaveMs: localMs.map(value => Math.round(value)),
      averageDeltaMs: Math.round(localMs.reduce((sum, value) => sum + value, 0) / localMs.length) })
  }
  await writeFile("/tmp/tincanban-local-save-benchmark.json", JSON.stringify(timings, null, 2))
}, 120_000)
