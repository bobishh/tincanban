import { beforeEach, expect, it, vi } from "vitest"
import type * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceDocumentV2 } from "./domain/model"
import type { WorkspaceStorage, WorkspaceTransactionContext } from "./storage"
import type { WorkspaceAdmissionResult } from "./product-replica/workspaceAdmission"
import { rememberIncomingPacket, reuseIncomingPacket } from "./stateIncomingReuse"

const mocks = vi.hoisted(() => ({ authority: vi.fn(), policy: vi.fn() }))
vi.mock("./sync/changeAuthorization", () => ({ localWorkspaceAdmissionAuthority: mocks.authority }))
vi.mock("./sync/workspaceAdmissionCheckpoint", () => ({ admissionPolicy: mocks.policy }))

beforeEach(() => {
  mocks.authority.mockReset().mockResolvedValue({ fingerprint: "authority", credentialFingerprint: "credential" })
  mocks.policy.mockReset().mockReturnValue("policy")
})

const packet = { bytes: new Uint8Array([1, 2, 3]), authorization: { version: 1, records: [] } }
const doc = { id: "basis-reuse-workspace", ownerPersonId: "owner" } as Automerge.Doc<WorkspaceDocumentV2>
const admission = { decisions: [], admittedHashes: [], verifiedAuthorizations: [] } as unknown as WorkspaceAdmissionResult
const storage = { readWorkspaceRevision: async () => "revision" } as unknown as WorkspaceStorage
function transaction(baselineId: string | null) {
  return { capturedRevision: "revision", capturedBaselineId: baselineId } as WorkspaceTransactionContext
}

it("Given a committed packet, when the durable history basis changes without a different packet, then do not reuse its old admission", async () => {
  await rememberIncomingPacket(packet, doc, storage, "credential", admission)
  expect(await reuseIncomingPacket(doc.id, packet, transaction("new-basis"))).toBe(false)
})

it("Given a committed packet, when current authority changes during reuse, then require fresh admission", async () => {
  await rememberIncomingPacket(packet, doc, storage, "credential", admission)
  mocks.authority.mockReset()
    .mockResolvedValueOnce({ fingerprint: "authority" })
    .mockResolvedValueOnce({ fingerprint: "revoked-authority" })
  expect(await reuseIncomingPacket(doc.id, packet, transaction(null))).toBe(false)
})

it("Given a committed packet on a verified basis, when only its identical durable basis repeats, then reuse without loading the Native baseline", async () => {
  await rememberIncomingPacket(packet, doc, storage, "credential", admission, undefined, "verified-basis")
  expect(await reuseIncomingPacket(doc.id, packet, transaction("verified-basis"))).toBe(true)
  expect(await reuseIncomingPacket(doc.id, packet, transaction("other-basis"))).toBe(false)
  expect(await reuseIncomingPacket(doc.id, packet, transaction(null))).toBe(false)
})
