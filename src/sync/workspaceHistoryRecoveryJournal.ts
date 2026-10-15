import { z } from "zod"
import { BrowserMeshStore } from "@meta-uber/mesh-browser-store"
import { canonicalizeJson, sha256Base64Url, toBase64Url } from "../domain/identity"
import { openWorkspaceJournal, requestResult, transactionDone } from "../storageJournal"
import type { WorkspaceRecoveryJournal, WorkspaceRecoveryJournalRow, WorkspaceRecoveryStoreName } from "./workspaceHistoryRecoveryDecode"
import { WORKSPACE_RECOVERY_STORES } from "../workspaceRecoveryStores"

const PRIVATE_DATABASE = "tincanban-private-workspace-recovery-v1"
const PRIVATE_STORE = "records"
const STORE_NAMES: WorkspaceRecoveryStoreName[] = [...WORKSPACE_RECOVERY_STORES]
const encoder = new TextEncoder()
export type StoredWorkspaceRecoveryCopy = { kind: "workspace-recovery-copy" | "workspace-recovery-import"; version: 1; personId: string; workspaceId: string; recoveryId: string;
  digest: string; journal: WorkspaceRecoveryJournal }
type Activation = { kind: "workspace-recovery-activation"; version: 1; personId: string; workspaceId: string; recoveryId: string;
  copyKey: string; expectedRevision: string | null; baselineDigest: string; baselineFingerprint: string;
  historyProgressFingerprint: string;
  candidateDigest: string; candidateFingerprint: string; candidate: WorkspaceRecoveryJournal;
  importKey: string; importDigest: string; replace: boolean;
  revision: { id: string; workspaceId: string; revision: string; recoveryId: string }; status: "pending" | "completed" }
export type PendingWorkspaceRecoveryActivation = { version: 1; personId: string; workspaceId: string; recoveryId: string; status: "pending" }

function exactBinding(workspaceId: string, personId: string, recoveryId: string): void {
  if (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > 256 ||
      typeof personId !== "string" || !personId || personId.length > 512 ||
      typeof recoveryId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(recoveryId)) {
    throw new Error("Invalid workspace recovery journal binding")
  }
}

// Type tags make digest serialization distinguish byte arrays from ordinary objects,
// while preserving every JSON key as data (including prototype-special names).
function digestTree(value: unknown): unknown {
  if (value === undefined) return ["undefined"]
  if (value === null) return ["null"]
  if (typeof value === "string") return ["string", value]
  if (typeof value === "boolean") return ["boolean", value]
  if (typeof value === "number" && Number.isFinite(value)) return ["number", value]
  if (value instanceof Uint8Array) return ["uint8array", value.length, toBase64Url(value)]
  if (Array.isArray(value)) return ["array", value.map(digestTree)]
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return ["object", Object.keys(value).sort().map(key => [key, digestTree((value as Record<string, unknown>)[key])])]
  }
  throw new Error("Workspace recovery journal contains an unsupported value")
}
async function digest(value: unknown): Promise<string> { return sha256Base64Url(encoder.encode(canonicalizeJson(digestTree(value)))) }
function privateStore() { return new BrowserMeshStore(PRIVATE_DATABASE, [PRIVATE_STORE]) }
async function bindingKey(kind: "copy" | "import" | "activation", personId: string, workspaceId: string, recoveryId: string): Promise<string> {
  const hash = await sha256Base64Url(encoder.encode(canonicalizeJson([kind, personId, workspaceId, recoveryId])))
  return `workspace-recovery.v1.${kind}.${hash}`
}
function assertJournalRow(row: WorkspaceRecoveryJournalRow, workspaceId: string): void {
      if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id ||
          !row.value || typeof row.value !== "object" || Array.isArray(row.value) ||
          (row.value as Record<string, unknown>).id !== row.id || (row.value as Record<string, unknown>).workspaceId !== workspaceId) {
        throw new Error("Recovered journal row belongs to another workspace")
      }
}

