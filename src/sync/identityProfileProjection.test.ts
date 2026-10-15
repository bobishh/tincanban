import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { bootstrapIdentity, canonicalizeJson, resetIdentityStorageForTest, toBase64Url } from "../domain/identity"
import { createPersonalRoot, registerWorkspaceInRoot } from "../domain/personalRoot"
import { certHashDefault } from "../domain/proofs"
import { defaultStorage } from "../storage"
import * as local from "../localDb"
import { createChatRecordFixture as createChatRecord } from "../chat/records.testSupport"
import { configureChat } from "../chat/service"
import { ChatStore, chatStore } from "../chat/store"
import { peerStore } from "./peerStore"
import { applyIdentityDeviceTransfer, createIdentityDeviceTransfer, readIdentityDeviceTransfer } from "./identityDeviceTransfer"
import { resumeIdentityDeviceActivation } from "./identityDeviceActivation"
import { identityDeviceStateSchemas } from "./identityDeviceStateCodec"
import { projectPrivateProfileObservation } from "../chat/privateProfileProjection"
import { resumeIdentityProfileProjections } from "./identityProfileProjection"
import { createWorkspaceDeviceRevocation } from "./meshRecords"
import { WorkspaceUnavailableError } from "../workspaceAvailability"
import { readIdentityStateRevision } from "../identityStateRevision"

beforeEach(() => {
  resetIdentityStorageForTest()
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, options: unknown, action?: () => Promise<unknown>) =>
    (action ?? options as () => Promise<unknown>)() } })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it("Given persistent storage without cross-tab locks, when projecting a profile, then retain the original queue and reject unsafe shared writes", async () => {
  const f = await fixture()
  f.install()
  vi.stubGlobal("navigator", {})
  await expect(projectPrivateProfileObservation(f.workspaceId, f.record, () => {}))
    .rejects.toThrow("Workspace writes require cross-tab locking support")
  expect((await f.store.load(f.scope)).profiles).toEqual([])
})

async function fixture() {
  const owner = await bootstrapIdentity("Owner")
  const workspaceId = crypto.randomUUID(), scope = `${owner.identity.personId}:board-${crypto.randomUUID()}`
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  const manifest = await createIdentityDeviceTransfer(root, [owner.certificate])
  await defaultStorage.savePersonalRoot(root)
  registerWorkspaceInRoot(root, workspaceId, workspaceId, "genesis")
  manifest.components.workspaceReferences.value.workspaces = Object.values(root.workspaces)
  const record = await createChatRecord(owner, [owner.certificate], { publicKey: owner.identity.publicKey,
    certificates: [owner.certificate] }, scope, "chat-profile", "Imported name", 2)
  const observations = manifest.components.profileObservations.value.observations as unknown[]
  observations.push({ kind: "workspace-profile", workspaceId, record })
  let installed = false
  configureChat(async id => {
    if (!installed || id !== workspaceId) throw new WorkspaceUnavailableError()
    return owner.identity.personId
  }, async id => {
    if (!installed || id !== workspaceId) throw new WorkspaceUnavailableError()
    return scope
  })
  const store = new ChatStore(`private-projection-${crypto.randomUUID()}`)
  vi.spyOn(chatStore, "merge").mockImplementation((id, messages, profiles) => store.merge(id, messages, profiles))
  vi.spyOn(chatStore, "loadProfiles").mockImplementation(id => store.loadProfiles(id))
  vi.spyOn(peerStore, "getWorkspaceCredential").mockResolvedValue(null)
  vi.spyOn(peerStore, "getWorkspaceAuthority").mockResolvedValue(null)
  vi.spyOn(peerStore, "listPeers").mockResolvedValue([])
  const queueKey = `tincanban.identity-profile-projections.v1.${owner.identity.personId}`
  return { owner, root, manifest, record, workspaceId, scope, store, queueKey, install: () => { installed = true } }
}

it("Given staged own profiles, when exporting, then advertise the staged contract and still read legacy signed observations", async () => {
  expect(identityDeviceStateSchemas.profileObservations).toBe("profile-observations@3")
  const f = await fixture()
  f.manifest.components.profileObservations.schema = "profile-observations@1"
  const observations = f.manifest.components.profileObservations.value.observations as Array<{ profileState?: unknown }>
  delete observations[0].profileState
  await expect(readIdentityDeviceTransfer(f.manifest, f.owner.identity.personId)).resolves.toMatchObject({
    observations: [{ workspaceId: f.workspaceId, record: f.record }],
  })
})

it("Given an own profile for an unknown workspace, when two identity bundles activate, then retain the signed observation without blocking either or installing workspace rights", async () => {
  const f = await fixture()
  const transfer = await readIdentityDeviceTransfer(f.manifest, f.owner.identity.personId)
  await applyIdentityDeviceTransfer(transfer, () => {})
  const queued = JSON.parse((await local.readLocal(f.queueKey))!)
  expect(queued.observations).toEqual([{ workspaceId: f.workspaceId, record: f.record }])
  expect(await local.readLocal(`tincanban.identity-device-activation.v1.${f.owner.identity.personId}`)).toBeNull()
  expect((await f.store.load(f.scope)).profiles).toEqual([])
  expect(await peerStore.getWorkspaceAuthority(f.workspaceId)).toBeNull()
  const next = structuredClone(f.manifest)
  next.components.futureSettings = { schema: "future-settings@1", required: false, value: { marker: "second identity update" } }
  await applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(next, f.owner.identity.personId), () => {})
  expect(JSON.parse((await local.readLocal(f.queueKey))!).observations).toEqual(queued.observations)
  expect((await defaultStorage.loadPersonalRoot(f.root.rootId))?.workspaces[f.workspaceId]).toBeDefined()
})

