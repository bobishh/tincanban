import { hasEntityKind } from "./domain/model"
import { defaultStorage } from "./storage"
import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { initializeAutomerge } from "./crdt"
import { setStorageFailureHookForTest, WorkspaceStorage } from "./storage"
import { bootstrapIdentity, resetIdentityStorageForTest, signEnvelope } from "./domain/identity"
import { useTincanban, hydrate, reconcile, resetStateForTest } from "./state"
import { persistAuthorizedCommand, refreshAvailableWorkspaces, reviewCausalChange } from "./statePersistence"
import * as Automerge from "@automerge/automerge/slim"
import { createWorkspaceDoc } from "./domain/seeds"
import { projectBoardSchema } from "./domain/schema"
import { isItem } from "./domain/model"
import { authorizeLocalChanges, exportAuthorizationBundle, exportAuthorizations, prepareLocalChangeAuthorizations, recordGenesisAuthority } from "./sync/changeAuthorization"
import { executeCommand } from "./domain/commands"
import { peerStore } from "./sync/peerStore"
import * as causalAdmission from "./stateCausalAdmission"
import * as changeAuthorization from "./sync/changeAuthorization"
import { createSyncActions } from "./stateSyncActions"
import { certHashDefault, createDelegatedCertificate, defaultProofStore } from "./domain/proofs"
import { publicKeyId, toBase64Url } from "./domain/identity"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { withWorkspaceMutation } from "./workspaceMutation"
import type { WorkspaceChangeAuthorization } from "./sync/workspaceChangeProofStore"