function captureJournal(input: WorkspaceRecoveryJournal, workspaceId: string, preserveRevision = false): WorkspaceRecoveryJournal {
  const journal = structuredClone(input)
  if (!journal || typeof journal !== "object" || Object.keys(journal).length !== STORE_NAMES.length ||
      STORE_NAMES.some(name => !Object.hasOwn(journal, name) || !Array.isArray(journal[name]))) {
    throw new Error("Invalid recovered workspace journal")
  }
  for (const store of STORE_NAMES) {
    for (const row of journal[store]) {
      assertJournalRow(row, workspaceId)
    }
    journal[store].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    if (new Set(journal[store].map(row => row.id)).size !== journal[store].length) throw new Error("Recovered journal contains duplicate row IDs")
  }
  if (journal.snapshots.length !== 1 || journal.snapshots[0]!.id !== workspaceId) {
    throw new Error("Recovered workspace must contain exactly one snapshot")
  }
  if (journal.revisions.some(row => row.id !== workspaceId)) throw new Error("Recovered revision row has an invalid workspace key")
  // Revisions are local CAS metadata. Never import a stale revision from the backup.
  if (!preserveRevision) journal.revisions = []
  return journal
}
function rowsFromValues(values: unknown[]): WorkspaceRecoveryJournalRow[] {
  return values.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>).id !== "string") {
      throw new Error("Stored workspace journal row is malformed")
    }
    return { id: (value as Record<string, unknown>).id as string, value }
  })
}
function journalFromRows(rows: Record<WorkspaceRecoveryStoreName, unknown[]>): WorkspaceRecoveryJournal {
  return Object.fromEntries(STORE_NAMES.map(name => [name, rowsFromValues(rows[name]).sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0)])) as WorkspaceRecoveryJournal
}
async function readCurrentJournal(database: IDBDatabase, workspaceId: string): Promise<{ journal: WorkspaceRecoveryJournal; revision: unknown; historyProgress: unknown }> {
  const tx = database.transaction([...STORE_NAMES, "historyProgress"], "readonly"), done = transactionDone(tx)
  const values = Object.fromEntries(STORE_NAMES.map(name => [name,
    requestResult(tx.objectStore(name).index("workspaceId").getAll(workspaceId)) as Promise<unknown[]>])) as Record<WorkspaceRecoveryStoreName, Promise<unknown[]>>
  const [resolved, revision, historyProgress] = await Promise.all([
    Promise.all(STORE_NAMES.map(async name => [name, await values[name]] as const)).then(entries => Object.fromEntries(entries) as Record<WorkspaceRecoveryStoreName, unknown[]>),
    requestResult<unknown>(tx.objectStore("revisions").get(workspaceId)),
    requestResult<unknown>(tx.objectStore("historyProgress").get(workspaceId)),
  ])
  await done
  return { journal: journalFromRows(resolved), revision, historyProgress }
}
function requireNoHistoryTransition(value: unknown, workspaceId: string): void {
  if (value === undefined) return
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (value as Record<string, unknown>).id !== workspaceId || (value as Record<string, unknown>).workspaceId !== workspaceId) {
    throw new Error("Stored history progress is malformed; preserve this device's history before recovery")
  }
  if ((value as Record<string, unknown>).transitionId !== undefined) {
    throw new Error("Finish the pending history transition before restoring this workspace")
  }
}
async function putImmutable(store: BrowserMeshStore, key: string, record: StoredWorkspaceRecoveryCopy | Activation,
  contentDigest: string, ensureCurrent: () => void): Promise<void> {
  await store.updateRecords(PRIVATE_STORE, [key], values => {
    ensureCurrent()
    const current = values[0] as StoredWorkspaceRecoveryCopy | Activation | undefined
    if (current === undefined) return { writes: [{ key, value: { ...record, digest: contentDigest } }], result: undefined }
    if ((current as { digest?: string }).digest !== contentDigest) throw new Error("Workspace recovery record ID already has different contents")
    return { writes: [], result: undefined }
  })
}
function captureCopy(value: unknown, personId: string, workspaceId: string, recoveryId: string,
  kind: StoredWorkspaceRecoveryCopy["kind"] = "workspace-recovery-copy"): StoredWorkspaceRecoveryCopy {
  const copy = structuredClone(value) as StoredWorkspaceRecoveryCopy
  if (!copy || copy.kind !== kind || copy.version !== 1 || copy.personId !== personId ||
      copy.workspaceId !== workspaceId || copy.recoveryId !== recoveryId || !copy.journal || typeof copy.digest !== "string") {
    throw new Error("Stored workspace recovery copy is malformed")
  }
  return copy
}
const activationSchema = z.object({
  kind: z.literal("workspace-recovery-activation"), version: z.literal(1), personId: z.string(), workspaceId: z.string(), recoveryId: z.string(),
  candidate: z.unknown().refine(Boolean), candidateDigest: z.string(), baselineDigest: z.string(),
  candidateFingerprint: z.string(), baselineFingerprint: z.string(), historyProgressFingerprint: z.string(),
  importKey: z.string(), importDigest: z.string(), replace: z.boolean(), expectedRevision: z.union([z.null(), z.string()]),
  revision: z.object({ recoveryId: z.string() }), status: z.enum(["pending", "completed"]),
})
function captureActivation(value: unknown, personId: string, workspaceId: string, recoveryId: string): Activation {
  const activation = structuredClone(value) as Activation
  const parsed = activationSchema.safeParse(activation)
  if (!parsed.success || activation.personId !== personId || activation.workspaceId !== workspaceId ||
      activation.recoveryId !== recoveryId || activation.revision.recoveryId !== recoveryId) {
    throw new Error("Stored workspace recovery activation is malformed")
  }
  return activation
}

