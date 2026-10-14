import * as admissionClient from "./workspaceAdmissionClient"
import { hasEntityKind } from "../domain/model"
import { readFile, writeFile } from "node:fs/promises"
import { beforeAll, beforeEach, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceOwnershipTransfer, WorkspaceRevocation } from "@meta-uber/mesh-workspace"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, signEnvelope, type LocalProfile } from "../domain/identity"
import { createWorkspaceDoc } from "../domain/seeds"
import { certHashDefault, createDelegatedCertificate, createWorkspaceGrant, createAutomationWorkspaceGrant, defaultProofStore } from "../domain/proofs"
import { publicKeyId, toBase64Url } from "../domain/identity"
import { createWorkspaceOwnershipTransfer, createWorkspaceDeparture, createWorkspaceDeviceRevocation, createWorkspaceRevocation } from "./meshRecords"
import { executeCommand, type Command } from "../domain/commands"
import { authorityValidationFingerprint, localWorkspaceAdmissionAuthority, exportAuthorizations, exportAuthorizationBundle, exportDocumentAuthorizationBundle, evaluateIncomingWorkspaceAdmission, recordGenesisAuthority, validateIncomingChanges, validateIncomingChangesWithProofStatus, validateIncomingChangeAuthorizations, workspaceRole, workspaceWritesBlocked } from "./changeAuthorization"
import { reconcileOwnerRevocationBoundaries } from "./ownerRevocationBoundaryRepair"
import { assertWorkspaceTransition } from "../domain/permissions"
import { isItem, type WorkspaceDocumentV2 } from "../domain/model"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"

type TestCatalog = {
  revocations?: WorkspaceRevocation[]
  revocationBoundaryHistory?: Array<{ personId: string; removed: unknown[]; replacements: unknown[] }>
  [key: string]: unknown
}
type TestStoredAuthority = {
  workspaceId: string
  ownerPersonId: string
  ownerPublicKey: string
  ownerCertificates?: unknown[]
  localGrant?: unknown
  catalog?: TestCatalog
  [key: string]: unknown
}
const peerStoreState = vi.hoisted(() => ({ credential: null as TestStoredAuthority | null, authority: null as TestStoredAuthority | null }))
vi.mock("@automerge/automerge/slim", async () => {
  const actual = await vi.importActual<typeof Automerge>("@automerge/automerge/slim")
  return { ...actual, diffPath: vi.fn(actual.diffPath), view: vi.fn(actual.view), clone: vi.fn(actual.clone) }
})
vi.mock("./peerStore", () => ({ peerStore: {
  getWorkspaceCredential: async () => peerStoreState.credential,
  getWorkspaceAuthority: async () => peerStoreState.authority,
  putWorkspaceAuthority: async (authority: TestStoredAuthority) => { peerStoreState.authority = authority },
  replaceWorkspaceRevocationGeneration: async ({ workspaceId, personId, expected, replacements }: {
    workspaceId: string; personId: string; expected: unknown[]; replacements: unknown[]
  }) => {
    const credential = peerStoreState.credential
    if (!credential || credential.workspaceId !== workspaceId) throw new Error("Workspace credential disappeared")
    const catalog = credential.catalog ?? {}
    const revocations = catalog.revocations ?? []
    const current = revocations.filter(item => item.payload.personId === personId)
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("Workspace revocations changed during boundary repair")
    const updated = { ...credential, catalog: { ...catalog,
      revocations: [...revocations.filter(item => item.payload.personId !== personId), ...replacements as WorkspaceRevocation[]],
      revocationBoundaryHistory: [...(catalog.revocationBoundaryHistory ?? []), { personId, removed: expected, replacements }],
    } }
    peerStoreState.credential = updated
    peerStoreState.authority = updated
    return updated
  },
  listPeers: async () => [],
} }))
beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})
let owner: LocalProfile, member: LocalProfile
beforeEach(async () => {
  peerStoreState.credential = null
  peerStoreState.authority = null
  resetIdentityStorageForTest(); owner = await bootstrapIdentity("Owner")
  resetIdentityStorageForTest(); member = await bootstrapIdentity("Member")
})
async function fixture(command: (board: string, column: string) => Command, role: "visitor" | "editor", title = "Permissions") {
  const local = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), title, owner.identity.personId, "blank"))
  await recordGenesisAuthority(local, owner)
  const board = Object.values(local.entities).find(e => hasEntityKind(e, "board"))!
  const column = Object.values(local.entities).find(e => hasEntityKind(e, "column"))!
  const result = await executeCommand(local, command(board.id, column.id), member)
  if (!result.ok) throw new Error(result.error.message)
  const signed = await signEnvelope(member.privateKeys.devicePrivateKey, {
    kind: "workspace-changes" as const, version: 1 as const, workspaceId: local.id,
    personId: member.identity.personId, deviceId: member.device.deviceId, hashes: [result.value.receipt.changeHash],
  }, member.device.deviceId)
  const record = { signed, publicKey: member.identity.publicKey, certificates: [member.certificate],
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate],
    grant: await createWorkspaceGrant(owner, local.id, member.identity.personId, role) }
  return { local, remote: result.value.newDoc, record }
}
function authorizationBundle(doc: Automerge.Doc<WorkspaceDocumentV2>, records: unknown[], current = owner) {
  const authority = { personId: owner.identity.personId, publicKey: owner.identity.publicKey, certificates: [owner.certificate] }
  return { version: 1, records, authority: { genesisOwner: authority, genesisEpoch: 1, currentOwner: current === owner
    ? authority : { personId: current.identity.personId, publicKey: current.identity.publicKey, certificates: [current.certificate] },
  currentEpoch: 1,
  ownershipTransfers: [] as WorkspaceOwnershipTransfer[], successionClaims: [], revocations: [], deviceRevocations: [], departures: [] } }
}

