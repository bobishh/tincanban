import "fake-indexeddb/auto"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { readFile } from "node:fs/promises"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { defaultStorage } from "../storage"
import { PeerStore, type WorkspaceMeshCredential } from "./peerStore"
import { createPeerAdvertisement } from "./meshRecords"
import { persistVerifiedPeerBundle } from "./durableMeshPeerAdmission"

beforeAll(async () => {
  await Automerge.initializeWasm(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm"))
  vi.stubGlobal("navigator", { userAgent: "Peer admission fixture", locks: { request: async (_name: string, options: unknown, run?: () => Promise<unknown>) =>
    (run ?? options as () => Promise<unknown>)() } })
})
afterAll(() => vi.unstubAllGlobals())

it("Given an active signed peer, when the same catalog is replayed through SDK peer normalization, then preserve the authority revision while continuing signature checks", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Peer owner")
  const workspaceId = crypto.randomUUID()
  const store = new PeerStore(`peer-admission-${workspaceId}`)
  const credential: WorkspaceMeshCredential = { version: 1, workspaceId, ownerPersonId: profile.identity.personId,
    ownerPublicKey: profile.identity.publicKey, ownerCertificates: [profile.certificate], transportSecret: "test-secret",
    epoch: 1, updatedAt: new Date().toISOString() }
  await store.putWorkspaceCredential(credential)
  const raw = await createPeerAdvertisement(profile, { workspaceId, endpoint: "peer-endpoint", instanceId: "peer-tab",
    routeSequence: 1, certificates: [profile.certificate], ownerPublicKey: profile.identity.publicKey,
    ownerCertificates: [profile.certificate] })
  const admit = (bundle = raw) => defaultStorage.withWorkspaceAuthorityMutation(workspaceId, authorityContext =>
    persistVerifiedPeerBundle({ credential, raw: bundle, context: { store, authorityContext, getProfile: async () => profile,
      trace: async (_phase, _detail, operation) => operation() } }))
  await admit()
  const revision = await defaultStorage.readWorkspaceRevision(workspaceId)
  const revisions: Array<string | undefined> = []
  for (let attempt = 0; attempt < 4; attempt++) {
    await admit()
    revisions.push(await defaultStorage.readWorkspaceRevision(workspaceId))
  }
  expect(revisions).toEqual(Array(4).fill(revision))
  const forged = structuredClone(raw)
  forged.advertisement.signature = "A".repeat(86)
  await expect(admit(forged)).rejects.toThrow()
  expect(await defaultStorage.readWorkspaceRevision(workspaceId)).toBe(revision)
  store.close()
})