function shouldActivateRecovery(current: WorkspaceRecoveryJournal, revision: Record<string, unknown> | undefined,
  historyProgress: unknown, workspaceId: string, activation: Activation): boolean {
  if (revision?.recoveryId === activation.recoveryId) {
    current.revisions = []
    if (canonicalizeJson(revision) !== canonicalizeJson(activation.revision) || canonicalizeJson(digestTree(current)) !== activation.candidateFingerprint) {
      throw new Error("Recovered workspace candidate changed")
    }
    return false
  }
  if ((revision === undefined ? null : canonicalizeJson(revision)) !== activation.expectedRevision) throw new Error("Workspace revision changed during recovery activation")
  if (canonicalizeJson(digestTree(current)) !== activation.baselineFingerprint) throw new Error("Workspace journal changed during recovery activation")
  requireNoHistoryTransition(historyProgress, workspaceId)
  if (canonicalizeJson(digestTree(historyProgress)) !== activation.historyProgressFingerprint) throw new Error("Workspace history progress changed during recovery activation")
  if (current.snapshots.some(row => row.id === workspaceId) && !activation.replace) throw new Error("Workspace already exists; explicit replacement is required")
  return true
}

async function activateRecoveryJournal(database: IDBDatabase, workspaceId: string, activation: Activation,
  candidate: WorkspaceRecoveryJournal, ensureCurrent: () => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction([...STORE_NAMES, "historyProgress"], "readwrite")
    const requests = STORE_NAMES.map(name => [name, tx.objectStore(name).index("workspaceId").getAll(workspaceId)] as const)
    const progressRequest = tx.objectStore("historyProgress").get(workspaceId)
    let historyProgress: unknown
    let pending = requests.length + 1
    let failed: unknown
    const values = new Map<WorkspaceRecoveryStoreName, unknown[]>()
    const abort = (error: unknown) => { failed = error; try { tx.abort() } catch { reject(error) } }
    const commit = () => {
      try {
        ensureCurrent()
        const current = journalFromRows(Object.fromEntries(STORE_NAMES.map(name => [name, values.get(name)!])) as Record<WorkspaceRecoveryStoreName, unknown[]>)
        const revision = values.get("revisions")!.find(row => (row as Record<string, unknown>).id === workspaceId) as Record<string, unknown> | undefined
        if (!shouldActivateRecovery(current, revision, historyProgress, workspaceId, activation)) return
        for (const [name, rows] of values) {
          const target = tx.objectStore(name)
          for (const row of rows) target.delete((row as Record<string, unknown>).id as IDBValidKey)
        }
        for (const name of STORE_NAMES) {
          const rows = name === "revisions" ? [{ id: workspaceId, value: activation.revision }] : candidate[name]
          for (const row of rows) tx.objectStore(name).put(row.value)
        }
        // Progress is local optimization metadata, not backup content. Force a
        // one-time conservative re-evaluation against the imported snapshot.
        tx.objectStore("historyProgress").delete(workspaceId)
      } catch (error) { abort(error) }
    }
    for (const [name, request] of requests) {
      request.onsuccess = () => {
        values.set(name, request.result as unknown[])
        pending -= 1
        if (pending === 0) commit()
      }
      request.onerror = () => abort(request.error ?? new Error("Workspace recovery activation read failed"))
    }
    progressRequest.onsuccess = () => {
      historyProgress = progressRequest.result
      pending -= 1
      if (pending === 0) commit()
    }
    progressRequest.onerror = () => abort(progressRequest.error ?? new Error("Workspace history progress read failed"))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(failed ?? tx.error ?? new Error("Workspace recovery activation failed"))
    tx.onabort = () => reject(failed ?? tx.error ?? new Error("Workspace recovery activation aborted"))
  })
}