it("exports the same fresh authorization evidence from a hydrated document without consuming it", async () => {
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Hydrated proofs", owner.identity.personId, "blank"))
  expect(await exportDocumentAuthorizationBundle(doc, owner)).toEqual(await exportAuthorizationBundle(Automerge.save(doc), owner))
  expect(Automerge.change(doc, draft => { draft.title = "Still writable" }).title).toBe("Still writable")
})

it("Given an enrolled owner device with a delegated certificate, when creating a workspace, then genesis includes the complete verified issuer chain", async () => {
  const certificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId, owner.identity.personId, member.device.deviceId,
    member.device.publicKey, await certHashDefault(owner.certificate))
  await defaultProofStore.putCertificate(await certHashDefault(owner.certificate), owner.certificate)
  const enrolled = { ...member, identity: owner.identity, certificate,
    privateKeys: { devicePrivateKey: member.privateKeys.devicePrivateKey } }
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Enrolled owner's board", owner.identity.personId, "blank"))
  await expect(recordGenesisAuthority(doc, enrolled)).resolves.toHaveLength(1)
  const bundle = await exportDocumentAuthorizationBundle(doc, enrolled)
  expect(bundle.authority?.genesisOwner.certificates).toEqual(expect.arrayContaining([certificate, owner.certificate]))
})

it("Given two valid enrolled devices, When stored certificate order changes, Then local admission and its race guard keep identical authority fingerprints", async () => {
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Certificate representation", owner.identity.personId, "blank"))
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair
  const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)))
  const second = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
    owner.identity.personId, await publicKeyId(publicKey), publicKey, await certHashDefault(owner.certificate))
  const stored = { version: 1 as const, workspaceId: doc.id, ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate, second], epoch: 1, updatedAt: "first", catalog: {} }
  peerStoreState.authority = stored
  peerStoreState.credential = stored
  const before = await localWorkspaceAdmissionAuthority(doc, owner)
  const reversed = { ...stored, ownerCertificates: [...stored.ownerCertificates].reverse(), updatedAt: "second" }
  peerStoreState.authority = reversed
  peerStoreState.credential = reversed
  expect(authorityValidationFingerprint(reversed)).toBe(authorityValidationFingerprint(stored))
  expect((await localWorkspaceAdmissionAuthority(doc, owner)).fingerprint).toBe(before.fingerprint)
  Automerge.free(doc)
})

it("reports admission phase costs without changing the authorized result", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Measured" }), "editor")
  const result = await evaluateIncomingWorkspaceAdmission(local, remote, authorizationBundle(local, [record]))
  expect(result.profile).toMatchObject({ changeCount: 2, proofCount: 2 })
  for (const phase of ["loadMs", "prepareMs", "policyMs", "indexMs", "transitionsMs", "resultMs"]) {
    expect(result.profile?.[phase as keyof NonNullable<typeof result.profile>]).toBeGreaterThanOrEqual(0)
  }
  expect(result.admittedHashes).toContain(record.signed.payload.hashes[0])
})

it("Given one raw document used as local and remote, When reclassifying it, Then avoid a full clone and keep the caller document usable", async () => {
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Self admission", owner.identity.personId, "blank"))
  await recordGenesisAuthority(doc, owner)
  const bundle = await exportDocumentAuthorizationBundle(doc, owner)
  vi.mocked(Automerge.clone).mockClear()
  try {
    const result = await evaluateIncomingWorkspaceAdmission(doc, doc, bundle)
    expect(result.admittedHashes).toHaveLength(1)
    expect(Automerge.clone).not.toHaveBeenCalled()
    expect(Automerge.change(doc, draft => { draft.title = "Still writable" }).title).toBe("Still writable")
  } finally { Automerge.free(doc) }
})

it("Given unproven raw history, When its missing signed proof arrives then repeated packets reuse admission, but invalid or revoked evidence is checked again", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Late proof" }), "editor")
  const admit = vi.spyOn(admissionClient, "runWorkspaceAdmission")
  try {
    const hash = record.signed.payload.hashes[0]!
    const pending = await evaluateIncomingWorkspaceAdmission(local, remote, authorizationBundle(local, []))
    expect(pending.admittedHashes).not.toContain(hash)
    expect([...pending.pendingHashes, ...pending.quarantinedHashes]).toContain(hash)
    const accepted = await evaluateIncomingWorkspaceAdmission(local, remote, authorizationBundle(local, [record]))
    expect(accepted.admittedHashes).toContain(hash)
    expect(admit).toHaveBeenCalledTimes(2)
    const repeated = await evaluateIncomingWorkspaceAdmission(local, remote, authorizationBundle(local, [record]))
    expect(repeated.admittedHashes).toContain(hash)
    expect(repeated.authorizedDocument).toEqual(accepted.authorizedDocument)
    expect(admit).toHaveBeenCalledTimes(2)
    const invalid = { ...record, signed: { ...record.signed, signature: "invalid" } }
    await expect(evaluateIncomingWorkspaceAdmission(local, remote, authorizationBundle(local, [invalid]))).rejects.toThrow("Invalid signature")
    await expect(evaluateIncomingWorkspaceAdmission(local, remote, authorizationBundle(local, [invalid]))).rejects.toThrow("Invalid signature")
    expect(admit).toHaveBeenCalledTimes(4)
    const revocation = await createWorkspaceDeviceRevocation(owner, local.id, member.identity.personId,
      member.device.deviceId, Automerge.getHeads(local), [owner.certificate])
    const bundle = authorizationBundle(local, [record])
    const revoked = await evaluateIncomingWorkspaceAdmission(local, remote,
      { ...bundle, authority: { ...bundle.authority, deviceRevocations: [{ record: revocation.record, signer: revocation.authority }] } })
    expect(revoked.quarantinedHashes).toContain(hash)
    expect(admit).toHaveBeenCalledTimes(5)
  } finally { admit.mockRestore(); Automerge.free(local); Automerge.free(remote) }
})

