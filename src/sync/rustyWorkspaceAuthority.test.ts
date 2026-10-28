import { beforeAll, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { defaultStorage } from "../storage"
import { createWorkspaceDoc } from "../test/boardFixture"
import { peerStore, type WorkspaceAuthorityRecord } from "./peerStore"
import type { BlindReplicaConfig } from "./blindReplication"
import { rememberAdmittedRustyWorkspaceAuthority } from "./rustyWorkspaceAuthority"

beforeAll(async () => { await Automerge.initializeWasm(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")) })

it("Given verified Rusty rights already saved, when admitted history is reread, then recovery revision stays stable and changed rights still invalidate it", async () => {
  const workspaceId = crypto.randomUUID(), owner = { personId: "owner", publicKey: "key", certificates: [] }
  const evidence = { genesisOwner: owner, currentOwner: owner, currentEpoch: 1,
    ownershipTransfers: [], successionClaims: [], revocations: [], departures: [], deviceRevocations: [] }
  let authority = { workspaceId, ownerCertificates: [], scopeAuthoritySnapshot: {}, catalog: {
    ownershipTransfers: [], successionClaims: [], revocations: [], departures: [], deviceRevocations: [],
  } } as unknown as WorkspaceAuthorityRecord
  const read = vi.spyOn(peerStore, "getWorkspaceAuthority").mockImplementation(async () => structuredClone(authority))
  const write = vi.spyOn(peerStore, "putWorkspaceAuthority").mockImplementation(async next => { authority = next })
  const validate = vi.spyOn(meshRustRuntime().state, "validateScopeAuthority")
    .mockReturnValue({ creator: owner, controller: owner, controlEpoch: 1 })
  const prepare = vi.spyOn(meshRustRuntime().state, "prepareWriteEvidence").mockReturnValue(evidence)
  const doc = Automerge.from(createWorkspaceDoc(workspaceId, "Board", "owner", "job-search"))
  try {
    const before = await defaultStorage.readWorkspaceRevision(workspaceId)
    const remember = () => rememberAdmittedRustyWorkspaceAuthority({ workspaceId } as BlindReplicaConfig,
      Automerge.save(doc), { version: 1, records: [] }, () => {})
    await remember()
    expect(await defaultStorage.readWorkspaceRevision(workspaceId)).toBe(before)
    expect(write).not.toHaveBeenCalled()
    prepare.mockReturnValue({ ...evidence, currentOwner: { ...owner, certificates: [{ signature: "new certificate" }] } })
    await remember()
    expect(await defaultStorage.readWorkspaceRevision(workspaceId)).not.toBe(before)
    expect(write).toHaveBeenCalledOnce()
  } finally { read.mockRestore(); write.mockRestore(); validate.mockRestore(); prepare.mockRestore(); Automerge.free(doc) }
})
