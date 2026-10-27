import "fake-indexeddb/auto"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createDeviceEnrollmentInvite } from "@meta-uber/mesh-pairing"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { confirmIdentityAuthorityFixture } from "./identityAuthority.testSupport"
import { createSamePersonWorkspaceBootstrap } from "./enrollment"
import { readIdentityAuthorityView } from "./identityAuthorityStore"
import { receiveApprovedIdentityWorkspace } from "./deviceSyncSamePersonWorkspace"
import { localWorkspaceAdmissionAuthority } from "./changeAuthorization"
import { peerStore } from "./peerStore"
import * as workspaceSetModule from "./workspaceSet"
import * as acknowledgement from "./enrollmentAcknowledgement"
import type { DurableMesh } from "./durableMesh"
import type { SyncConnection } from "./transport"

beforeEach(() => { vi.restoreAllMocks(); resetIdentityStorageForTest() })
afterEach(() => vi.restoreAllMocks())

async function fixture() {
  const profile = await bootstrapIdentity()
  const root = createPersonalRoot(profile, await certHashDefault(profile.certificate))
  await defaultStorage.savePersonalRoot(root)
  await confirmIdentityAuthorityFixture(root, [profile.certificate])
  const authorityView = (await readIdentityAuthorityView(profile.identity.personId))!
  const workspaceId = crypto.randomUUID()
  const invite = createDeviceEnrollmentInvite("source", "secret", profile)
  const bytes = await createSamePersonWorkspaceBootstrap({ invite, profile,
    recipientDeviceId: profile.device.deviceId, recipientPublicKey: profile.device.publicKey,
    authorityView, workspace: { id: workspaceId, title: "Retained board", reference: {
      workspaceId, documentId: workspaceId, grantHash: "approved", forgotten: false } },
    meshWorkspaces: [{ workspaceId, ownerPersonId: profile.identity.personId,
      ownerPublicKey: profile.identity.publicKey }], grants: [], storage: [], identityStorage: [],
    snapshot: new TextEncoder().encode("[]") })
  const doc = { id: workspaceId, ownerPersonId: profile.identity.personId }
  const validate = vi.fn(async () => {})
  const publish = vi.fn(async () => {
    // Synchronous observer of the newly admitted board, as in switchWorkspace after discovery.
    await localWorkspaceAdmissionAuthority(doc, profile)
  })
  vi.spyOn(workspaceSetModule, "workspaceSet").mockReturnValue({ validate, receive: publish,
    resolveProofs: async (value: Uint8Array) => value, snapshot: async () => new Uint8Array(),
  } as unknown as ReturnType<typeof workspaceSetModule.workspaceSet>)
  vi.spyOn(acknowledgement, "awaitEnrollmentAcknowledgement").mockResolvedValue()
  const install = vi.fn(async () => {
    expect(validate).toHaveBeenCalledTimes(1)
    await peerStore.putWorkspaceCredential({ version: 1, workspaceId,
      ownerPersonId: profile.identity.personId, ownerPublicKey: profile.identity.publicKey,
      ownerCertificates: [profile.certificate], transportSecret: "t".repeat(43),
      epoch: 1, updatedAt: new Date().toISOString() })
  })
  const mesh = { validateInvitation: async () => new Map(), receiveInvitation: install,
    prepareOwnerWorkspaceTransfer: vi.fn(async () => "receiver") } as unknown as DurableMesh
  const stream = { send: async () => {}, closeSend: async () => {} }
  const connection = { openStream: async () => stream } as unknown as SyncConnection
  let current = true
  const receive = () => receiveApprovedIdentityWorkspace({ profile, mesh,
    store: {} as workspaceSetModule.WorkspaceSetStore, connection, invite, bytes,
    getProfile: async () => profile, isCurrent: () => current })
  return { receive, validate, publish, install, workspaceId, cancel: () => { current = false } }
}

it("Given a verified same-person board, when its history becomes visible, then write authority is already installed", async () => {
  const f = await fixture()
  await f.receive()
  expect(f.publish).toHaveBeenCalledTimes(1)
  expect(f.install).toHaveBeenCalledTimes(1)
})

it("Given interrupted authority installation, when the same bootstrap retries, then no board was exposed before verified access", async () => {
  const f = await fixture()
  f.install.mockRejectedValueOnce(new Error("Authority storage unavailable"))
  await expect(f.receive()).rejects.toThrow("Authority storage unavailable")
  expect(f.publish).not.toHaveBeenCalled()
  f.validate.mockClear()
  await f.receive()
  expect(f.publish).toHaveBeenCalledTimes(1)
  expect(f.install).toHaveBeenCalledTimes(2)
})

it("Given rejected history, when a same-person bootstrap runs, then no authority or document is installed", async () => {
  const f = await fixture()
  f.validate.mockRejectedValueOnce(new Error("History proof rejected"))
  await expect(f.receive()).rejects.toThrow("History proof rejected")
  expect(f.install).not.toHaveBeenCalled()
  expect(f.publish).not.toHaveBeenCalled()
  expect(await peerStore.getWorkspaceAuthority(f.workspaceId)).toBeNull()
})

it("Given the identity changes during access installation, when the old bootstrap resumes, then its board stays unpublished", async () => {
  const f = await fixture()
  f.install.mockImplementationOnce(async () => { f.cancel() })
  await expect(f.receive()).rejects.toThrow("Identity workspace transfer was cancelled")
  expect(f.publish).not.toHaveBeenCalled()
})
