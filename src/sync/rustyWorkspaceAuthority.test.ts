import "fake-indexeddb/auto"
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { defaultStorage } from "../storage"
import { createWorkspaceDoc } from "../test/boardFixture"
import { peerStore, type WorkspaceAuthorityRecord } from "./peerStore"
import type { BlindReplicaConfig } from "./blindReplication"
import { ensureOwnedRustyWorkspaceAuthority, rememberAdmittedRustyWorkspaceAuthority } from "./rustyWorkspaceAuthority"
import { bootstrapIdentity, signEnvelope } from "../domain/identity"
import * as rustyTransport from "./rustyIdentityTransport"

beforeAll(async () => { await Automerge.initializeWasm(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")) })
beforeEach(() => vi.stubGlobal("navigator", { ...navigator, locks: { request: async (_name: string, options: unknown, callback?: () => Promise<unknown>) =>
  typeof options === "function" ? (options as () => Promise<unknown>)() : callback?.() } }))
afterEach(() => vi.unstubAllGlobals())

it("Given a retained owner record without signed scope evidence, when restoring from Rusty, then fetch and verify authority instead of treating the incomplete record as ready", async () => {
  const profile = await bootstrapIdentity("Owner")
  const workspaceId = crypto.randomUUID()
  const genesis = await signEnvelope(profile.privateKeys.devicePrivateKey!, { kind: "scope-genesis", version: 1,
    scopeId: workspaceId, creator: { personId: profile.identity.personId, publicKey: profile.identity.publicKey,
      certificates: [profile.certificate] }, controlEpoch: 1 }, profile.device.deviceId)
  const snapshot = { genesis, grants: [], grantIssuers: [], revocations: [], controlTransfers: [] }
  await peerStore.putWorkspaceAuthority({ version: 1, workspaceId, ownerPersonId: profile.identity.personId,
    ownerPublicKey: profile.identity.publicKey, ownerCertificates: [profile.certificate], epoch: 1,
    updatedAt: new Date().toISOString(), catalog: { revocations: [] } })
  const fetch = vi.spyOn(rustyTransport, "readRustyOwnerWorkspaceScopeAuthority").mockResolvedValue({ snapshot } as never)
  try {
    const restored = await ensureOwnedRustyWorkspaceAuthority({ workspaceId } as BlindReplicaConfig, profile, () => {})
    expect(fetch).toHaveBeenCalledOnce()
    expect(restored?.scopeAuthoritySnapshot?.genesis).toEqual(genesis)
    expect((await peerStore.getWorkspaceAuthority(workspaceId))?.scopeAuthoritySnapshot?.genesis).toEqual(genesis)
    await ensureOwnedRustyWorkspaceAuthority({ workspaceId } as BlindReplicaConfig, profile, () => {})
    expect(fetch).toHaveBeenCalledOnce()
  } finally { fetch.mockRestore() }
})

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