type RecoveryInitial = Awaited<ReturnType<typeof readCurrentJournal>>
type ExpectedActivation = Omit<Activation, "revision" | "status">

function resumeRecoveryActivation(value: unknown, expected: ExpectedActivation, initial: RecoveryInitial): Activation {
  const activation = captureActivation(value, expected.personId, expected.workspaceId, expected.recoveryId)
    if (activation.candidateDigest !== expected.candidateDigest || activation.candidateFingerprint !== expected.candidateFingerprint ||
        activation.importDigest !== expected.importDigest || activation.importKey !== expected.importKey || activation.expectedRevision !== expected.expectedRevision ||
        activation.replace !== expected.replace ||
        activation.copyKey !== expected.copyKey || canonicalizeJson(digestTree(activation.candidate)) !== expected.candidateFingerprint) {
      throw new Error("Workspace recovery retry does not match the pending activation")
    }
    // An already-applied exact retry performs no target writes. A new transition
    // may legitimately start after that activation; never delete its progress.
    if (activation.status === "pending" && (initial.revision as Record<string, unknown> | undefined)?.recoveryId !== expected.recoveryId) {
      requireNoHistoryTransition(initial.historyProgress, expected.workspaceId)
    }
  return activation
}

async function preserveAndPrepareActivation(expected: ExpectedActivation, initial: RecoveryInitial, imported: WorkspaceRecoveryJournal,
  persistence: BrowserMeshStore, activationKey: string, ensureCurrent: () => void): Promise<Activation> {
  const { workspaceId, personId, recoveryId, replace, expectedRevision, copyKey, importKey, importDigest, candidateDigest } = expected
  const baselineCopyDigest = expected.baselineDigest
    requireNoHistoryTransition(initial.historyProgress, workspaceId)
    if (initial.journal.snapshots.some(row => row.id === workspaceId) && !replace) {
      throw new Error("Workspace already exists; explicit replacement is required")
    }
    if ((initial.revision === undefined ? null : canonicalizeJson(initial.revision)) !== expectedRevision) throw new Error("Workspace revision changed before recovery")
    const copy: StoredWorkspaceRecoveryCopy = { kind: "workspace-recovery-copy", version: 1, personId, workspaceId, recoveryId,
      digest: baselineCopyDigest, journal: initial.journal }
    await putImmutable(persistence, copyKey, copy, baselineCopyDigest, ensureCurrent)
    const importCopy: StoredWorkspaceRecoveryCopy = { kind: "workspace-recovery-import", version: 1, personId, workspaceId, recoveryId,
      digest: importDigest, journal: imported }
    await putImmutable(persistence, importKey, importCopy, importDigest, ensureCurrent)
    ensureCurrent()
    const activation: Activation = { ...expected, revision: { id: workspaceId, workspaceId, revision: crypto.randomUUID(), recoveryId }, status: "pending" }
    await putImmutable(persistence, activationKey, activation, candidateDigest, ensureCurrent)
    ensureCurrent()
    const saved = captureActivation(await persistence.get<unknown>(PRIVATE_STORE, activationKey), personId, workspaceId, recoveryId)
    if (saved.historyProgressFingerprint !== activation.historyProgressFingerprint || saved.baselineFingerprint !== activation.baselineFingerprint ||
        saved.candidateFingerprint !== activation.candidateFingerprint || saved.importDigest !== activation.importDigest ||
        saved.expectedRevision !== activation.expectedRevision || saved.replace !== activation.replace ||
        canonicalizeJson(saved.revision) !== canonicalizeJson(activation.revision)) {
      throw new Error("Workspace recovery activation changed while preserving its exact target boundary")
    }
    return saved
}

