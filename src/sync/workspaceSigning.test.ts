import { readFile } from "node:fs/promises"
import { IDBFactory } from "fake-indexeddb"
import * as Automerge from "@automerge/automerge/slim"
import { BrowserIdentityStore } from "@meta-uber/mesh-identity"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { initializeAutomerge } from "../crdt"
import { adoptEnrolledIdentity, bootstrapIdentity, resetIdentityStorageForTest, toBase64Url, verifyEnvelope, type LocalProfile } from "../domain/identity"
import { certHashDefault, createDelegatedCertificate, defaultProofStore } from "../domain/proofs"
import { resolveSigningContext } from "../domain/signingContext"
import { createWorkspaceDoc } from "../domain/seeds"
import { authorizeLocalChanges, recordGenesisAuthority, prepareLocalChangeAuthorizations, type WorkspaceSigningContextFactory } from "./changeAuthorization"
import { createWorkspaceDeviceRevocation } from "./meshRecords"
import { peerStore } from "./peerStore"
import { readLocal, writeLocal } from "../localDb"
import { records } from "./workspaceChangeProofStore"
import { workspaceSigningContext } from "./workspaceSigning"
import { readWorkspaceSigningAuthority, authorityValidationFingerprint, workspaceRole } from "./changeAuthorization"

vi.mock("@automerge/automerge/slim", async () => {
  const actual = await vi.importActual<typeof Automerge>("@automerge/automerge/slim")
  return { ...actual, view: vi.fn(actual.view) }
})

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, options: unknown, run?: () => Promise<unknown>) =>
    (run ?? options as () => Promise<unknown>)() } })
})
afterEach(() => { vi.restoreAllMocks(); resetIdentityStorageForTest() })
afterAll(() => vi.unstubAllGlobals())

async function fixture() {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Workspace signer")
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Original", profile.identity.personId, "job-search"))
  return { profile, doc }
}

async function replaceStoredDeviceKey() {
  const raw = await readLocal("tincanban.local_profile.v1")
  if (!raw) throw new Error("Expected stored identity profile")
  const stored = JSON.parse(raw) as { privateKeys: { devicePrivateKeyPkcs8: string } }
  const replacement = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
  stored.privateKeys.devicePrivateKeyPkcs8 = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", replacement.privateKey)))
  await writeLocal("tincanban.local_profile.v1", JSON.stringify(stored))
}

it("Given current workspace access, when creating a private history-read guard, then bind it to the current authority and reject unrelated purposes", async () => {
  const { profile, doc } = await fixture()
  try {
    await recordGenesisAuthority(doc, profile)
    const ports = { readAuthority: () => readWorkspaceSigningAuthority(doc.id), authorityFingerprint: authorityValidationFingerprint,
      workspaceRole: async () => "owner" as const }
    const result = await workspaceSigningContext(doc, profile, "history-recovery-read", "workspaceId", undefined, ports)
    await expect(result.requireCurrent()).resolves.toBeTypeOf("string")
    await expect(workspaceSigningContext(doc, profile, "unknown-history-operation", "workspaceId", undefined, ports)).rejects.toThrow(/permission/i)
  } finally { Automerge.free(doc) }
})

it("Given a live history-read guard, when validating again, then reuse its exact authority read for role derivation and still reject later revocation", async () => {
  const { profile, doc } = await fixture()
  try {
    await recordGenesisAuthority(doc, profile)
    const readAuthority = vi.fn(() => readWorkspaceSigningAuthority(doc.id)), deriveRole = vi.fn(workspaceRole)
    const fingerprint = vi.fn(authorityValidationFingerprint)
    const signing = await workspaceSigningContext(doc, profile, "history-recovery-read", "workspaceId", undefined,
      { readAuthority, authorityFingerprint: fingerprint, workspaceRole: deriveRole })
    readAuthority.mockClear(); deriveRole.mockClear()
    const reads = vi.spyOn(peerStore, "getWorkspaceAuthority")
    await signing.requireCurrent()
    expect(readAuthority).toHaveBeenCalledOnce()
    expect(deriveRole).toHaveBeenCalledWith(doc, profile, await readAuthority.mock.results[0]!.value)
    // One current input plus the existing post-policy race check; no duplicate initial role read.
    expect(reads).toHaveBeenCalledTimes(2)
    fingerprint.mockReturnValueOnce("changed-authority")
    await expect(signing.requireCurrent()).rejects.toThrow(/authority is stale/i)
    const authority = await peerStore.getWorkspaceAuthority(doc.id)
    if (!authority) throw new Error("Expected stored workspace authority")
    const revocation = await createWorkspaceDeviceRevocation(profile, doc.id, profile.identity.personId,
      profile.device.deviceId, Automerge.getHeads(doc), [profile.certificate])
    await peerStore.putWorkspaceAuthority({ ...authority, updatedAt: new Date().toISOString(),
      catalog: { ...authority.catalog as object, deviceRevocations: [revocation] } })
    await expect(signing.requireCurrent()).rejects.toThrow(/revok|stale|permission/i)
  } finally { Automerge.free(doc) }
})