it("admits a signed owner bootstrap with long text without expanding it into text patches", async () => {
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Long text ".repeat(5000), owner.identity.personId, "job-search"))
  await recordGenesisAuthority(doc, owner)
  const diff = vi.mocked(Automerge.diffPath)
  diff.mockClear()
  try {
    const result = await evaluateIncomingWorkspaceAdmission(undefined, doc, await exportDocumentAuthorizationBundle(doc, owner))
    expect(result.admittedHashes).toHaveLength(1)
    expect(result.quarantinedHashes).toEqual([])
    expect(Automerge.load<WorkspaceDocumentV2>(result.authorizedDocument).title).toBe(doc.title)
    expect(diff).not.toHaveBeenCalled()
  } finally { Automerge.free(doc) }
})

it("checks a signed item edit without materializing unrelated whole-document historical views", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Measured edit" }), "editor", "Unrelated text ".repeat(5000))
  const views = vi.mocked(Automerge.view)
  views.mockClear()
  const result = await evaluateIncomingWorkspaceAdmission(local, remote, authorizationBundle(local, [record]))
  expect(result.admittedHashes).toContain(record.signed.payload.hashes[0])
  // Only the ambiguous initial root-map creation needs full historical views.
  expect(views.mock.calls.length).toBe(2)
})

it.runIf(process.env.TINCANBAN_PROOF_BENCHMARK === "1")("benchmarks complete TS/WASM admission and one delta on deterministic signed histories", async () => {
  const timings: unknown[] = []
  for (const count of [100, 1000, 20_001]) {
    let doc = Automerge.from(createWorkspaceDoc(`proof-benchmark-${count}`, "Proof benchmark", owner.identity.personId, "blank"))
    const records: unknown[] = []
    for (let index = 0; index < count; index++) {
      if (index) {
        doc = Automerge.change(doc, draft => { draft.title = `Proof benchmark ${index}` })
      }
      const change = Automerge.decodeChange(Automerge.getLastLocalChange(doc)!)
      const signed = await signEnvelope(owner.privateKeys.devicePrivateKey, {
        kind: "workspace-changes" as const, version: 1 as const, workspaceId: doc.id,
        personId: owner.identity.personId, deviceId: owner.device.deviceId, hashes: [change.hash],
      }, owner.device.deviceId)
      records.push({ signed, publicKey: owner.identity.publicKey, certificates: [owner.certificate] })
    }
    const legacy = authorizationBundle(doc, records)
    if (count > 20_000) await expect(validateIncomingChangeAuthorizations(undefined, doc, legacy)).rejects.toThrow(/size limit/)
    const pages: unknown[][] = [[]]
    let pageBytes = 2
    for (const record of records) {
      const recordBytes = new TextEncoder().encode(JSON.stringify(record)).length
      if (pageBytes + recordBytes + 1 > 200 * 1024) { pages.push([]); pageBytes = 2 }
      pages.at(-1)!.push(record)
      pageBytes += recordBytes + 1
    }
    const bundle = { version: 2, authority: legacy.authority, pages }
    const sourceStarted = performance.now()
    const manifest = meshRustRuntime().state.authorizationExport(Automerge.save(doc), legacy)
    const sourceExportMs = performance.now() - sourceStarted
    expect(manifest).toHaveProperty("kind", "workspace-authorization-manifest")
    const started = performance.now()
    expect(await validateIncomingChangeAuthorizations(undefined, doc, bundle)).toHaveLength(count)
    const fullAdmissionMs = performance.now() - started
    const remote = Automerge.change(Automerge.clone(doc), draft => { draft.title = "New delta" })
    const hash = Automerge.decodeChange(Automerge.getLastLocalChange(remote)!).hash
    const signed = await signEnvelope(owner.privateKeys.devicePrivateKey, {
      kind: "workspace-changes" as const, version: 1 as const, workspaceId: doc.id,
      personId: owner.identity.personId, deviceId: owner.device.deviceId, hashes: [hash],
    }, owner.device.deviceId)
    const deltaStarted = performance.now()
    expect(await validateIncomingChangeAuthorizations(doc, remote, { version: 2, authority: legacy.authority,
      pages: [[{ signed, publicKey: owner.identity.publicKey, certificates: [owner.certificate] }]] })).toHaveLength(1)
    timings.push({ history: count, proofs: count, aggregateBytes: new TextEncoder().encode(JSON.stringify(legacy)).length,
      pages: pages.length, sourceExportMs, fullAdmissionMs, deltaHistory: count + 1, deltaProofs: 1,
      deltaAdmissionMs: performance.now() - deltaStarted })
    Automerge.free(remote)
    Automerge.free(doc)
  }
  console.info("proof_admission_benchmark", JSON.stringify(timings))
  await writeFile("/tmp/tincanban-proof-admission-benchmark.json", JSON.stringify(timings, null, 2))
}, 180_000)
it("rejects visitor writes even with a valid device signature and owner-issued visitor grant", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Forbidden" }), "visitor")
  const admission = await evaluateIncomingWorkspaceAdmission(local, remote, authorizationBundle(local, [record]))
  const status = admission.decisions.find(decision => decision.hash === record.signed.payload.hashes[0])?.status
  expect(status?.type).toBe("quarantined")
  expect(status?.type === "quarantined" ? status.reason : "").toMatch(/own avatar profile/)
  expect(() => assertWorkspaceTransition("visitor", local, remote)).toThrow(/Visitors/)
})

it("quarantines an unsigned received branch without materializing it in the authorized projection", async () => {
  const local = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Unsigned source", owner.identity.personId, "blank"))
  await recordGenesisAuthority(local, owner)
  const remote = Automerge.change(Automerge.clone(local), { message: "Unsigned edit" }, draft => {
    draft.title = "Untrusted title"
  })
  const hash = Automerge.decodeChange(Automerge.getLastLocalChange(remote)!).hash

  const admission = await evaluateIncomingWorkspaceAdmission(local, remote, authorizationBundle(local, []))
  const decision = admission.decisions.find(item => item.hash === hash)
  const authorized = Automerge.load<WorkspaceDocumentV2>(admission.authorizedDocument)
  try {
    expect(decision?.status.type).toBe("quarantined")
    expect(admission.admittedHashes).not.toContain(hash)
    expect(authorized.title).toBe("Unsigned source")
    expect(Automerge.getHeads(authorized).sort()).toEqual(Automerge.getHeads(local).sort())
  } finally {
    Automerge.free(authorized)
    Automerge.free(remote)
    Automerge.free(local)
  }
})