it("Given retained own profile and later installed workspace, when recovery retries, then project the original record durably and clear only confirmed queue entries", async () => {
  const f = await fixture()
  await applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(f.manifest, f.owner.identity.personId), () => {})
  f.install()
  await resumeIdentityDeviceActivation(f.owner.identity.personId, () => {})
  expect((await f.store.load(f.scope)).profiles).toMatchObject([{ name: "Imported name", record: f.record }])
  expect(JSON.parse((await local.readLocal(f.queueKey))!).observations).toEqual([])
  const exported = await createIdentityDeviceTransfer(f.root, [f.owner.certificate])
  expect(exported.components.profileObservations.value.observations).toEqual(expect.arrayContaining([
    { kind: "workspace-profile", workspaceId: f.workspaceId, record: f.record },
  ]))
})

it("Given a signed workspace profile is already projected, When its identity transfer is replayed, Then preserve the final portable content and revision without another sync notification", async () => {
  const f = await fixture()
  f.install()
  const transfer = await readIdentityDeviceTransfer(f.manifest, f.owner.identity.personId)
  await applyIdentityDeviceTransfer(transfer, () => {})
  const capture = async () => canonicalizeJson(await createIdentityDeviceTransfer((await defaultStorage.loadPersonalRoot())!, [f.owner.certificate]))
  const before = await capture(), revision = await readIdentityStateRevision()
  const changed = await applyIdentityDeviceTransfer(transfer, () => {})
  expect(await capture()).toBe(before)
  expect(await readIdentityStateRevision()).toBe(revision)
  expect(changed).toBe(false)
})

it("Given a declared workspace profile source has a storage failure, when capturing identity state, then report the failure rather than silently omit its observations", async () => {
  const f = await fixture()
  configureChat(async () => f.owner.identity.personId, async () => { throw new Error("Workspace history read failed") })
  await expect(createIdentityDeviceTransfer(f.root, [f.owner.certificate])).rejects.toThrow("Workspace history read failed")
})

it("Given a valid own signature with a fabricated workspace owner wrapper, when workspace becomes available, then retain privately and reject shared projection", async () => {
  const f = await fixture()
  const forged = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  f.record.authority.publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", forged.publicKey)))
  f.install()
  await applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(f.manifest, f.owner.identity.personId), () => {})
  expect(JSON.parse((await local.readLocal(f.queueKey))!).observations).toEqual([{ workspaceId: f.workspaceId, record: f.record }])
  expect((await f.store.load(f.scope)).profiles).toEqual([])
})

it("Given shared profile storage fails, when activation projects, then retain accepted identity state and retry the original signed observation", async () => {
  const f = await fixture()
  f.install()
  vi.spyOn(f.store, "merge").mockRejectedValueOnce(new Error("chat storage unavailable"))
  await applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(f.manifest, f.owner.identity.personId), () => {})
  expect(JSON.parse((await local.readLocal(f.queueKey))!).observations).toHaveLength(1)
  expect((await defaultStorage.loadPersonalRoot(f.root.rootId))?.workspaces[f.workspaceId]).toBeDefined()
  await resumeIdentityDeviceActivation(f.owner.identity.personId, () => {})
  expect((await f.store.load(f.scope)).profiles[0]?.record).toEqual(f.record)
  expect(JSON.parse((await local.readLocal(f.queueKey))!).observations).toEqual([])
})

it("Given a signed profile for a different chat room, when its document installs, then retain privately with a concrete admission reason", async () => {
  const f = await fixture()
  await applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(f.manifest, f.owner.identity.personId), () => {})
  configureChat(async () => f.owner.identity.personId, async () => "another-board-room")
  const result = await resumeIdentityProfileProjections(f.owner.identity.personId, () => {})
  expect(result).toMatchObject({ projected: 0, pending: [{ workspaceId: f.workspaceId, reason: "Invalid chat record" }] })
  expect(JSON.parse((await local.readLocal(f.queueKey))!).observations).toHaveLength(1)
  expect((await f.store.load("another-board-room")).profiles).toEqual([])
})