it("Given unchanged public identity metadata and a replaced stored device key, when creating workspace genesis, then publish no owner authority", async () => {
  const { profile, doc } = await fixture()
  try {
    expect(await peerStore.getWorkspaceAuthority(doc.id)).toBeNull()
    await replaceStoredDeviceKey()

    await expect(recordGenesisAuthority(doc, profile)).rejects.toThrow(/stale|key|signer/i)
    expect(await peerStore.getWorkspaceAuthority(doc.id)).toBeNull()
  } finally { Automerge.free(doc) }
})

it("Given a stored key replacement while a workspace-change proof is signing, then return and persist no stale authorization", async () => {
  const { profile, doc } = await fixture()
  try {
    await recordGenesisAuthority(doc, profile)
    const before = await records(doc.id)
    const changed = Automerge.change(doc, draft => { draft.title = "Changed locally" })
    const hashes = Automerge.getChangesMetaSince(changed, []).map(change => change.hash)
    const nativeSign = crypto.subtle.sign.bind(crypto.subtle)
    let replaced = false
    vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      const input = new TextDecoder().decode(args[2] as Uint8Array)
      if (!replaced && input.includes('"workspace-changes"')) {
        replaced = true
        await replaceStoredDeviceKey()
      }
      return nativeSign(...args)
    })

    await expect(authorizeLocalChanges(changed, profile, hashes)).rejects.toThrow(/stale|key|signer/i)
    expect(replaced).toBe(true)
    expect(await records(doc.id)).toEqual(before)
    expect(changed.title).toBe("Changed locally")
  } finally { Automerge.free(doc) }
})

it("Given a valid signed workspace-device revocation, when preparing local authorization, then emit no workspace-change proof", async () => {
  const { profile, doc } = await fixture()
  try {
    await recordGenesisAuthority(doc, profile)
    const authority = await peerStore.getWorkspaceAuthority(doc.id)
    if (!authority) throw new Error("Expected stored workspace authority")
    const revocation = await createWorkspaceDeviceRevocation(profile, doc.id, profile.identity.personId,
      profile.device.deviceId, Automerge.getHeads(doc), [profile.certificate])
    await peerStore.putWorkspaceAuthority({ ...authority, updatedAt: new Date().toISOString(),
      catalog: { ...authority.catalog as object, deviceRevocations: [revocation] } })
    const emitted: string[] = []
    const nativeSign = crypto.subtle.sign.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      const input = new TextDecoder().decode(args[2] as Uint8Array)
      if (input.includes('"workspace-changes"')) emitted.push(input)
      return nativeSign(...args)
    })
    const hashes = Automerge.getChangesMetaSince(doc, []).map(change => change.hash)

    await expect(prepareLocalChangeAuthorizations(doc, profile, hashes)).rejects.toThrow(/revok|owner|authority|permission/i)
    expect(emitted).toEqual([])
  } finally { Automerge.free(doc) }
})