it("admits a visitor's signed change only for their own avatar profile", async () => {
  const { local, remote, record } = await fixture(() => ({ kind: "setMemberAvatar", avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA" }), "visitor")
  await expect(validateIncomingChanges(local, remote, authorizationBundle(local, [record]))).resolves.toBeUndefined()
  expect(() => assertWorkspaceTransition("visitor", local, remote, owner.identity.personId))
    .toThrow("A participant may change only their own profile")
})

it("defaults an omitted optional departures list before calling Rust", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Forbidden" }), "visitor")
  const bundle = authorizationBundle(local, [record])
  Reflect.deleteProperty(bundle.authority, "departures")
  const admission = await evaluateIncomingWorkspaceAdmission(local, remote, bundle)
  expect(admission.decisions.some(decision => decision.status.type === "quarantined")).toBe(true)
})

it("Given divergent durable branches, metadata admission retains dependency coverage and rejects missing parent proof", async () => {
  const base = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Divergence", owner.identity.personId, "blank"))
  await recordGenesisAuthority(base, owner)
  const local = Automerge.change(Automerge.clone(base), draft => { draft.title = "Local branch" })
  const parent = Automerge.change(Automerge.clone(base), draft => { draft.title = "Remote parent" })
  const remote = Automerge.change(parent, draft => { draft.title = "Remote child" })
  const remoteMetadata = Automerge.getChangesMetaSince(remote, Automerge.getHeads(base))
  const records = await Promise.all(remoteMetadata.map(async change => ({
    signed: await signEnvelope(owner.privateKeys.devicePrivateKey, { kind: "workspace-changes" as const,
      version: 1 as const, workspaceId: base.id, personId: owner.identity.personId,
      deviceId: owner.device.deviceId, hashes: [change.hash] }, owner.device.deviceId),
    publicKey: owner.identity.publicKey, certificates: [owner.certificate],
  })))
  expect(await validateIncomingChangeAuthorizations(local, remote,
    { version: 2, authority: authorizationBundle(base, []).authority, pages: [records] })).toHaveLength(3)
  const missingParent = await evaluateIncomingWorkspaceAdmission(local, remote,
    { version: 2, authority: authorizationBundle(base, []).authority, pages: [[records[1]]] })
  expect(missingParent.decisions.filter(decision => remoteMetadata.some(change => change.hash === decision.hash))
    .every(decision => decision.status.type !== "admitted")).toBe(true)
})

it("admits a valid editor bundle when optional departures are omitted", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Allowed" }), "editor")
  const bundle = authorizationBundle(local, [record])
  Reflect.deleteProperty(bundle.authority, "departures")
  await expect(validateIncomingChanges(local, remote, bundle)).resolves.toBeUndefined()
})

it("rejects malformed present departures evidence before Rust", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Malformed" }), "editor")
  const bundle = authorizationBundle(local, [record])
  Reflect.set(bundle.authority, "departures", null)
  await expect(validateIncomingChanges(local, remote, bundle)).rejects.toThrow("Invalid workspace authority departures")
})
it("accepts signed editor item changes with a delegated-device grant, including when forwarded by another peer", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Allowed" }), "editor")
  await expect(validateIncomingChanges(local, remote, authorizationBundle(local, [record]))).resolves.toBeUndefined()
  expect(() => assertWorkspaceTransition("editor", local, remote)).not.toThrow()
})
it("accepts an owner-root grant and rejects a forged root grant", async () => {
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Root grants", owner.identity.personId, "blank"))
  const payload = {
    kind: "workspace-grant" as const, version: 1 as const, grantId: crypto.randomUUID(), workspaceId: doc.id,
    personId: member.identity.personId, role: "editor" as const, accessEpoch: 1,
  }
  const rootGrant = await signEnvelope(owner.privateKeys.identityPrivateKey!, payload, owner.identity.personId)
  peerStoreState.authority = {
    workspaceId: doc.id, ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate], ownerHistory: [], localGrant: rootGrant, epoch: 1, catalog: {},
  }
  await expect(workspaceRole(doc, member)).resolves.toBe("editor")

  const forgedGrant = await signEnvelope(member.privateKeys.identityPrivateKey!, payload, member.identity.personId)
  peerStoreState.authority.localGrant = forgedGrant
  await expect(workspaceRole(doc, member)).resolves.toBe("visitor")
})

it("derives local owner, editor, visitor, revocation, departure, renewal, and device removal from Rust", async () => {
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Access decision", owner.identity.personId, "blank"))
  peerStoreState.authority = {
    workspaceId: doc.id, ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate], ownerHistory: [], epoch: 1, catalog: {},
  }
  await expect(workspaceRole(doc, owner)).resolves.toBe("owner")

  const editorGrant = await createWorkspaceGrant(owner, doc.id, member.identity.personId, "editor", 1)
  peerStoreState.authority.localGrant = editorGrant
  await expect(workspaceRole(doc, member)).resolves.toBe("editor")
  peerStoreState.authority.localGrant = await createWorkspaceGrant(owner, doc.id, member.identity.personId, "visitor", 1)
  await expect(workspaceRole(doc, member)).resolves.toBe("visitor")

  peerStoreState.authority.localGrant = editorGrant
  peerStoreState.authority.catalog = { revocations: [await createWorkspaceRevocation(owner, doc.id,
    member.identity.personId, 2, Automerge.getHeads(doc))] }
  await expect(workspaceRole(doc, member)).resolves.toBe("visitor")
  peerStoreState.authority.localGrant = await createWorkspaceGrant(owner, doc.id, member.identity.personId, "editor", 3)
  await expect(workspaceRole(doc, member)).resolves.toBe("editor")

  peerStoreState.authority.localGrant = editorGrant
  peerStoreState.authority.catalog = { departures: [await createWorkspaceDeparture(member, doc.id, 2, Automerge.getHeads(doc), [member.certificate])] }
  await expect(workspaceRole(doc, member)).resolves.toBe("visitor")
  peerStoreState.authority.localGrant = await createWorkspaceGrant(owner, doc.id, member.identity.personId, "editor", 3)
  await expect(workspaceRole(doc, member)).resolves.toBe("editor")

  peerStoreState.authority.catalog = { deviceRevocations: [await createWorkspaceDeviceRevocation(owner, doc.id,
    member.identity.personId, member.device.deviceId, Automerge.getHeads(doc), [owner.certificate])] }
  await expect(workspaceRole(doc, member)).resolves.toBe("visitor")
})

