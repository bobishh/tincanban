import { beforeAll, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { createRecoverableIdentity } from "@meta-uber/mesh-identity"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { createWorkspaceDeparture } from "./meshRecords"
import { toBase64Url } from "../domain/identity"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { prepareDepartureSnapshot, receiveDepartureFiles } from "./workspaceDepartureSnapshot"

beforeAll(async () => { await Automerge.initializeWasm(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")) })

it("Given a final snapshot with a locally available file, when confirming delivery, then wait for durable file persistence and reject unrelated blob requests", async () => {
  const { profile } = await createRecoverableIdentity("better", "Participant")
  const file = { type: "blob", sha256: "a".repeat(43), byteLength: 3, mimeType: "text/plain", fileName: "pending.txt" }
  const doc = Automerge.from({ id: "board", entities: { attachment: { id: "attachment", kind: "document", file } } } as unknown as WorkspaceDocumentV2)
  const departure = await createWorkspaceDeparture(profile, "board", 1, Automerge.getHeads(doc), [profile.certificate])
  const encoded = meshRustRuntime().state.encodeWorkspaceSet([{ id: "board", bytes: toBase64Url(Automerge.save(doc)),
    mesh: { version: 1, peers: [], revocations: [] } }])
  const snapshot = await prepareDepartureSnapshot(encoded, departure, { read: async () => new Uint8Array([1, 2, 3]) } as never)
  let release!: () => void
  const save = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
  let finished = false
  const pending = receiveDepartureFiles(snapshot, "board", profile.identity.personId, save).then(() => { finished = true })
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(finished).toBe(false)
  release()
  await pending
  const entries = meshRustRuntime().state.decodeWorkspaceSet(snapshot, ["board"])
  const metadata = (entries[0]!.mesh as { pendingDepartureDelivery: { blobs: Array<{ blobId: string }> } }).pendingDepartureDelivery
  metadata.blobs[0]!.blobId = `sha256:${"b".repeat(43)}`
  save.mockClear()
  await expect(receiveDepartureFiles(meshRustRuntime().state.encodeWorkspaceSet(entries), "board", profile.identity.personId, save))
    .rejects.toThrow("not referenced")
  expect(save).not.toHaveBeenCalled()
  Automerge.free(doc)
})
