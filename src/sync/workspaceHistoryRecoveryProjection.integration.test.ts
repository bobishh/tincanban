import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { afterEach, beforeAll, expect, it, vi } from "vitest"
import { bootstrapIdentity, canonicalizeJson, resetIdentityStorageForTest, toBase64Url } from "../domain/identity"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { defaultStorage } from "../storage"
import { createWorkspaceDoc } from "../test/boardFixture"
import { WORKSPACE_RECOVERY_STORES } from "../workspaceRecoveryStores"
import { openWorkspaceJournal, requestResult, transactionDone } from "../storageJournal"
import { prepareWorkspaceHistoryRecoveryProjection, resumeWorkspaceHistoryRecoveryProjection } from "./workspaceHistoryRecoveryProjection"
import { restoreWorkspaceRecoveryJournal } from "./workspaceHistoryRecoveryJournal"
import type { WorkspaceRecoveryJournal } from "./workspaceHistoryRecoveryDecode"

const ports = vi.hoisted(() => ({ transfer: vi.fn(), activate: vi.fn(), putCredential: vi.fn(), root: vi.fn() }))
vi.mock("./identityDeviceTransfer", () => ({ readIdentityDeviceTransfer: ports.transfer }))
vi.mock("./identityDeviceActivation", () => ({ activateIdentityDeviceTransfer: ports.activate }))
vi.mock("./peerStore", () => ({ peerStore: { getWorkspaceCredential: async () => null, putWorkspaceCredential: ports.putCredential } }))
vi.mock("../statePersonalRoot", () => ({ registerWorkspaceInCurrentRoot: ports.root }))

const documents = new Set<Automerge.Doc<WorkspaceDocumentV2>>()
beforeAll(async () => { await Automerge.initializeWasm(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")) })
afterEach(() => {
  defaultStorage.invalidateWorkspaceCache("board")
  for (const doc of documents) Automerge.free(doc)
  documents.clear()
  vi.unstubAllGlobals(); vi.restoreAllMocks(); resetIdentityStorageForTest()
})

async function replaceRecovery(database: IDBDatabase, personId: string) {
  await defaultStorage.withWorkspaceTransaction("board", async transaction => {
    const read = database.transaction([...WORKSPACE_RECOVERY_STORES], "readonly"), done = transactionDone(read)
    const rows = await Promise.all(WORKSPACE_RECOVERY_STORES.map(async name => {
      const values = await requestResult(read.objectStore(name).index("workspaceId").getAll("board")) as Array<{ id: string }>
      return [name, values.map(value => ({ id: value.id, value }))] as const
    }))
    await done
    const journal = Object.fromEntries(rows) as WorkspaceRecoveryJournal
    const revision = journal.revisions[0]?.value
    await restoreWorkspaceRecoveryJournal("board", journal, { personId, recoveryId: crypto.randomUUID(),
      replace: true, expectedRevision: revision ? canonicalizeJson(revision) : null, transaction, ensureCurrent: () => {} })
  })
  defaultStorage.invalidateWorkspaceCache("board")
}

it.each(["same recovery", "newer recovery", "newer recovery during validation", "newer recovery during Identity activation",
  "same recovery with nested Identity board edit"] as const)("Given interrupted recovery projection and a newer board edit, when restart observes %s, then finish only its exact projection while preserving newer content", async recovery => {
  vi.clearAllMocks()
  const transfer = { personalRoot: { workspaces: {
    board: { workspaceId: "board", documentId: "board", grantHash: "verified-grant", forgotten: false },
  } } }
  ports.transfer.mockReset().mockResolvedValue(transfer)
  ports.activate.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, operation: () => Promise<unknown>) => operation() } })
  const profile = await bootstrapIdentity("Recovered owner"), personId = profile.identity.personId
  const original = Automerge.from(createWorkspaceDoc("board", "Recovered board", personId, "blank"))
  documents.add(original)
  const recoveryId = crypto.randomUUID(), database = await openWorkspaceJournal()
  const transaction = database.transaction(["snapshots", "revisions"], "readwrite"), done = transactionDone(transaction)
  transaction.objectStore("snapshots").put({ id: "board", workspaceId: "board", title: "Recovered board",
    bytes: Automerge.save(original), heads: Automerge.getHeads(original), savedAt: "2026-10-28T20:00:00.000Z" })
  transaction.objectStore("revisions").put({ id: "board", workspaceId: "board", revision: "recovered-revision", recoveryId })
  await done
  const guard = () => {}
  await prepareWorkspaceHistoryRecoveryProjection({ personId, workspaceId: "board", recoveryId,
    manifest: { personId }, authority: null,
    credential: { version: 1, workspaceId: "board", ownerPersonId: personId, ownerPublicKey: profile.identity.publicKey,
      ownerCertificates: [profile.certificate], epoch: 1, transportSecret: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
      updatedAt: "2026-10-28T20:00:00.000Z" }, title: "Recovered board" }, guard)
  ports.root.mockRejectedValueOnce(new Error("Interrupted after credential write"))
  await expect(resumeWorkspaceHistoryRecoveryProjection(personId, guard)).rejects.toThrow("Interrupted after credential write")
  expect(ports.putCredential).toHaveBeenCalledOnce()
  const read = database.transaction("revisions", "readonly"), readDone = transactionDone(read)
  const revision = await requestResult(read.objectStore("revisions").get("board")) as { revision: string }
  await readDone
  expect(revision.revision).not.toBe("recovered-revision")

  const edited = Automerge.change(Automerge.clone(original), draft => { draft.title = "Newer local edit" })
  let expectedDocument = edited
  documents.add(edited)
  await defaultStorage.withWorkspaceTransaction("board", transaction => transaction.commitWorkspace(edited, Automerge.save(edited), []))

  if (recovery === "newer recovery") {
    await replaceRecovery(database, personId)
  } else if (recovery === "newer recovery during validation") {
    ports.transfer.mockImplementationOnce(async () => { await replaceRecovery(database, personId); return transfer })
  } else if (recovery === "newer recovery during Identity activation") {
    ports.activate.mockImplementationOnce(async () => { await replaceRecovery(database, personId) })
  } else if (recovery === "same recovery with nested Identity board edit") {
    ports.activate.mockImplementationOnce(async () => {
      const projected = Automerge.change(Automerge.clone(edited), draft => { draft.title = "Nested Identity board edit" })
      documents.add(projected)
      await defaultStorage.withWorkspaceTransaction("board", transaction => transaction.commitWorkspace(projected, Automerge.save(projected), []))
      expectedDocument = projected
    })
  }

  await resumeWorkspaceHistoryRecoveryProjection(personId, guard)
  const expectedCalls = recovery.startsWith("same recovery") ? 2 : 1
  expect(ports.root).toHaveBeenCalledTimes(expectedCalls)
  expect(ports.putCredential).toHaveBeenCalledTimes(expectedCalls)
  expect(ports.activate).toHaveBeenCalledTimes(recovery === "newer recovery during Identity activation" ? 2 : expectedCalls)
  await resumeWorkspaceHistoryRecoveryProjection(personId, guard)
  expect(ports.root).toHaveBeenCalledTimes(expectedCalls)
  const retained = await defaultStorage.loadWorkspaceDoc("board")
  expect(retained).not.toBeNull()
  documents.add(retained!.doc)
  expect(retained!.doc.title).toBe(expectedDocument.title)
  expect(retained!.heads).toEqual(Automerge.getHeads(expectedDocument).sort())
})
