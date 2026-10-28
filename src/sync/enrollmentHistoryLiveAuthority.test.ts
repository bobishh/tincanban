import { afterEach, expect, it, vi } from "vitest"
import { IDBFactory } from "fake-indexeddb"
import { BrowserIdentityStore, createDeviceRevocation, createIdentityAuthorityView, createIdentityEnrollmentDevice,
  emptyIdentityProfileState, verifyIdentityDeviceAuthority } from "@meta-uber/mesh-identity"
import { createWorkspaceDeparture, createWorkspaceDeviceRevocation, createWorkspaceRevocation } from "@meta-uber/mesh-workspace"
import { bootstrapIdentity, resetIdentityStorageForTest, signEnvelope, type LocalProfile } from "../domain/identity"
import { createWorkspaceGrant } from "../domain/proofs"
import { mergeIdentityAuthorityView } from "./identityAuthorityStore"
import { createEnrollmentHistoryAuthorizationGuard } from "./enrollmentHistoryAuthorization"
import { PeerStore, type WorkspaceAuthorityRecord, type WorkspaceMeshCredential } from "./peerStore"
import { createPeerHistoryHandlers } from "./workspaceSetHistory"

afterEach(() => { vi.restoreAllMocks(); resetIdentityStorageForTest() })

async function fixture(member = false) {
  resetIdentityStorageForTest()
  const local = await bootstrapIdentity("Enrollment source")
  const app = await createIdentityEnrollmentDevice("Enrolled phone")
  const certificate = await signEnvelope(local.privateKeys.identityPrivateKey!, { kind: "device-certificate" as const,
    version: 1 as const, personId: local.identity.personId, deviceId: app.device.deviceId,
    devicePublicKey: app.device.publicKey, issuerCertificateHash: null, canEnrollDevices: true }, local.identity.personId)
  const remote: LocalProfile = { identity: local.identity, device: app.device, certificate,
    privateKeys: { devicePrivateKey: app.privateKey } }
  const certificates = [local.certificate, certificate], state = emptyIdentityProfileState(local.identity.personId)
  const global = await verifyIdentityDeviceAuthority(local.identity, { certificates, revocations: [] })
  await mergeIdentityAuthorityView(await createIdentityAuthorityView(local.identity, { certificates, revocations: [] }, state))
  const values = new Map<string, string>()
  const owner = member ? await new BrowserIdentityStore({ storageKey: "shared-enrollment-owner", storage: {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  } }).bootstrap("Shared board owner") : local
  const workspaceId = crypto.randomUUID()
  const localGrant = member ? await createWorkspaceGrant(owner, workspaceId, local.identity.personId, "editor", 1) : undefined
  let credential: WorkspaceMeshCredential = { version: 1, workspaceId, ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: "enrollment-secret",
    epoch: 1, updatedAt: new Date().toISOString(), ...(localGrant ? { localGrant } : {}) }
  let authority: WorkspaceAuthorityRecord | undefined
  let beforeCredentialRead = async () => {}
  let beforeProfileRead = async () => {}
  const input = { workspaceIds: [workspaceId], profile: local, remoteDeviceId: remote.device.deviceId,
    isCurrent: () => true, readProfile: async () => { await beforeProfileRead(); return local },
    readWorkspaces: async (ids: readonly string[]) => {
      await beforeCredentialRead()
      return ids.map(workspaceId => structuredClone({ workspaceId, credential, authority: authority ?? null }))
    } }
  const guard = createEnrollmentHistoryAuthorizationGuard(input)
  return { local, remote, owner, workspaceId, guard, historyInput: input, currentCredential: () => credential,
    duringCredentialRead: (operation: () => Promise<void>) => { beforeCredentialRead = operation },
    duringProfileRead: (operation: () => Promise<void>) => { beforeProfileRead = operation },
    revokeGlobal: async (subject: "local" | "remote") => {
      const signer = subject === "local" ? remote : local, target = subject === "local" ? local : remote
      const revocation = await createDeviceRevocation(signer, global, target.device.deviceId, state)
      await mergeIdentityAuthorityView(await createIdentityAuthorityView(local.identity, { certificates, revocations: [revocation] }, state))
    },
    setCatalog: (storage: "credential" | "authority", catalog: unknown) => {
      if (storage === "authority") authority = { ...credential, catalog }
      else credential = { ...credential, catalog }
    } }
}