it("repairs a current-owner signed revocation bound only to quarantined raw history", async () => {
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Owner recovery", owner.identity.personId, "blank"))
  const raw = Automerge.change(Automerge.clone(doc), draft => {
    ;(draft as unknown as Record<string, unknown>).unadmittedEvidence = "quarantined"
  })
  const old = await createWorkspaceRevocation(owner, doc.id, member.identity.personId, 6, Automerge.getHeads(raw))
  const credential = { version: 1, workspaceId: doc.id, ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: "secret", epoch: 6,
    updatedAt: new Date().toISOString(), localGrant: await createWorkspaceGrant(owner, doc.id, owner.identity.personId, "owner"),
    catalog: { revocations: [old] } }
  peerStoreState.credential = credential
  peerStoreState.authority = structuredClone(credential)
  peerStoreState.authority.localGrant = await createWorkspaceGrant(owner, doc.id, owner.identity.personId, "owner")

  await expect(workspaceRole(doc, owner)).rejects.toThrow(/missing from the document/)
  await reconcileOwnerRevocationBoundaries(doc, owner)

  const repairedAuthority = peerStoreState.authority!
  const repairedCatalog = repairedAuthority.catalog!
  const repaired = repairedCatalog.revocations![0]
  expect(repaired.payload.personId).toBe(member.identity.personId)
  expect(repaired.payload.epoch).toBeGreaterThan(old.payload.epoch)
  expect(repaired.payload.workspaceHeads).toEqual(Automerge.getHeads(doc))
  expect(repairedCatalog.revocationBoundaryHistory![0].removed).toEqual([old])
  await expect(workspaceRole(doc, owner)).resolves.toBe("owner")
  peerStoreState.authority.localGrant = await createWorkspaceGrant(owner, doc.id, member.identity.personId, "editor", 1)
  await expect(workspaceRole(doc, member)).resolves.toBe("visitor")
  expect(Automerge.getHeads(raw)).not.toEqual(Automerge.getHeads(doc))
})

it("does not repair a missing boundary with a foreign-owner signature", async () => {
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Reject foreign repair", owner.identity.personId, "blank"))
  const raw = Automerge.change(Automerge.clone(doc), draft => {
    ;(draft as unknown as Record<string, unknown>).unadmittedEvidence = "quarantined"
  })
  const bad: WorkspaceRevocation = await signEnvelope(member.privateKeys.identityPrivateKey!, {
    kind: "workspace-revocation" as const, version: 1 as const, workspaceId: doc.id, ownerPersonId: owner.identity.personId,
    personId: "revoked-person", epoch: 6, workspaceHeads: Automerge.getHeads(raw), revokedAt: new Date().toISOString(),
  }, member.identity.personId)
  const credential = { version: 1, workspaceId: doc.id, ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: "secret", epoch: 6,
    updatedAt: new Date().toISOString(), catalog: { revocations: [bad] } }
  peerStoreState.credential = credential
  peerStoreState.authority = structuredClone(credential)

  await expect(reconcileOwnerRevocationBoundaries(doc, owner)).rejects.toThrow(/Invalid workspace revocation signature/)
  expect(peerStoreState.authority!.catalog!.revocations).toEqual([bad])
})

it("does not repair owner boundaries from a revoked owner device", async () => {
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Reject revoked repair device", owner.identity.personId, "blank"))
  const raw = Automerge.change(Automerge.clone(doc), draft => {
    ;(draft as unknown as Record<string, unknown>).unadmittedEvidence = "quarantined"
  })
  const old = await createWorkspaceRevocation(owner, doc.id, member.identity.personId, 6, Automerge.getHeads(raw))
  const revokedDevice = await createWorkspaceDeviceRevocation(owner, doc.id, owner.identity.personId,
    owner.device.deviceId, Automerge.getHeads(doc), [owner.certificate])
  const credential = { version: 1, workspaceId: doc.id, ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: "secret", epoch: 6,
    updatedAt: new Date().toISOString(), catalog: { revocations: [old], deviceRevocations: [revokedDevice] } }
  peerStoreState.credential = credential
  peerStoreState.authority = structuredClone(credential)

  await expect(reconcileOwnerRevocationBoundaries(doc, owner)).rejects.toThrow(/revoked owner device/)
  expect(peerStoreState.authority!.catalog!.revocations).toEqual([old])
  expect(peerStoreState.authority!.catalog!.revocationBoundaryHistory).toBeUndefined()
})