async function verifyPreservedRecoveryCopies(persistence: BrowserMeshStore, copyKey: string, importKey: string, activation: Activation): Promise<void> {
  const storedCopyValue = await persistence.get<unknown>(PRIVATE_STORE, copyKey)
  if (storedCopyValue === undefined) throw new Error("Workspace recovery preservation copy is missing")
  const storedCopy = captureCopy(storedCopyValue, activation.personId, activation.workspaceId, activation.recoveryId)
  if (storedCopy.digest !== activation.baselineDigest || await digest(storedCopy.journal) !== storedCopy.digest) {
    throw new Error("Workspace recovery preservation copy failed verification")
  }
  const storedImportValue = await persistence.get<unknown>(PRIVATE_STORE, importKey)
  if (storedImportValue === undefined) throw new Error("Workspace recovery import copy is missing")
  const storedImport = captureCopy(storedImportValue, activation.personId, activation.workspaceId, activation.recoveryId, "workspace-recovery-import")
  if (storedImport.digest !== activation.importDigest || await digest(storedImport.journal) !== storedImport.digest) {
    throw new Error("Workspace recovery import copy failed verification")
  }
}

/** Preserve old private rows, then atomically replace exactly one workspace journal under a revision and session guard. */
export async function restoreWorkspaceRecoveryJournal(workspaceId: string, journalRows: WorkspaceRecoveryJournal,
  options: { replace: boolean; ensureCurrent: () => void; expectedRevision: string | null; recoveryId: string; personId: string;
    sourceJournal?: WorkspaceRecoveryJournal }): Promise<void> {
  const { replace, ensureCurrent, expectedRevision, recoveryId, personId } = options
  exactBinding(workspaceId, personId, recoveryId)
  if (typeof replace !== "boolean" || typeof ensureCurrent !== "function" ||
      !(expectedRevision === null || typeof expectedRevision === "string")) throw new Error("Invalid workspace recovery activation options")
  const candidate = captureJournal(journalRows, workspaceId)
  const imported = captureJournal(options.sourceJournal ?? journalRows, workspaceId, true)
  const candidateDigest = await digest(candidate)
  const importDigest = await digest(imported)
  ensureCurrent()
  const database = await openWorkspaceJournal()
  const initial = await readCurrentJournal(database, workspaceId)
  ensureCurrent()
  const baselineCopyDigest = await digest(initial.journal)
  ensureCurrent()
  const baselineFingerprint = canonicalizeJson(digestTree(initial.journal))
  const historyProgressFingerprint = canonicalizeJson(digestTree(initial.historyProgress))
  const persistence = privateStore()
  const copyKey = await bindingKey("copy", personId, workspaceId, recoveryId)
  const importKey = await bindingKey("import", personId, workspaceId, recoveryId)
  const activationKey = await bindingKey("activation", personId, workspaceId, recoveryId)
  ensureCurrent()
  const existingActivationValue = await persistence.get<unknown>(PRIVATE_STORE, activationKey)
  ensureCurrent()
  const expected: Omit<Activation, "revision" | "status"> = { kind: "workspace-recovery-activation", version: 1,
    personId, workspaceId, recoveryId, copyKey, expectedRevision, baselineDigest: baselineCopyDigest, baselineFingerprint,
    historyProgressFingerprint, candidateDigest, candidateFingerprint: canonicalizeJson(digestTree(candidate)), candidate,
    importKey, importDigest, replace }
  const activation = existingActivationValue === undefined
    ? await preserveAndPrepareActivation(expected, initial, imported, persistence, activationKey, ensureCurrent)
    : resumeRecoveryActivation(existingActivationValue, expected, initial)
  await verifyPreservedRecoveryCopies(persistence, copyKey, importKey, activation)
  ensureCurrent()
  if (activation.status === "completed") {
    const actual = await readCurrentJournal(database, workspaceId)
    const revision = actual.revision as Record<string, unknown> | undefined
    actual.journal.revisions = []
    if (canonicalizeJson(revision) !== canonicalizeJson(activation.revision) || canonicalizeJson(digestTree(actual.journal)) !== activation.candidateFingerprint) {
      throw new Error("Completed workspace recovery candidate changed")
    }
    ensureCurrent()
    return
  }

  ensureCurrent()
  await activateRecoveryJournal(database, workspaceId, activation, candidate, ensureCurrent)
  const final = await readCurrentJournal(database, workspaceId)
  const finalRevision = final.revision as Record<string, unknown> | undefined
  final.journal.revisions = []
  const finalFingerprint = canonicalizeJson(digestTree(final.journal))
  if (canonicalizeJson(finalRevision) !== canonicalizeJson(activation.revision) || finalFingerprint !== activation.candidateFingerprint) {
    throw new Error("Workspace recovery activation did not persist exact candidate")
  }
  ensureCurrent()
  await persistence.updateRecords(PRIVATE_STORE, [activationKey], values => {
    ensureCurrent()
    const current = captureActivation(values[0], personId, workspaceId, recoveryId)
    if (current.candidateDigest !== activation.candidateDigest) throw new Error("Workspace recovery activation changed before completion")
    const completed = { ...current, status: "completed" as const }
    return { writes: [{ key: activationKey, value: completed }], result: undefined }
  })
}