vi.mock("@automerge/automerge/slim", async () => {
  const actual = await vi.importActual<typeof Automerge>("@automerge/automerge/slim")
  return { ...actual, getChangesMetaSince: vi.fn(actual.getChangesMetaSince), save: vi.fn(actual.save) }
})

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("Repository-backed state and projections (Requirement 1.8)", () => {
  beforeEach(async () => {
    setStorageFailureHookForTest(false)
    for (const workspace of [...await defaultStorage.listWorkspaces(), ...await defaultStorage.listArchivedWorkspaces()]) await defaultStorage.purgeWorkspaceForTest(workspace.id)
    resetIdentityStorageForTest()
    setStorageFailureHookForTest(false)
    resetStateForTest()
    await bootstrapIdentity("State Test User")
    await hydrate()
    await useTincanban().createWorkspaceAsync("Job search", "job-search")
  })

  it("Given a tab behind a verified local delta, When reclassification reuses the durable frontier, Then its active view catches up without publishing another shared change", async () => {
    const app = useTincanban()
    await app.createLeadAsync({ company: "Before catch-up", role: "Engineer", status: "lead" })
    const base = app.getActiveDoc()!
    const profile = app.getCurrentProfile()!
    const other = new WorkspaceStorage()
    await persistAuthorizedCommand(base, { kind: "renameWorkspace", title: "Other tab title" }, profile, other)
    expect(app.getActiveDoc()!.title).not.toBe("Other tab title")
    const publish = vi.fn()
    const unsubscribe = app.subscribeLocalChanges(publish)
    try {
      await createSyncActions().reclassifyWorkspace(base.id, other)
      expect(app.getActiveDoc()!.title).toBe("Other tab title")
      expect(publish).not.toHaveBeenCalled()
    } finally { unsubscribe() }
  })

  it("Given reconciliation holds an older read, When a workspace write is queued, Then publication finishes before that writer enters the shared mutation boundary", async () => {
    const app = useTincanban()
    const id = app.activeWorkspace.id
    let readStarted!: () => void, releaseRead!: () => void
    const started = new Promise<void>(resolve => { readStarted = resolve })
    const gate = new Promise<void>(resolve => { releaseRead = resolve })
    const original = defaultStorage.loadWorkspaceDoc.bind(defaultStorage)
    const read = vi.spyOn(defaultStorage, "loadWorkspaceDoc").mockImplementationOnce(async (...args) => {
      const loaded = await original(...args)
      readStarted()
      await gate
      return loaded
    })
    const reconciliation = reconcile(defaultStorage, true, id)
    await started
    let entered = false
    const writer = withWorkspaceMutation(id, async () => { entered = true })
    try {
      await new Promise<void>(resolve => queueMicrotask(() => queueMicrotask(resolve)))
      expect(entered).toBe(false)
    } finally {
      releaseRead()
      await Promise.all([reconciliation, writer])
      read.mockRestore()
    }
    expect(entered).toBe(true)
  })

  it("Given a large admitted board warmed for local edits, When Archive and Applied alternate, Then writes serialize and hash only new changes and preserve the final stage after reload", async () => {
    const app = useTincanban()
    await app.createLeadAsync({ company: "Delta writes", role: "Engineer", status: "lead" })
    const doc = app.getActiveDoc()!
    const item = Object.values(doc.entities).find(isItem)!
    const applied = Object.values(doc.entities).find(entity => entity.kind === "column" && entity.title === "Applied")!
    await app.executeCommandAsync({ kind: "patchItem", entityId: item.id,
      body: Array.from({ length: 1200 }, () => `Detailed requirement ${crypto.randomUUID()}`).join("\n") })
    await app.executeCommandAsync({ kind: "setEntityArchived", entityId: item.id, archived: true })
    await app.executeCommandAsync({ kind: "restoreAndMove", entityId: item.id, parentId: applied.id, beforeId: null })
    const history = (await defaultStorage.loadCausalEvidence(doc.id))!.bytes
    const save = vi.mocked(Automerge.save)
    save.mockClear()
    const bundles = vi.spyOn(changeAuthorization, "exportDocumentAuthorizationBundle")
    const digest = vi.spyOn(crypto.subtle, "digest")
    const access = vi.spyOn(meshRustRuntime().state, "decideWorkspaceAccess")
    try {
      for (let index = 0; index < 3; index++) {
        await app.executeCommandAsync({ kind: "setEntityArchived", entityId: item.id, archived: true })
        await app.executeCommandAsync({ kind: "restoreAndMove", entityId: item.id, parentId: applied.id, beforeId: null })
      }
      expect(access).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      expect(bundles).not.toHaveBeenCalled()
      expect(digest.mock.calls.some(([, bytes]) => {
        const input = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        return input.length === history.length && input.every((byte, index) => byte === history[index])
      })).toBe(false)
      resetStateForTest()
      await hydrate()
      expect(app.getActiveDoc()!.entities[item.id]!.placement.parentId).toBe(applied.id)
      expect(app.getActiveDoc()!.entities[item.id]!.archivedAt ?? null).toBeNull()
    } finally { bundles.mockRestore(); digest.mockRestore(); access.mockRestore(); save.mockClear() }
  })

  it("Given an atomically admitted saved board, When startup reads unchanged history and authority, Then it reuses the saved projection without replay or workspace writes", async () => {
    const app = useTincanban()
    await app.createLeadAsync({ company: "Admitted once", role: "Engineer", status: "lead" })
    const admission = vi.spyOn(changeAuthorization, "evaluateIncomingWorkspaceAdmission")
    const commit = vi.spyOn(defaultStorage, "commitWorkspace")
    resetStateForTest()
    try {
      await hydrate()
      expect(app.ready.value).toBe(true)
      expect(app.workspace.leads.map(lead => lead.company)).toContain("Admitted once")
      expect(admission).not.toHaveBeenCalled()
      expect(commit).not.toHaveBeenCalled()
    } finally { admission.mockRestore(); commit.mockRestore() }
  })

  it("Given admitted history and unchanged rights, When archiving then restoring a card, Then only the local commands are checked and both durable checkpoints survive reload", async () => {
    const app = useTincanban()
    await app.createLeadAsync({ company: "Incremental save", role: "Engineer", status: "lead" })
    const item = Object.values(app.getActiveDoc()!.entities).find(isItem)!
    const admission = vi.spyOn(changeAuthorization, "evaluateIncomingWorkspaceAdmission")
    const history = vi.mocked(Automerge.getChangesMetaSince)
    history.mockClear()
    try {
      await app.executeCommandAsync({ kind: "setEntityArchived", entityId: item.id, archived: true })
      await app.executeCommandAsync({ kind: "restoreAndMove", entityId: item.id, parentId: item.placement.parentId!, beforeId: null })
      expect(admission).not.toHaveBeenCalled()
      expect(history.mock.calls.some(([, heads]) => heads.length === 0)).toBe(false)
      const evidence = (await defaultStorage.loadCausalEvidence(app.activeWorkspace.id))!
      expect(evidence.decisions.every(decision => decision.status.type === "admitted")).toBe(true)
      expect(evidence.admissionCheckpoint?.projectionHeads).toEqual(Automerge.getHeads(app.getActiveDoc()!).sort())
      resetStateForTest()
      await hydrate()
      expect(admission).not.toHaveBeenCalled()
      expect(app.workspace.leads.map(lead => lead.company)).toContain("Incremental save")
    } finally { admission.mockRestore(); history.mockClear() }
  })

  it("Given an owner with two device certificates, When Archive and Applied alternate repeatedly, Then every save extends admission without replaying history", async () => {
    const app = useTincanban()
    await app.createLeadAsync({ company: "Repeat transitions", role: "Engineer", status: "lead" })
    const profile = await bootstrapIdentity()
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair
    const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)))
    const second = await createDelegatedCertificate(profile.privateKeys.devicePrivateKey, profile.device.deviceId,
      profile.identity.personId, await publicKeyId(publicKey), publicKey, await certHashDefault(profile.certificate))
    const certificates = [profile.certificate, second].sort((a, b) => b.signature.localeCompare(a.signature))
    const pool = vi.spyOn(defaultProofStore, "listCertificates").mockResolvedValue(certificates)
    await causalAdmission.reclassifyStoredWorkspace(app.activeWorkspace.id)
    const admission = vi.spyOn(changeAuthorization, "evaluateIncomingWorkspaceAdmission")
    const doc = app.getActiveDoc()!
    const item = Object.values(doc.entities).find(isItem)!
    const applied = Object.values(doc.entities).find(entity => entity.kind === "column" && entity.title === "Applied")!
    try {
      for (let i = 0; i < 3; i++) {
        await app.executeCommandAsync({ kind: "setEntityArchived", entityId: item.id, archived: true })
        expect(admission).not.toHaveBeenCalled()
        await app.executeCommandAsync({ kind: "restoreAndMove", entityId: item.id, parentId: applied.id, beforeId: null })
        expect(admission).not.toHaveBeenCalled()
      }
      resetStateForTest()
      await hydrate()
      expect(admission).not.toHaveBeenCalled()
      expect(app.getActiveDoc()!.entities[item.id]!.placement.parentId).toBe(applied.id)
    } finally { pool.mockRestore(); admission.mockRestore() }
  })

  it.each(["missing", "policy", "raw", "decisions", "pending"])("Given %s admission evidence, When a local card is archived, Then complete admission runs before saving", async changed => {
    const app = useTincanban()
    await app.createLeadAsync({ company: "Fallback save", role: "Engineer", status: "lead" })
    const doc = app.getActiveDoc()!
    const item = Object.values(doc.entities).find(isItem)!
    const evidence = (await defaultStorage.loadCausalEvidence(doc.id))!
    if (changed === "missing") delete evidence.admissionCheckpoint
    if (changed === "policy") evidence.admissionCheckpoint!.policy = "older-policy"
    if (changed === "decisions") evidence.decisions = []
    if (changed === "pending") evidence.decisions[0]!.status = { type: "pending", reason: "Recheck required" }
    if (changed === "raw") {
      const raw = Automerge.change(Automerge.clone(doc), draft => { draft.title = "Unverified replacement" })
      evidence.bytes = Automerge.save(raw)
      Automerge.free(raw)
    }
    await defaultStorage.commitWorkspace(doc.id, doc, Automerge.save(doc), [], undefined, evidence)
    const admission = vi.spyOn(changeAuthorization, "evaluateIncomingWorkspaceAdmission")
    try {
      await app.executeCommandAsync({ kind: "setEntityArchived", entityId: item.id, archived: true })
      expect(admission).toHaveBeenCalledOnce()
      expect(JSON.parse((app.getActiveDoc()!.entities[item.id] as { lifecycle: string }).lifecycle).state).toBe("archived")
    } finally { admission.mockRestore() }
  })

  it("Given unchanged admitted data, When only the local admission checkpoint is renewed, Then it persists without publishing a shared change", async () => {
    const app = useTincanban()
    await app.createLeadAsync({ company: "Unchanged data", role: "Engineer", status: "lead" })
    const doc = app.getActiveDoc()!
    const evidence = (await defaultStorage.loadCausalEvidence(doc.id))!
    evidence.admissionCheckpoint!.policy = "previous-policy"
    await defaultStorage.commitWorkspace(doc.id, doc, Automerge.save(doc), [], undefined, evidence)
    const publish = vi.fn()
    const unsubscribe = app.subscribeLocalChanges(publish)
    try {
      await createSyncActions().reclassifyWorkspace(doc.id)
      expect((await defaultStorage.loadCausalEvidence(doc.id))!.admissionCheckpoint!.policy).not.toBe("previous-policy")
      expect(publish).not.toHaveBeenCalled()
      await app.createLeadAsync({ company: "Real change", role: "Engineer", status: "lead" })
      expect(publish).toHaveBeenCalledOnce()
    } finally { unsubscribe() }
  })

  it.each(["missing", "policy", "raw", "decisions"])("Given a saved board with %s admission evidence, When startup runs, Then history is checked again before editing", async changed => {
    const app = useTincanban()
    await app.createLeadAsync({ company: "Kept admitted", role: "Engineer", status: "lead" })
    const doc = app.getActiveDoc()!
    const evidence = (await defaultStorage.loadCausalEvidence(doc.id))!
    if (changed === "missing") delete evidence.admissionCheckpoint
    if (changed === "policy") evidence.admissionCheckpoint!.policy = "older-policy"
    if (changed === "decisions") evidence.decisions = []
    if (changed === "raw") {
      const raw = Automerge.change(Automerge.clone(doc), draft => { draft.title = "Unverified replacement" })
      evidence.bytes = Automerge.save(raw)
      Automerge.free(raw)
    }
    await defaultStorage.commitWorkspace(doc.id, doc, Automerge.save(doc), [], undefined, evidence)
    const admission = vi.spyOn(changeAuthorization, "evaluateIncomingWorkspaceAdmission")
    resetStateForTest()
    try {
      await hydrate()
      expect(admission).toHaveBeenCalledOnce()
      expect(app.ready.value).toBe(true)
      expect(app.activeWorkspace.title).toBe("Job search")
    } finally { admission.mockRestore() }
  })

  it.each([false, true])("Given a saved board, When reload history validation fails=%s, Then the saved projection appears before validation and command writes stay blocked", async fail => {
    const app = useTincanban()
    await app.createLeadAsync({ company: "Saved preview", role: "Engineer", status: "lead" })
    const original = causalAdmission.reclassifyStoredWorkspace
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const validation = vi.spyOn(causalAdmission, "reclassifyStoredWorkspace").mockImplementation(async (...args) => {
      await gate
      if (fail) throw new Error("History check failed")
      return original(...args)
    })
    resetStateForTest()
    const startup = hydrate().then(() => undefined, error => error as Error)
    try {
      await vi.waitFor(() => expect(validation).toHaveBeenCalled())
      expect(app.workspace.leads.map(lead => lead.company)).toContain("Saved preview")
      expect(app.ready.value).toBe(false)
      await expect(app.executeCommandAsync({ kind: "renameWorkspace", title: "Changed during checks" })).rejects.toThrow(/still being checked/)
    } finally { finish(); validation.mockRestore() }
    const error = await startup
    expect(app.ready.value).toBe(!fail)
    if (fail) expect(error).toMatchObject({ message: "History check failed" })
    expect(app.workspace.leads.map(lead => lead.company)).toContain("Saved preview")
  })

  it("rejects an invalid configured workspace before durable or active-state changes", async () => {
    const tincanban = useTincanban()
    const activeId = tincanban.activeWorkspace.id
    const beforeWorkspaceIds = tincanban.availableWorkspaces.value.map(workspace => workspace.id)
    const activeDoc = tincanban.getActiveDoc()!
    const board = Object.values(activeDoc.entities).find(entity => entity.kind === "board")!
    const draft = {
      ...projectBoardSchema(activeDoc, board.id),
      presetBindings: { ...(board.preset?.bindings ?? {}) },
      fields: [{ title: "  ", valueType: "text" as const, required: false }],
    }
    const saveSnapshot = vi.spyOn(defaultStorage, "saveSnapshot")
    const registerWorkspace = vi.spyOn(defaultStorage, "registerWorkspace")

    await expect(tincanban.createWorkspaceAsync("Invalid config", "job-search", defaultStorage, draft)).rejects.toThrow(/field title/i)

    expect(saveSnapshot).not.toHaveBeenCalled()
    expect(registerWorkspace).not.toHaveBeenCalled()
    expect(tincanban.activeWorkspace.id).toBe(activeId)
    expect(tincanban.availableWorkspaces.value.map(workspace => workspace.id)).toEqual(beforeWorkspaceIds)
    saveSnapshot.mockRestore()
    registerWorkspace.mockRestore()
  })

  it("Given a format 2 owner board, when tincanban starts, then migration is signed and durable", async () => {
    const profile = useTincanban().getCurrentProfile()!
    const old = createWorkspaceDoc(crypto.randomUUID(), "Earlier board", profile.identity.personId, "blank") as unknown as Record<string, any>
    old.formatVersion = 2
    old.deleted = false
    delete old.archivedAt
    for (const entity of Object.values(old.entities) as Array<Record<string, any>>) {
      entity.deleted = entity.kind === "column" && entity.title === "Done"
      delete entity.archivedAt
      if (entity.kind === "column") entity.displayHint = "normal"
    }
    const source = Automerge.from(old)
    await recordGenesisAuthority(source as never, profile)
    await defaultStorage.saveSnapshot(old.id, source as never, Automerge.save(source))
    await defaultStorage.registerWorkspace(old.id, old.title)
    resetStateForTest()
    await hydrate()
    const stored = (await defaultStorage.loadWorkspaceDoc(old.id))!.doc
    const hashes = Automerge.getAllChanges(stored).map(change => Automerge.decodeChange(change).hash)
    const signed = (await exportAuthorizations(Automerge.save(stored))).flatMap(record => record.signed.payload.hashes)
    expect(stored.formatVersion).toBe(3)
    expect(signed).toContain(hashes.at(-1))
    expect(Object.values(stored.entities).find(entity => entity.kind === "column" && entity.title === "Done")?.archivedAt).toBeTruthy()
  })

  it("notifies subscribers only after durable commit succeeds", async () => {
    const tincanban = useTincanban()
    let changedWorkspaceId: string | undefined

    const unsubscribe = tincanban.subscribeLocalChanges(workspaceId => {
      changedWorkspaceId = workspaceId
    })

    const lead = await tincanban.createLeadAsync({
      company: "Stripe",
      role: "Backend Engineer",
      status: "lead",
      priority: "p0",
    })

    expect(lead).toBeDefined()
    expect(changedWorkspaceId).toBe(tincanban.activeWorkspace.id)
    expect(tincanban.workspace.leads.some((l) => l.company === "Stripe")).toBe(true)

    unsubscribe()
  })

  it("Given two commands start together, when they commit to one workspace, then UI and reopened storage retain both", async () => {
    const tincanban = useTincanban()
    const workspaceId = tincanban.activeWorkspace.id

    await Promise.all([
      tincanban.createLeadAsync({ company: "Concurrent A", role: "Engineer", status: "lead" }),
      tincanban.createLeadAsync({ company: "Concurrent B", role: "Engineer", status: "lead" }),
    ])

    expect(tincanban.workspace.leads.map(lead => lead.company)).toEqual(expect.arrayContaining(["Concurrent A", "Concurrent B"]))
    const reopened = await new WorkspaceStorage({ changes: new Map(), proofs: new Map(), receipts: new Map(),
      snapshots: new Map(), workspaces: new Map(), personalRoots: new Map() }).loadWorkspaceDoc(workspaceId)
    const titles = Object.values(reopened!.doc.entities)
      .filter(isItem)
      .map(entity => entity.title)
    expect(titles).toEqual(expect.arrayContaining(["Concurrent A — Engineer", "Concurrent B — Engineer"]))
  })

  it("Given two accepted peer branches, when merges overlap, then reopened storage retains both", async () => {
    const tincanban = useTincanban()
    const base = tincanban.getActiveDoc()!
    const profile = tincanban.getCurrentProfile()!
    const board = Object.values(base.entities).find(entity => entity.kind === "board")!
    const column = Object.values(base.entities).find(entity => entity.kind === "column" && entity.placement.parentId === board.id && entity.id !== board.archiveColumnId && !entity.archivedAt)!
    const branches = await Promise.all(["Peer A", "Peer B"].map(async title => {
      const result = await executeCommand(Automerge.clone(base), { kind: "createItem", parentId: column.id, title }, profile)
      if (!result.ok) throw new Error(result.error.message)
      await authorizeLocalChanges(result.value.newDoc, profile, [result.value.receipt.changeHash])
      const bytes = Automerge.save(result.value.newDoc)
      return { bytes, authorization: await exportAuthorizationBundle(bytes, profile) }
    }))
    await Promise.all(branches.map(branch => tincanban.mergeAuthorizedWorkspace(base.id, branch.bytes, branch.authorization)))
    const reopened = await new WorkspaceStorage().loadWorkspaceDoc(base.id)
    expect(Object.values(reopened!.doc.entities).filter(isItem).map(item => item.title)).toEqual(expect.arrayContaining(["Peer A", "Peer B"]))
  })

  it("Given a committed detailed peer packet, When identical fresh packet objects repeat, Then validation reuses the committed result without serialization, evidence loading or workspace writes", async () => {
    const app = useTincanban()
    await app.createLeadAsync({ company: "Repeated packet", role: "Engineer", status: "lead", description: "Large source text. ".repeat(2000) })
    const doc = app.getActiveDoc()!, profile = app.getCurrentProfile()!
    const bytes = Automerge.save(doc)
    const authorization = await exportAuthorizationBundle(bytes, profile)
    await app.mergeAuthorizedWorkspace(doc.id, bytes, authorization)
    const admission = vi.spyOn(changeAuthorization, "evaluateIncomingWorkspaceAdmission")
    const evidence = vi.spyOn(defaultStorage, "loadCausalEvidence")
    const commit = vi.spyOn(defaultStorage, "commitWorkspace")
    const save = vi.mocked(Automerge.save)
    save.mockClear()
    try {
      for (let index = 0; index < 3; index++) await app.mergeAuthorizedWorkspace(doc.id, bytes.slice(), structuredClone(authorization))
      expect(admission).not.toHaveBeenCalled()
      expect(evidence).not.toHaveBeenCalled()
      expect(commit).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      expect(app.workspace.leads.map(lead => lead.company)).toContain("Repeated packet")
    } finally { admission.mockRestore(); evidence.mockRestore(); commit.mockRestore(); save.mockClear() }
  })

  it("Given a valid peer packet, When optional cache maintenance fails after commit, Then merging still succeeds and reopened storage retains the saved view", async () => {
    const app = useTincanban()
    await app.createLeadAsync({ company: "Cache maintenance failure", role: "Engineer", status: "lead" })
    const doc = app.getActiveDoc()!, profile = app.getCurrentProfile()!
    const bytes = Automerge.save(doc), bundle = await exportAuthorizationBundle(bytes, profile)
    const incomingReuse = await import("./stateIncomingReuse")
    const remember = vi.spyOn(incomingReuse, "rememberIncomingPacket").mockRejectedValueOnce(new Error("Optional cache unavailable"))
    try {
      await expect(app.mergeAuthorizedWorkspace(doc.id, bytes, bundle)).resolves.toBeUndefined()
      const reopened = (await new WorkspaceStorage().loadWorkspaceDoc(doc.id))!
      expect(Object.values(reopened.doc.entities).filter(isItem).map(item => item.title)).toContain("Cache maintenance failure — Engineer")
    } finally { remember.mockRestore() }
  })

  it("Given a fully verified cached packet, When a local delta advances history and the same peer packet repeats, Then the local edit remains and history is not replayed", async () => {
    const app = useTincanban()
    await app.createLeadAsync({ company: "Before local delta", role: "Engineer", status: "lead" })
    const doc = app.getActiveDoc()!, profile = app.getCurrentProfile()!
    const bytes = Automerge.save(doc), bundle = await exportAuthorizationBundle(bytes, profile)
    await app.mergeAuthorizedWorkspace(doc.id, bytes, bundle)
    await app.executeCommandAsync({ kind: "renameWorkspace", title: "After local delta" })
    const admission = vi.spyOn(changeAuthorization, "evaluateIncomingWorkspaceAdmission")
    try {
      await app.mergeAuthorizedWorkspace(doc.id, bytes.slice(), structuredClone(bundle))
      expect(admission).not.toHaveBeenCalled()
      expect(app.getActiveDoc()!.title).toBe("After local delta")
    } finally { admission.mockRestore() }
  })

  it("Given a cached peer packet, When a relevant signature changes, Then the packet is checked again and rejected without replacing the saved view", async () => {
    const app = useTincanban()
    await app.createLeadAsync({ company: "Signature guard", role: "Engineer", status: "lead" })
    const doc = app.getActiveDoc()!, profile = app.getCurrentProfile()!
    const bytes = Automerge.save(doc), bundle = await exportAuthorizationBundle(bytes, profile)
    await app.mergeAuthorizedWorkspace(doc.id, bytes, bundle)
    const altered = structuredClone(bundle)
    ;(altered.records[0] as WorkspaceChangeAuthorization).signed.signature += "forged"
    const admission = vi.spyOn(changeAuthorization, "evaluateIncomingWorkspaceAdmission")
    try {
      await expect(app.mergeAuthorizedWorkspace(doc.id, bytes, altered)).rejects.toThrow(/signature|authorization/i)
      expect(admission).toHaveBeenCalledOnce()
      expect(app.workspace.leads.map(lead => lead.company)).toContain("Signature guard")
    } finally { admission.mockRestore() }
  })

  it("Given a cached packet with a previously unknown forged proof, When its claimed hash enters local history, Then repeating the packet revalidates that newly relevant proof", async () => {
    const app = useTincanban()
    await app.createLeadAsync({ company: "Unknown hash guard", role: "Engineer", status: "lead" })
    const base = app.getActiveDoc()!, profile = app.getCurrentProfile()!
    const candidate = await executeCommand(base, { kind: "renameWorkspace", title: "Newly present hash" }, profile)
    if (!candidate.ok) throw new Error(candidate.error.message)
    const authorizations = await prepareLocalChangeAuthorizations(candidate.value.newDoc, profile, [candidate.value.receipt.changeHash])
    const bytes = Automerge.save(base), bundle = await exportAuthorizationBundle(bytes, profile)
    bundle.records.push({ ...authorizations[0]!, signed: { ...authorizations[0]!.signed, signature: "forged-unknown-proof" } })
    await app.mergeAuthorizedWorkspace(base.id, bytes, bundle)
    const raw = Automerge.save(candidate.value.newDoc)
    const previous = (await defaultStorage.loadCausalEvidence(base.id))!
    await defaultStorage.commitWorkspace(base.id, candidate.value.newDoc, raw, authorizations, undefined, {
      bytes: raw, decisions: [...previous.decisions, { hash: candidate.value.receipt.changeHash, status: { type: "admitted", role: "owner" } }],
      authorizationEvidence: [...previous.authorizationEvidence ?? [], ...authorizations],
    })
    const admission = vi.spyOn(changeAuthorization, "evaluateIncomingWorkspaceAdmission")
    try {
      await expect(app.mergeAuthorizedWorkspace(base.id, bytes, structuredClone(bundle))).rejects.toThrow(/signature|authorization/i)
      expect(admission).toHaveBeenCalledOnce()
    } finally { admission.mockRestore() }
  })

  it("Given a cached committed packet, When the caller mutates its old input, Then a fresh genuine copy still reuses the private committed packet", async () => {
    const app = useTincanban()
    await app.createLeadAsync({ company: "Private packet copy", role: "Engineer", status: "lead" })
    const doc = app.getActiveDoc()!, profile = app.getCurrentProfile()!
    const bytes = Automerge.save(doc), bundle = await exportAuthorizationBundle(bytes, profile)
    const genuine = { bytes: bytes.slice(), bundle: structuredClone(bundle) }
    await app.mergeAuthorizedWorkspace(doc.id, bytes, bundle)
    bytes[0]! ^= 1
    ;(bundle.records[0] as WorkspaceChangeAuthorization).signed.signature = "caller-mutation"
    const admission = vi.spyOn(changeAuthorization, "evaluateIncomingWorkspaceAdmission")
    try {
      await app.mergeAuthorizedWorkspace(doc.id, genuine.bytes, genuine.bundle)
      expect(admission).not.toHaveBeenCalled()
    } finally { admission.mockRestore() }
  })

  it("Given a signed proof for a hash absent from raw history, when its change later arrives with genuine proof, then unverified proof never persists or poisons replay", async () => {
    const tincanban = useTincanban()
    const base = tincanban.getActiveDoc()!
    const profile = tincanban.getCurrentProfile()!
    const board = Object.values(base.entities).find(entity => entity.kind === "board")!
    const column = Object.values(base.entities).find(entity => entity.kind === "column" && entity.placement.parentId === board.id && entity.id !== board.archiveColumnId && !entity.archivedAt)!
    const candidate = await executeCommand(Automerge.clone(base), { kind: "createItem", parentId: column.id, title: "Genuine later change" }, profile)
    if (!candidate.ok) throw new Error(candidate.error.message)
    const hash = candidate.value.receipt.changeHash
    const genuine = (await prepareLocalChangeAuthorizations(candidate.value.newDoc, profile, [hash]))[0]!
    const malformed = { ...genuine, signed: { ...genuine.signed, signature: `${genuine.signed.signature}forged` } }
    const absentBundle = await exportAuthorizationBundle(Automerge.save(base), profile)
    absentBundle.records = [...absentBundle.records, malformed]

    await tincanban.mergeAuthorizedWorkspace(base.id, Automerge.save(base), absentBundle)
    const afterAbsentProof = (await defaultStorage.loadCausalEvidence(base.id))!
    expect(afterAbsentProof.authorizationEvidence).not.toContainEqual(expect.objectContaining({ signed: expect.objectContaining({ signature: malformed.signed.signature }) }))

    const laterBundle = await exportAuthorizationBundle(Automerge.save(candidate.value.newDoc), profile)
    laterBundle.records = [...laterBundle.records, genuine]
    await tincanban.mergeAuthorizedWorkspace(base.id, Automerge.save(candidate.value.newDoc), laterBundle)
    expect(Object.values(tincanban.getActiveDoc()!.entities).filter(isItem).map(item => item.title)).toContain("Genuine later change")
  })

  it("Given local commit fails, when command is rejected, then no authorization or change leaks", async () => {
    const tincanban = useTincanban()
    const before = tincanban.getAutomergeBytes()
    const authorizations = await exportAuthorizations(before)
    setStorageFailureHookForTest(true)
    try {
      await expect(tincanban.createLeadAsync({ company: "Atomic rejection", role: "Engineer", status: "lead" })).rejects.toThrow(/Storage failure/)
    } finally { setStorageFailureHookForTest(false) }
    expect(await exportAuthorizations(before)).toEqual(authorizations)
    expect(Automerge.getHeads((await defaultStorage.loadWorkspaceDoc(tincanban.activeWorkspace.id))!.doc)).toEqual(Automerge.getHeads(tincanban.getActiveDoc()!))
  })

  it("does not notify replication or adopt change when save fails", async () => {
    const tincanban = useTincanban()
    let changeNotified = false

    const unsubscribe = tincanban.subscribeLocalChanges(() => {
      changeNotified = true
    })

    // Inject storage failure
    setStorageFailureHookForTest(true)

    await expect(
      tincanban.createLeadAsync({
        company: "Failed Corp",
        role: "Dev",
        status: "lead",
      })
    ).rejects.toThrow(/Storage failure/i)

    // Listener MUST NOT have been called!
    expect(changeNotified).toBe(false)

    // State MUST NOT contain the failed card!
    expect(tincanban.workspace.leads.some((l) => l.company === "Failed Corp")).toBe(false)

    unsubscribe()
  })

  it("rejects a local edit while an ownership transfer awaits confirmation", async () => {
    const tincanban = useTincanban()
    const workspaceId = tincanban.activeWorkspace.id
    const doc = tincanban.getActiveDoc()!
    const column = Object.values(doc.entities).find(entity => hasEntityKind(entity, "column"))
    if (!column) throw new Error("Test workspace has no column")
    vi.stubGlobal("indexedDB", {})
    vi.stubGlobal("navigator", { locks: { request: async (_name: string, operation: () => Promise<unknown>) => operation() } })
    const load = vi.spyOn(defaultStorage, "loadWorkspaceDoc").mockResolvedValue(null)
    const pending = vi.spyOn(peerStore, "getPendingOwnershipTransfer").mockResolvedValue({
      version: 1,
      workspaceId,
      transfer: {},
    })

    try {
      await expect(persistAuthorizedCommand(doc, {
        kind: "createItem",
        parentId: column.id,
        title: "Deferred edit",
      }, tincanban.getCurrentProfile()!, defaultStorage)).rejects.toThrow(
        "Ownership transfer is awaiting confirmation. Reconnect and retry the same recipient.",
      )
      expect(Object.values(tincanban.getActiveDoc()!.entities).filter(isItem)
        .some(entity => entity.title === "Deferred edit")).toBe(false)
    } finally {
      pending.mockRestore()
      load.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it("rejects review of a quarantined edit while ownership transfer awaits confirmation", async () => {
    const tincanban = useTincanban()
    const base = tincanban.getActiveDoc()!
    const workspaceId = base.id
    const profile = tincanban.getCurrentProfile()!
    const board = Object.values(base.entities).find(entity => entity.kind === "board")!
    const column = Object.values(base.entities).find(entity => entity.kind === "column" && entity.placement.parentId === board.id && entity.id !== board.archiveColumnId && !entity.archivedAt)!
    const candidate = await executeCommand(Automerge.clone(base), {
      kind: "createItem", parentId: column.id, title: "Quarantined review draft",
    }, profile)
    if (!candidate.ok) throw new Error(candidate.error.message)
    const hash = candidate.value.receipt.changeHash
    const bytes = Automerge.save(candidate.value.newDoc)
    await defaultStorage.commitWorkspace(workspaceId, base, Automerge.save(base), [], undefined, {
      bytes,
      decisions: [{ hash, status: { type: "quarantined", reason: "test draft" } }],
      authorizationEvidence: [],
    })
    const stored = await defaultStorage.loadWorkspaceDoc(workspaceId)
    const evidence = await defaultStorage.loadCausalEvidence(workspaceId)
    vi.stubGlobal("indexedDB", {})
    vi.stubGlobal("navigator", { locks: { request: async (_name: string, operation: () => Promise<unknown>) => operation() } })
    const loadWorkspace = vi.spyOn(defaultStorage, "loadWorkspaceDoc").mockResolvedValue(stored)
    const loadEvidence = vi.spyOn(defaultStorage, "loadCausalEvidence").mockResolvedValue(evidence)
    const pending = vi.spyOn(peerStore, "getPendingOwnershipTransfer").mockResolvedValue({
      version: 1,
      workspaceId,
      transfer: {},
    })

    try {
      await expect(reviewCausalChange(hash, defaultStorage)).rejects.toThrow(
        "Ownership transfer is awaiting confirmation. Reconnect and retry the same recipient.",
      )
      expect(Object.values(tincanban.getActiveDoc()!.entities).filter(isItem)
        .some(entity => entity.title === "Quarantined review draft")).toBe(false)
    } finally {
      pending.mockRestore()
      loadWorkspace.mockRestore()
      loadEvidence.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it("reconciles changes from BroadcastChannel without losing local state", async () => {
    const tincanban = useTincanban()
    expect(tincanban.ready.value).toBe(true)

    // Verify channel reconciliation hook exists
    expect(typeof tincanban.reconcile).toBe("function")
    await tincanban.reconcile()
    expect(tincanban.ready.value).toBe(true)
  })

  it("refreshes active and archived workspace lists with one catalog read", async () => {
    const listCatalog = vi.spyOn(defaultStorage, "listWorkspaceCatalog")

    await refreshAvailableWorkspaces(defaultStorage)

    expect(listCatalog).toHaveBeenCalledOnce()
    listCatalog.mockRestore()
  })

  it("notifies live mesh subscribers when another tab persists an inactive workspace during reconciliation", async () => {
    const tincanban = useTincanban()
    const activeWorkspaceId = tincanban.activeWorkspace.id
    const publish = vi.fn()
    const unsubscribe = tincanban.subscribeLocalChanges(publish)

    await Promise.all([
      reconcile(defaultStorage),
      reconcile(defaultStorage, true),
    ])

    expect(publish).toHaveBeenCalledOnce()
    expect(tincanban.activeWorkspace.id).toBe(activeWorkspaceId)
    unsubscribe()
  })

  it("rejects an unrelated same-ID workspace without changing local documents or identity", async () => {
    const tincanban = useTincanban()
    await tincanban.createLeadAsync({ company: "Local data", role: "Engineer", status: "lead" })
    const id = tincanban.getActiveDoc()!.id
    const unrelated = Automerge.from(createWorkspaceDoc(id, "Remote board", tincanban.getActiveDoc()!.ownerPersonId, "blank"))
    const bytes = Automerge.save(unrelated)
    await expect(tincanban.mergeAuthorizedWorkspace(id, bytes, await exportAuthorizationBundle(bytes, tincanban.getCurrentProfile()!))).rejects.toThrow("Workspace conflict")
    expect(tincanban.activeWorkspace.id).toBe(id)
    expect(tincanban.activeWorkspace.title).toBe("Job search")
    expect(tincanban.workspace.leads.some(lead => lead.company === "Local data")).toBe(true)
  })

  it("rejects a document addressed to another workspace without touching the active board", async () => {
    const tincanban = useTincanban()
    const before = tincanban.getAutomergeBytes()
    const remote = Automerge.from(createWorkspaceDoc("other", "Remote board", tincanban.getCurrentProfile()!.identity.personId, "blank"))
    const authorization = await exportAuthorizationBundle(Automerge.save(remote), tincanban.getCurrentProfile()!)
    await expect(tincanban.mergeAuthorizedWorkspace("selected", Automerge.save(remote), authorization)).rejects.toThrow(/Invalid workspace/)
    expect(tincanban.getAutomergeBytes()).toEqual(before)
  })

  it("does not allow a peer to replace the owner used to authorize chat", async () => {
    const tincanban = useTincanban()
    const before = tincanban.getActiveDoc()!
    const owner = before.ownerPersonId
    const forged = Automerge.change(Automerge.clone(before), draft => { draft.ownerPersonId = "attacker" })
    const changed = Automerge.getAllChanges(forged).map(change => Automerge.decodeChange(change).hash)
    const profile = tincanban.getCurrentProfile()!
    // A hostile remote can sign its own bytes; local authoring must not be used to mint this invalid root transition.
    const hostileProof = { signed: await signEnvelope(profile.privateKeys.devicePrivateKey, {
      kind: "workspace-changes" as const, version: 1 as const, workspaceId: before.id, hashes: changed,
      personId: profile.identity.personId, deviceId: profile.device.deviceId }, profile.device.deviceId),
    publicKey: profile.identity.publicKey, certificates: [profile.certificate], ownerPublicKey: profile.identity.publicKey,
    ownerCertificates: [profile.certificate] }
    const authorization = await exportAuthorizationBundle(Automerge.save(before), profile)
    authorization.records = [...await exportAuthorizations(Automerge.save(before)), hostileProof]
    await expect(tincanban.mergeAuthorizedWorkspace(before.id, Automerge.save(forged), authorization)).rejects.toThrow(/owner/i)
    expect(tincanban.getActiveDoc()!.ownerPersonId).toBe(owner)
  })

  it("keeps unsigned merge helpers private and rejects importing another owner's workspace", async () => {
    const tincanban = useTincanban()
    expect(tincanban).not.toHaveProperty("mergeRemoteBytes")
    expect(tincanban).not.toHaveProperty("mergeScopedWorkspaceBytes")
    const foreign = Automerge.from(createWorkspaceDoc("foreign", "Foreign", "another-person", "blank"))
    await expect(tincanban.importWorkspaceDocument(foreign)).rejects.toThrow(/owner/i)
    expect(tincanban.availableWorkspaces.value.some(workspace => workspace.id === "foreign")).toBe(false)
  })

  it("deletes the active workspace and opens a remaining workspace", async () => {
    const tincanban = useTincanban()
    const firstId = tincanban.activeWorkspace.id
    await tincanban.createWorkspaceAsync("Keep me", "blank")
    const secondId = tincanban.activeWorkspace.id
    await tincanban.archiveWorkspaceAsync(secondId)
    expect(tincanban.activeWorkspace.id).not.toBe(secondId)
    expect(tincanban.availableWorkspaces.value.some(workspace => workspace.id === firstId)).toBe(true)
    expect(tincanban.availableWorkspaces.value.some(workspace => workspace.id === tincanban.activeWorkspace.id)).toBe(true)
    expect(tincanban.availableWorkspaces.value.some(workspace => workspace.id === secondId)).toBe(false)
    expect((await new WorkspaceStorage().loadWorkspaceDoc(secondId))?.doc.archivedAt).toEqual(expect.any(String))
  })
})