it("admits a revoked device's signed change at its revocation frontier and rejects a later signed change", async () => {
  const base = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Device revocation frontier", owner.identity.personId, "blank"))
  await recordGenesisAuthority(base, owner)
  const column = Object.values(base.entities).find(entity => entity.kind === "column")!
  const grant = await createWorkspaceGrant(owner, base.id, member.identity.personId, "editor", 1)
  let frontier = base
  const atFrontier = await executeCommand(frontier, { kind: "createItem", parentId: column.id, title: "Before revocation" }, member)
  if (!atFrontier.ok) throw new Error(atFrontier.error.message)
  frontier = atFrontier.value.newDoc
  const frontierHash = atFrontier.value.receipt.changeHash
  const revocation = await createWorkspaceDeviceRevocation(owner, base.id, member.identity.personId,
    member.device.deviceId, Automerge.getHeads(frontier), [owner.certificate])

  const afterFrontier = await executeCommand(frontier, { kind: "createItem", parentId: column.id, title: "After revocation" }, member)
  if (!afterFrontier.ok) throw new Error(afterFrontier.error.message)
  const later = afterFrontier.value.newDoc
  const changes = [frontierHash, afterFrontier.value.receipt.changeHash]
  const records = await Promise.all(changes.map(async hash => ({
    signed: await signEnvelope(member.privateKeys.devicePrivateKey, {
      kind: "workspace-changes" as const, version: 1 as const, workspaceId: base.id,
      personId: member.identity.personId, deviceId: member.device.deviceId, hashes: [hash],
    }, member.device.deviceId),
    publicKey: member.identity.publicKey, certificates: [member.certificate], ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate], grant,
  })))
  const bundle = authorizationBundle(base, records)
  const revokedBundle = { ...bundle, authority: { ...bundle.authority,
    deviceRevocations: [{ record: revocation.record, signer: revocation.authority }] } }

  // The frontier change itself remains admissible on a replica that has not seen it.
  await expect(validateIncomingChanges(base, frontier, revokedBundle)).resolves.toBeUndefined()
  const laterAdmission = await evaluateIncomingWorkspaceAdmission(frontier, later, revokedBundle)
  expect(laterAdmission.decisions.find(decision => decision.hash === changes[1])?.status.type).toBe("quarantined")
})

it("accepts transferred-owner history on a clean replica only when the supplied authority chain verifies", async () => {
  resetIdentityStorageForTest(); const successor = await bootstrapIdentity("Successor")
  const local = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Transferred", owner.identity.personId, "blank"))
  const column = Object.values(local.entities).find(entity => hasEntityKind(entity, "column"))!
  const transfer = await createWorkspaceOwnershipTransfer(owner, local.id, {
    personId: successor.identity.personId, publicKey: successor.identity.publicKey, certificates: [successor.certificate],
  }, Automerge.getHeads(local), 2)
  const genesisSigned = await signEnvelope(owner.privateKeys.devicePrivateKey, {
    kind: "workspace-changes" as const, version: 1 as const, workspaceId: local.id,
    personId: owner.identity.personId, deviceId: owner.device.deviceId,
    hashes: Automerge.getAllChanges(local).map(change => Automerge.decodeChange(change).hash),
  }, owner.device.deviceId)
  const result = await executeCommand(local, { kind: "createItem", parentId: column.id, title: "Successor write" }, successor)
  if (!result.ok) throw new Error(result.error.message)
  const signed = await signEnvelope(successor.privateKeys.devicePrivateKey, {
    kind: "workspace-changes" as const, version: 1 as const, workspaceId: local.id,
    personId: successor.identity.personId, deviceId: successor.device.deviceId, hashes: [result.value.receipt.changeHash],
  }, successor.device.deviceId)
  const authority = { personId: owner.identity.personId, publicKey: owner.identity.publicKey, certificates: [owner.certificate] }
  peerStoreState.authority = {
    version: 1, workspaceId: local.id, genesisOwnerPersonId: owner.identity.personId,
    ownerPersonId: successor.identity.personId, ownerPublicKey: successor.identity.publicKey,
    ownerCertificates: [successor.certificate], ownerHistory: [authority], localGrant: undefined,
    epoch: 2, updatedAt: new Date().toISOString(), catalog: { ownershipTransfers: [transfer] },
  }
  await expect(workspaceRole(local, successor)).resolves.toBe("owner")
  const bundle = {
    version: 1, records: [
      { signed: genesisSigned, publicKey: owner.identity.publicKey, certificates: [owner.certificate] },
      { signed, publicKey: successor.identity.publicKey, certificates: [successor.certificate] },
    ],
    authority: { genesisOwner: authority, genesisEpoch: 1,
      currentOwner: { personId: successor.identity.personId, publicKey: successor.identity.publicKey, certificates: [successor.certificate] },
      currentEpoch: 2,
      ownershipTransfers: [transfer], successionClaims: [], revocations: [], deviceRevocations: [], departures: [] },
  }

  await expect(validateIncomingChanges(undefined, result.value.newDoc, bundle)).resolves.toBeUndefined()
  await expect(validateIncomingChanges(undefined, result.value.newDoc, { ...bundle,
    records: [bundle.records[0], { ...bundle.records[1], signed: { ...signed, signature: `${signed.signature}forged` } }] })).rejects.toThrow(/signature/i)
  await expect(validateIncomingChanges(undefined, result.value.newDoc, { ...bundle,
    authority: { ...bundle.authority, ownershipTransfers: [{ ...transfer, signature: `${transfer.signature}forged` }] } })).rejects.toThrow(/signature/i)
})
it("reports a proof change only once when the same authorization is replayed", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Idempotent" }), "editor")
  await expect(validateIncomingChangesWithProofStatus(local, remote, authorizationBundle(local, [record]))).resolves.toBe(true)
  await expect(validateIncomingChangesWithProofStatus(remote, remote, authorizationBundle(remote, [record]))).resolves.toBe(false)
})
it("keeps a later local owner boundary when admitting a peer's older history", async () => {
  resetIdentityStorageForTest(); const successor = await bootstrapIdentity("Successor")
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Boundary", owner.identity.personId, "blank"))
  const transfer = await createWorkspaceOwnershipTransfer(owner, doc.id, {
    personId: successor.identity.personId, publicKey: successor.identity.publicKey, certificates: [successor.certificate],
  }, Automerge.getHeads(doc), 2)
  peerStoreState.authority = { version: 1, workspaceId: doc.id, genesisOwnerPersonId: owner.identity.personId,
    ownerPersonId: successor.identity.personId, ownerPublicKey: successor.identity.publicKey,
    ownerCertificates: [successor.certificate], ownerHistory: [{ personId: owner.identity.personId,
      publicKey: owner.identity.publicKey, certificates: [owner.certificate] }], epoch: 2,
    updatedAt: new Date().toISOString(), catalog: { ownershipTransfers: [transfer] } }
  const signed = await signEnvelope(owner.privateKeys.devicePrivateKey, {
    kind: "workspace-changes" as const, version: 1 as const, workspaceId: doc.id,
    personId: owner.identity.personId, deviceId: owner.device.deviceId,
    hashes: Automerge.getAllChanges(doc).map(change => Automerge.decodeChange(change).hash),
  }, owner.device.deviceId)
  await expect(validateIncomingChanges(doc, doc, authorizationBundle(doc, [{ signed,
    publicKey: owner.identity.publicKey, certificates: [owner.certificate] }]))).resolves.toBeUndefined()
  const stalePeer = authorizationBundle(doc, [{ signed,
    publicKey: owner.identity.publicKey, certificates: [owner.certificate] }])
  stalePeer.authority.currentEpoch = 2
  await expect(validateIncomingChanges(doc, doc, stalePeer)).resolves.toBeUndefined()
  stalePeer.authority.ownershipTransfers = [transfer]
  await expect(validateIncomingChanges(doc, doc, stalePeer)).resolves.toBeUndefined()
  peerStoreState.authority = { ...peerStoreState.authority,
    ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate], ownerHistory: [], catalog: {} }
  const transferredPeer = authorizationBundle(doc, [{ signed,
    publicKey: owner.identity.publicKey, certificates: [owner.certificate] }], successor)
  transferredPeer.authority.currentEpoch = 2
  transferredPeer.authority.ownershipTransfers = [transfer]
  await expect(validateIncomingChanges(doc, doc, transferredPeer)).resolves.toBeUndefined()
})
it("does not persist a proof while validating an incoming workspace", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Pure" }), "editor")
  await expect(validateIncomingChangeAuthorizations(local, remote, authorizationBundle(local, [record]))).resolves.toHaveLength(2)
  await expect(validateIncomingChangesWithProofStatus(local, remote, authorizationBundle(local, [record]))).resolves.toBe(true)
})
it("reports a proof change once when a replay enriches certificates around the same change signature", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Enriched" }), "editor")
  await expect(validateIncomingChangesWithProofStatus(local, remote, authorizationBundle(local, [record]))).resolves.toBe(true)
  const enriched = { ...record, ownerCertificates: [...record.ownerCertificates, member.certificate] }
  await expect(validateIncomingChangesWithProofStatus(remote, remote, authorizationBundle(remote, [enriched]))).resolves.toBe(true)
  await expect(validateIncomingChangesWithProofStatus(remote, remote, authorizationBundle(remote, [record]))).resolves.toBe(false)
  const stored = (await exportAuthorizations(Automerge.save(remote)))
    .find(proof => proof.signed.signature === record.signed.signature)
  expect(stored?.ownerCertificates).toHaveLength(2)
})
it("accepts a historical editor grant when its signed authorization carries a missing owner device certificate", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Forwarded" }), "editor")
  peerStoreState.credential = {
    workspaceId: local.id,
    ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [],
    localGrant: undefined,
    ownerHistory: [],
    catalog: {},
  }

  const bundle = authorizationBundle(local, [record])
  bundle.authority.genesisOwner.certificates = []
  bundle.authority.currentOwner.certificates = []
  await expect(validateIncomingChanges(local, remote, bundle)).resolves.toBeUndefined()
})
it("accepts an editor changing only workspace title casing", async () => {
  const { local, remote, record } = await fixture(() => ({ kind: "renameWorkspace", title: "twang" }), "editor")
  await expect(validateIncomingChanges(local, remote, authorizationBundle(local, [record]))).resolves.toBeUndefined()
  expect(() => assertWorkspaceTransition("editor", local, remote)).not.toThrow()
  expect(remote.title).toBe("twang")
})