it("Given the owner device was revoked for the workspace, when its own private profile arrives, then preserve it privately and deny shared projection", async () => {
  const f = await fixture()
  f.install()
  const removal = await createWorkspaceDeviceRevocation(f.owner, f.workspaceId, f.owner.identity.personId,
    f.owner.device.deviceId, ["a".repeat(64)], [f.owner.certificate])
  vi.mocked(peerStore.getWorkspaceAuthority).mockResolvedValue({ version: 1, workspaceId: f.workspaceId,
    ownerPersonId: f.owner.identity.personId, ownerPublicKey: f.owner.identity.publicKey,
    ownerCertificates: [f.owner.certificate], epoch: 1, updatedAt: new Date().toISOString(),
    catalog: { deviceRevocations: [removal] } })
  await applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(f.manifest, f.owner.identity.personId), () => {})
  const result = await resumeIdentityProfileProjections(f.owner.identity.personId, () => {})
  expect(result.pending[0]?.reason).toBe("Workspace profile access is revoked")
  expect((await f.store.load(f.scope)).profiles).toEqual([])
  expect(JSON.parse((await local.readLocal(f.queueKey))!).observations).toHaveLength(1)
})

it("Given a profile was materialized before device revocation, When its old identity transfer is replayed, Then current access is rechecked and its original remains queued", async () => {
  const f = await fixture()
  f.install()
  const transfer = await readIdentityDeviceTransfer(f.manifest, f.owner.identity.personId)
  await applyIdentityDeviceTransfer(transfer, () => {})
  expect(JSON.parse((await local.readLocal(f.queueKey))!).observations).toEqual([])
  const removal = await createWorkspaceDeviceRevocation(f.owner, f.workspaceId, f.owner.identity.personId,
    f.owner.device.deviceId, ["a".repeat(64)], [f.owner.certificate])
  vi.mocked(peerStore.getWorkspaceAuthority).mockResolvedValue({ version: 1, workspaceId: f.workspaceId,
    ownerPersonId: f.owner.identity.personId, ownerPublicKey: f.owner.identity.publicKey,
    ownerCertificates: [f.owner.certificate], epoch: 1, updatedAt: new Date().toISOString(),
    catalog: { deviceRevocations: [removal] } })
  await applyIdentityDeviceTransfer(transfer, () => {})
  expect(JSON.parse((await local.readLocal(f.queueKey))!).observations).toEqual([{ workspaceId: f.workspaceId, record: f.record }])
  expect((await resumeIdentityProfileProjections(f.owner.identity.personId, () => {})).pending[0]?.reason)
    .toBe("Workspace profile access is revoked")
})

it("Given shared storage resolves without retaining a profile, when projection confirms, then do not acknowledge or drop the original private record", async () => {
  const f = await fixture()
  f.install()
  vi.mocked(chatStore.merge).mockResolvedValue({ changed: false, added: [], profilesChanged: false } as never)
  await applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(f.manifest, f.owner.identity.personId), () => {})
  const result = await resumeIdentityProfileProjections(f.owner.identity.personId, () => {})
  expect(result.pending[0]?.reason).toBe("Shared profile was not retained")
  expect(JSON.parse((await local.readLocal(f.queueKey))!).observations).toHaveLength(1)
})

it("Given identity activation aborts, when importing profiles and credentials together, then publish no queued profile or catalog change", async () => {
  const f = await fixture()
  const transfer = await readIdentityDeviceTransfer(f.manifest, f.owner.identity.personId)
  const before = await local.readLocal("tincanban.v1.personal_roots")
  const abort = vi.spyOn(local, "compareAndSwapLocal").mockRejectedValueOnce(new Error("transaction aborted"))
  try { await expect(applyIdentityDeviceTransfer(transfer, () => {})).rejects.toThrow("transaction aborted") }
  finally { abort.mockRestore() }
  expect(await local.readLocal(f.queueKey)).toBeNull()
  expect(await local.readLocal("tincanban.v1.personal_roots")).toBe(before)
  expect((await f.store.load(f.scope)).profiles).toEqual([])
})

it("Given newer local projection state, when importing, then preserve its bytes and all old identity state while reporting upgrade", async () => {
  const f = await fixture()
  const raw = JSON.stringify({ version: 2, personId: f.owner.identity.personId, future: "retained" })
  await local.writeLocal(f.queueKey, raw)
  const before = await local.readLocal("tincanban.v1.personal_roots")
  const transfer = await readIdentityDeviceTransfer(f.manifest, f.owner.identity.personId)
  await expect(applyIdentityDeviceTransfer(transfer, () => {})).rejects.toMatchObject({ code: "identity-device-state-upgrade-required" })
  expect(await local.readLocal(f.queueKey)).toBe(raw)
  expect(await local.readLocal("tincanban.v1.personal_roots")).toBe(before)
})

it("Given forged authorship or an undeclared workspace reference, when preflighting, then reject the entire bundle before retaining private observations", async () => {
  const f = await fixture()
  const forged = structuredClone(f.manifest)
  const profiles = forged.components.profileObservations.value.observations as Array<{ record?: typeof f.record }>
  profiles[1].record!.signed.payload.text = "Tampered"
  await expect(readIdentityDeviceTransfer(forged, f.owner.identity.personId)).rejects.toThrow(/signature/i)
  f.manifest.components.workspaceReferences.value.workspaces = []
  await expect(readIdentityDeviceTransfer(f.manifest, f.owner.identity.personId)).rejects.toThrow(/workspace.*reference/i)
  expect(await local.readLocal(f.queueKey)).toBeNull()
})