it("Given a signed device revocation arrives during proof crypto, then the proof is neither returned nor persisted", async () => {
  const { profile, doc } = await fixture()
  try {
    await recordGenesisAuthority(doc, profile)
    const before = await records(doc.id)
    const hashes = Automerge.getChangesMetaSince(doc, []).map(change => change.hash)
    const authority = await peerStore.getWorkspaceAuthority(doc.id)
    if (!authority) throw new Error("Expected stored workspace authority")
    const nativeSign = crypto.subtle.sign.bind(crypto.subtle)
    let revoked = false
    vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      const input = new TextDecoder().decode(args[2] as Uint8Array)
      if (!revoked && input.includes('"workspace-changes"')) {
        revoked = true
        const revocation = await createWorkspaceDeviceRevocation(profile, doc.id, profile.identity.personId,
          profile.device.deviceId, Automerge.getHeads(doc), [profile.certificate])
        await peerStore.putWorkspaceAuthority({ ...authority, updatedAt: new Date().toISOString(),
          catalog: { ...authority.catalog as object, deviceRevocations: [revocation] } })
      }
      return nativeSign(...args)
    })

    await expect(prepareLocalChangeAuthorizations(doc, profile, hashes)).rejects.toThrow(/revok|stale|permission/i)
    expect(revoked).toBe(true)
    expect(await records(doc.id)).toEqual(before)
  } finally { Automerge.free(doc) }
})

it("Given a non-revoked enrolled owner device with a verified issuer chain, then local authorization remains available", async () => {
  const { profile, doc } = await fixture()
  const storage = new Map<string, string>()
  const member = await new BrowserIdentityStore({ storageKey: crypto.randomUUID(), storage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value) },
    removeItem: key => { storage.delete(key) },
  } }).bootstrap("Second owner device") as LocalProfile
  try {
    await recordGenesisAuthority(doc, profile)
    const delegated = await createDelegatedCertificate(profile.privateKeys.devicePrivateKey, profile.device.deviceId,
      profile.identity.personId, member.device.deviceId, member.device.publicKey, await certHashDefault(profile.certificate))
    await defaultProofStore.putCertificate(await certHashDefault(profile.certificate), profile.certificate)
    const enrolled = { ...member, identity: profile.identity, certificate: delegated,
      privateKeys: { devicePrivateKey: member.privateKeys.devicePrivateKey } }
    const contextFactory: WorkspaceSigningContextFactory = async (purpose, binding, currentAuthority) => {
      const authorityRevision = await currentAuthority()
      return resolveSigningContext({ profile: enrolled, certificates: [delegated, profile.certificate], purpose,
        binding, authorityRevision, current: async () => ({ personId: profile.identity.personId,
          deviceId: member.device.deviceId, authorityRevision: await currentAuthority() }) })
    }
    const hashes = Automerge.getChangesMetaSince(doc, []).map(change => change.hash)

    const [authorization] = await prepareLocalChangeAuthorizations(doc, enrolled, hashes, contextFactory)
    expect(authorization?.signed.signerKeyId).toBe(member.device.deviceId)
    await expect(verifyEnvelope(authorization!.signed, member.device.publicKey, "MATCH/1")).resolves.toBe(true)
  } finally { Automerge.free(doc) }
})

it("Given a host supplies a verified context for another identity, when preparing local authorization, then reject author substitution", async () => {
  const { profile, doc } = await fixture()
  const storage = new Map<string, string>()
  const other = await new BrowserIdentityStore({ storageKey: crypto.randomUUID(), storage: {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) },
    removeItem: key => { storage.delete(key) },
  } }).bootstrap("Foreign signer") as LocalProfile
  try {
    await recordGenesisAuthority(doc, profile)
    const factory: WorkspaceSigningContextFactory = async (purpose, binding, currentAuthority) => resolveSigningContext({
      profile: other, certificates: [other.certificate], purpose, binding, authorityRevision: await currentAuthority(),
      current: async () => ({ personId: other.identity.personId, deviceId: other.device.deviceId,
        authorityRevision: await currentAuthority() }),
    })
    const hashes = Automerge.getChangesMetaSince(doc, []).map(change => change.hash)
    await expect(prepareLocalChangeAuthorizations(doc, profile, hashes, factory)).rejects.toThrow(/signer|context|identity/i)
  } finally { Automerge.free(doc) }
})