it("rejects editor board-structure changes through the same policy used for local commands", async () => {
  const { local, remote, record } = await fixture(boardId => ({ kind: "createColumn", boardId, title: "Forbidden" }), "editor")
  await expect(validateIncomingChanges(local, remote, authorizationBundle(local, [record]))).rejects.toThrow(/Only the owner/)
  expect(() => assertWorkspaceTransition("editor", local, remote)).toThrow(/Only the owner/)
})
it("rejects a valid signature over a different change hash", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Original" }), "editor")
  const forged = Automerge.change(Automerge.clone(remote), draft => { draft.title = "Forged" })
  const admission = await evaluateIncomingWorkspaceAdmission(local, forged, authorizationBundle(local, [record]))
  const forgedHash = Automerge.getChangesMetaSince(forged, Automerge.getHeads(remote))[0]!.hash
  expect(admission.decisions.find(decision => decision.hash === forgedHash)?.status.type).not.toBe("admitted")
})
it("rejects a forged owner-issued role", async () => {
  const { local, remote, record } = await fixture((_, parentId) => ({ kind: "createItem", parentId, title: "Forbidden" }), "visitor")
  record.grant.payload.role = "editor"
  await expect(validateIncomingChanges(local, remote, authorizationBundle(local, [record]))).rejects.toThrow(/Visitors|signature/)
})

it("Given a forged durable authority and a valid active credential, when role is recovered, then the forged authority cannot grant editor access", async () => {
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Forged authority", owner.identity.personId, "blank"))
  const localGrant = await createWorkspaceGrant(owner, doc.id, member.identity.personId, "editor")
  peerStoreState.credential = {
    workspaceId: doc.id, ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate], localGrant, ownerHistory: [], catalog: {}, epoch: 1,
  }
  peerStoreState.authority = {
    ...peerStoreState.credential, ownerPersonId: "forged-owner", ownerPublicKey: "forged-key",
    ownerHistory: [{ personId: owner.identity.personId, publicKey: owner.identity.publicKey, certificates: [owner.certificate] }],
  }

  await expect(workspaceRole(doc, member)).resolves.toBe("visitor")
})