it.each(["before snapshot", "between snapshots"] as const)("Given two boards in the actual SDK store, when the first board is revoked %s before a history reply, then do not send its retained history", async timing => {
  const f = await fixture(), otherWorkspaceId = crypto.randomUUID()
  const store = new PeerStore(`enrollment-history-snapshot-${crypto.randomUUID()}`, new IDBFactory())
  const credential = f.currentCredential()
  await store.putWorkspaceCredential(credential)
  await store.putWorkspaceCredential({ ...credential, workspaceId: otherWorkspaceId })
  const revocation = await createWorkspaceDeviceRevocation(f.owner, f.workspaceId, f.remote.identity.personId,
    f.remote.device.deviceId, ["retained-history-head"], [f.owner.certificate])
  const revoke = () => store.putWorkspaceCredential({ ...credential, catalog: { deviceRevocations: [revocation] } })
  let preparingReply = false, replyProfileReads = 0
  f.duringProfileRead(async () => {
    if (preparingReply && ++replyProfileReads === 2 && timing === "between snapshots") await revoke()
  })
  const guard = createEnrollmentHistoryAuthorizationGuard({ ...f.historyInput,
    workspaceIds: [f.workspaceId, otherWorkspaceId], readWorkspaces: ids => store.readWorkspaceAuthorization(ids) })
  const handlers = createPeerHistoryHandlers({ readHistoryBaseline: async () => {
    preparingReply = true
    if (timing === "before snapshot") await revoke()
    return { retained: "private-board-history" }
  } }, [f.workspaceId, otherWorkspaceId])
  const frame = new TextEncoder().encode(`tincanban-peer-history-v1\n${JSON.stringify({ version: 1,
    kind: "workspace-history-baseline-read", workspaceId: f.workspaceId })}`)
  const stream = { read: async () => frame, send: vi.fn(async () => {}), closeSend: vi.fn(async () => {}) }
  await expect(handlers.serveBaseline(frame, stream, f.remote.device.deviceId, guard)).rejects.toThrow(/revoked|authority.*changed/i)
  expect(stream.send).not.toHaveBeenCalled()
})

it.each(["local", "remote"] as const)("Given global %s revocation after approval, when enrollment requests more retained history, then reject while the workspace credential stays unchanged", async subject => {
  const f = await fixture()
  await expect(f.guard()).resolves.toBeUndefined()
  await f.revokeGlobal(subject)
  await expect(f.guard()).rejects.toThrow(/Identity.*(revoked|unavailable|changed)/i)
})

it("Given global authority changes while a credential read is pending, when its older access check resumes, then reject before releasing history", async () => {
  const f = await fixture()
  let revoked = false
  f.duringCredentialRead(async () => { if (!revoked) { revoked = true; await f.revokeGlobal("remote") } })
  await expect(f.guard()).rejects.toThrow(/Identity.*(revoked|unavailable|changed)/i)
})

it("Given workspace revocation arrives during the enclosing profile refresh, when the earlier credential read resumes, then reject before releasing history", async () => {
  const f = await fixture()
  const record = await createWorkspaceDeviceRevocation(f.owner, f.workspaceId, f.remote.identity.personId,
    f.remote.device.deviceId, ["retained-history-head"], [f.owner.certificate])
  let reads = 0
  f.duringProfileRead(async () => { if (++reads === 2) f.setCatalog("credential", { deviceRevocations: [record] }) })
  await expect(f.guard()).rejects.toThrow(/access.*revoked|authority.*changed/i)
})

for (const storage of ["credential", "authority"] as const) {
  it.each(["local", "remote"] as const)(`Given %s device revocation only in current ${storage}, when enrollment reads another history part, then reject that device`, async subject => {
    const f = await fixture(), target = subject === "local" ? f.local : f.remote
    await expect(f.guard()).resolves.toBeUndefined()
    const record = await createWorkspaceDeviceRevocation(f.owner, f.workspaceId, target.identity.personId,
      target.device.deviceId, ["retained-history-head"], [f.owner.certificate])
    f.setCatalog(storage, { deviceRevocations: [record] })
    await expect(f.guard()).rejects.toThrow(/access.*revoked|membership.*revoked/i)
  })

  it.each(["revoked", "departed"] as const)(`Given same-person member access is %s in current ${storage}, when enrollment reads another shared-board history part, then reject membership`, async change => {
    const f = await fixture(true)
    await expect(f.guard()).resolves.toBeUndefined()
    const catalog = change === "revoked" ? { revocations: [await createWorkspaceRevocation(f.owner, f.workspaceId,
      f.local.identity.personId, 2, ["retained-history-head"])] } : {
      departures: [await createWorkspaceDeparture(f.local, f.workspaceId, 1, ["retained-history-head"], [f.local.certificate])] }
    f.setCatalog(storage, catalog)
    await expect(f.guard()).rejects.toThrow(/access.*revoked|membership.*revoked/i)
  })
}