it("Given a host context does not recheck workspace rights, when revocation arrives during signing, then the producer still rejects it", async () => {
  const { profile, doc } = await fixture()
  try {
    await recordGenesisAuthority(doc, profile)
    const authority = await peerStore.getWorkspaceAuthority(doc.id)
    if (!authority) throw new Error("Expected stored workspace authority")
    const factory: WorkspaceSigningContextFactory = async (purpose, binding) => resolveSigningContext({ profile, purpose, binding,
      certificates: [profile.certificate], authorityRevision: "host",
      current: async () => ({ personId: profile.identity.personId, deviceId: profile.device.deviceId, authorityRevision: "host" }),
    })
    const sign = crypto.subtle.sign.bind(crypto.subtle)
    let revoked = false
    vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      const result = await sign(...args)
      if (!revoked && new TextDecoder().decode(args[2] as Uint8Array).includes('"workspace-changes"')) {
        revoked = true
        const removal = await createWorkspaceDeviceRevocation(profile, doc.id, profile.identity.personId,
          profile.device.deviceId, Automerge.getHeads(doc), [profile.certificate])
        await peerStore.putWorkspaceAuthority({ ...authority, updatedAt: new Date().toISOString(),
          catalog: { ...authority.catalog as object, deviceRevocations: [removal] } })
      }
      return result
    })
    const hashes = Automerge.getChangesMetaSince(doc, []).map(change => change.hash)
    await expect(prepareLocalChangeAuthorizations(doc, profile, hashes, factory)).rejects.toThrow(/revok|permission|stale/i)
    expect(revoked).toBe(true)
  } finally { Automerge.free(doc) }
})

it("Given an active enrolled device without the root private key, when creating a workspace through the default browser signer, then publish complete verifiable genesis evidence", async () => {
  resetIdentityStorageForTest()
  const recipient = await bootstrapIdentity("Enrolled browser")
  const storage = new Map<string, string>()
  const owner = await new BrowserIdentityStore({ storageKey: crypto.randomUUID(), storage: {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) },
    removeItem: key => { storage.delete(key) },
  } }).bootstrap("Offline owner") as LocalProfile
  const certificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
    owner.identity.personId, recipient.device.deviceId, recipient.device.publicKey, await certHashDefault(owner.certificate))
  await defaultProofStore.putCertificate(await certHashDefault(owner.certificate), owner.certificate)
  const enrolled = await adoptEnrolledIdentity(owner.identity, certificate)
  expect(enrolled.privateKeys.identityPrivateKey).toBeUndefined()
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "New phone board", owner.identity.personId, "blank"))
  try {
    const proofs = await recordGenesisAuthority(doc, enrolled)
    const stored = await peerStore.getWorkspaceAuthority(doc.id)
    expect(stored?.ownerCertificates).toEqual([certificate, owner.certificate])
    expect(proofs).toHaveLength(1)
    expect(proofs[0]?.certificates).toEqual([certificate, owner.certificate])
    expect(await verifyEnvelope(proofs[0]!.signed, enrolled.device.publicKey)).toBe(true)
    expect((await bootstrapIdentity()).device.deviceId).toBe(recipient.device.deviceId)
  } finally { Automerge.free(doc) }
})

it("Given durable workspace authority cannot be read, then authorization fails closed without changing prior evidence", async () => {
  const { profile, doc } = await fixture()
  try {
    await recordGenesisAuthority(doc, profile)
    const before = await records(doc.id)
    vi.spyOn(peerStore, "getWorkspaceAuthority").mockRejectedValue(new Error("Authority store unavailable"))

    await expect(prepareLocalChangeAuthorizations(doc, profile,
      Automerge.getChangesMetaSince(doc, []).map(change => change.hash))).rejects.toThrow(/authority/i)
    expect(await records(doc.id)).toEqual(before)
  } finally { Automerge.free(doc) }
})


it("Given an exact dependency document, when signing a local delta, then reuse its admitted access basis without materializing a historical view", async () => {
  const { profile, doc } = await fixture()
  let changed: typeof doc | undefined
  try {
    await recordGenesisAuthority(doc, profile)
    changed = Automerge.change(Automerge.clone(doc), draft => { draft.title = "Next title" })
    const hash = Automerge.getHeads(changed)[0]!
    const historicalView = vi.mocked(Automerge.view)
    historicalView.mockClear()
    const [proof] = await prepareLocalChangeAuthorizations(changed, profile, [hash], undefined, doc)
    expect(proof?.signed.payload.hashes).toEqual([hash])
    expect(historicalView).not.toHaveBeenCalled()
    const unrelated = Automerge.change(Automerge.clone(doc), draft => { draft.title = "Other branch" })
    try {
      await expect(prepareLocalChangeAuthorizations(changed, profile, [hash], undefined, unrelated)).rejects.toThrow(/basis|dependenc/i)
    } finally { Automerge.free(unrelated) }
  } finally { if (changed) Automerge.free(changed); Automerge.free(doc) }
})