it("Given malformed stored authority and an owner profile, When local admission binds its context, Then profile fallback cannot hide the invalid authority", async () => {
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Invalid stored authority", owner.identity.personId, "blank"))
  peerStoreState.authority = { version: 1, workspaceId: doc.id, genesisOwnerPersonId: owner.identity.personId,
    ownerPersonId: owner.identity.personId, ownerPublicKey: "forged-key", ownerCertificates: [owner.certificate],
    ownerHistory: [], catalog: {}, epoch: 1 }
  await expect(localWorkspaceAdmissionAuthority(doc, owner)).rejects.toThrow("Workspace authority could not be verified")
})

it("Given a real signed automation grant, When its exact expiry arrives without changed authority, Then the Rust access policy removes automation access immediately", async () => {
  const now = Date.now(), expiresAt = now + 1
  const clock = vi.spyOn(Date, "now").mockReturnValue(now)
  try {
    const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Signed automation expiry", owner.identity.personId, "blank"))
    const board = Object.values(doc.entities).find(entity => entity.kind === "board")!
    const columns = Object.values(doc.entities).filter(entity => entity.kind === "column")
    const localGrant = await createAutomationWorkspaceGrant(owner, doc.id, member.identity.personId, {
      version: 1, boardId: board.id, columns: { lead: columns[0]!.id, interview: columns[1]!.id, rejected: columns[2]!.id },
      fieldIds: ["company"], expiresAt,
    })
    peerStoreState.authority = { version: 1, workspaceId: doc.id, genesisOwnerPersonId: owner.identity.personId,
      ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate],
      localGrant, ownerHistory: [], catalog: {}, epoch: 1 }
    await expect(workspaceRole(doc, member)).resolves.toBe("automation")
    clock.mockReturnValue(expiresAt)
    await expect(workspaceRole(doc, member)).resolves.toBe("visitor")
  } finally { clock.mockRestore() }
})

it("Given a current owner authority with a historical owner grant, when role is recovered, then the legitimate historical grant remains editor access", async () => {
  resetIdentityStorageForTest(); const successor = await bootstrapIdentity("Successor")
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Historical authority", owner.identity.personId, "blank"))
  const localGrant = await createWorkspaceGrant(owner, doc.id, member.identity.personId, "editor")
  const transfer = await createWorkspaceOwnershipTransfer(owner, doc.id, {
    personId: successor.identity.personId, publicKey: successor.identity.publicKey, certificates: [successor.certificate],
  }, Automerge.getHeads(doc), 2)
  peerStoreState.authority = {
    workspaceId: doc.id, ownerPersonId: successor.identity.personId, ownerPublicKey: successor.identity.publicKey,
    ownerCertificates: [successor.certificate], localGrant, epoch: 2, catalog: {},
    ownerHistory: [{ personId: owner.identity.personId, publicKey: owner.identity.publicKey, certificates: [owner.certificate] }],
  }
  peerStoreState.authority.catalog = { ownershipTransfers: [transfer] }

  await expect(workspaceRole(doc, member)).resolves.toBe("editor")
})

it("Given two manual transfers from one owner at one epoch, when authorization checks the workspace, then writes stay frozen", async () => {
  const remote = Automerge.from(createWorkspaceDoc("workspace", "Frozen", owner.identity.personId, "blank"))
  peerStoreState.credential = {
    workspaceId: remote.id, ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate], ownerHistory: [], localGrant: undefined, epoch: 1,
    catalog: { ownershipTransfers: [
      { payload: { epoch: 2, fromOwnerPersonId: "owner", toOwnerPersonId: "alice" } },
      { payload: { epoch: 2, fromOwnerPersonId: "owner", toOwnerPersonId: "bob" } },
    ] },
  }

  await expect(validateIncomingChanges(undefined, remote, [])).rejects.toThrow(/conflicting ownership records/i)
})

it("Given one local ownership transfer before mesh startup, when write access is checked, then Rust runtime is not required", async () => {
  peerStoreState.credential = {
    version: 1,
    workspaceId: "local-transfer-before-runtime",
    ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate],
    transportSecret: "test-secret",
    updatedAt: new Date().toISOString(),
    epoch: 1,
    catalog: { ownershipTransfers: [
      { payload: { epoch: 2, fromOwnerPersonId: "owner", toOwnerPersonId: "alice" } },
    ] },
  }

  await expect(workspaceWritesBlocked("workspace")).resolves.toBe(false)
})

it("Given split owners wrote on separate partitions, when the branches meet, then neither branch is admitted under ambiguous authority", async () => {
  resetIdentityStorageForTest(); const first = await bootstrapIdentity("First successor")
  resetIdentityStorageForTest(); const second = await bootstrapIdentity("Second successor")
  const base = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Partitioned", owner.identity.personId, "blank"))
  const column = Object.values(base.entities).find(entity => hasEntityKind(entity, "column"))!
  const write = async (profile: LocalProfile, title: string) => {
    const result = await executeCommand(base, { kind: "createItem", parentId: column.id, title }, profile)
    if (!result.ok) throw new Error(result.error.message)
    return result.value.newDoc
  }
  const [branchA, branchB] = await Promise.all([write(first, "A write"), write(second, "B write")])
  const merged = Automerge.merge(branchA, branchB)
  const heads = Automerge.getHeads(base)
  const transfers = await Promise.all([first, second].map(target => createWorkspaceOwnershipTransfer(owner, base.id, {
    personId: target.identity.personId, publicKey: target.identity.publicKey, certificates: [target.certificate],
  }, heads, 2)))
  peerStoreState.credential = {
    workspaceId: base.id, ownerPersonId: first.identity.personId, ownerPublicKey: first.identity.publicKey,
    ownerCertificates: [first.certificate], ownerHistory: [{ personId: owner.identity.personId,
      publicKey: owner.identity.publicKey, certificates: [owner.certificate] }], epoch: 2,
    catalog: { ownershipTransfers: transfers },
  }

  const titles = Object.values(merged.entities).filter(isItem).map(entity => entity.title)
  expect(titles).toEqual(expect.arrayContaining(["A write", "B write"]))
  await expect(validateIncomingChanges(branchA, merged, [])).rejects.toThrow(/conflicting ownership records/i)
})