/** Read detached preserved rows. Returned data carries no activation or authority. */
export async function readStoredWorkspaceRecoveryCopy(personId: string, workspaceId: string, recoveryId: string): Promise<StoredWorkspaceRecoveryCopy | undefined> {
  exactBinding(workspaceId, personId, recoveryId)
  const key = await bindingKey("copy", personId, workspaceId, recoveryId)
  const value = await privateStore().get<unknown>(PRIVATE_STORE, key)
  if (value === undefined) return undefined
  const copy = captureCopy(value, personId, workspaceId, recoveryId)
  if (await digest(copy.journal) !== copy.digest) throw new Error("Stored workspace recovery copy integrity check failed")
  return copy
}

/** Read detached full imported rows kept before the active journal is materialized. */
export async function readStoredWorkspaceRecoveryImport(personId: string, workspaceId: string, recoveryId: string): Promise<StoredWorkspaceRecoveryCopy | undefined> {
  exactBinding(workspaceId, personId, recoveryId)
  const key = await bindingKey("import", personId, workspaceId, recoveryId)
  const value = await privateStore().get<unknown>(PRIVATE_STORE, key)
  if (value === undefined) return undefined
  const copy = captureCopy(value, personId, workspaceId, recoveryId, "workspace-recovery-import")
  if (await digest(copy.journal) !== copy.digest) throw new Error("Stored workspace recovery import failed integrity check")
  return copy
}

/** Expose only retry state; recovery rows and candidate contents remain private. */
export async function readPendingWorkspaceRecoveryActivation(personId: string, workspaceId: string,
  recoveryId: string): Promise<PendingWorkspaceRecoveryActivation | undefined> {
  exactBinding(workspaceId, personId, recoveryId)
  const key = await bindingKey("activation", personId, workspaceId, recoveryId)
  const value = await privateStore().get<unknown>(PRIVATE_STORE, key)
  if (value === undefined) return undefined
  const activation = captureActivation(value, personId, workspaceId, recoveryId)
  return activation.status === "pending" ? { version: 1, personId, workspaceId, recoveryId, status: "pending" } : undefined
}
