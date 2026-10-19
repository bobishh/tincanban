import * as Automerge from "@automerge/automerge/slim"
import { canonicalizeJson, sha256Base64Url, toBase64Url } from "./domain/identity"
import type { ChangeProof, TransactionReceipt } from "./domain/model"
import type { WorkspaceRole } from "./domain/permissions"
import { mergeAuthorizationRecords, type WorkspaceChangeAuthorization } from "./product-replica/workspaceAuthorizationRecords"
import type { WorkspaceDocumentV2 } from "./domain/model"
import { advanceWorkspaceRevision, advanceHistoryProgress, advanceLocalHistoryProgress, readLocalJournalReference, updateLocalJournal, requestResult, transactionDone,
  type StoredHistoryProgress, type StoredReceiptRecord, type StoredWorkspaceSnapshot } from "./storageJournalRecords"
import { readDeltaTail } from "./workspaceDeltaTail"

export type WorkspaceDeltaCommand = {
  receipt: TransactionReceipt
  changeBytes: Uint8Array
  proof: ChangeProof
  authorizations: WorkspaceChangeAuthorization[]
  role: WorkspaceRole
  title: string
  archivedAt: string | null
}

/** Local integrity metadata, never accepted from replication or import. */
export type WorkspaceDeltaFrontier = {
  id: string
  workspaceId: string
  generation: string
  revision: number
  basisHash: string
  basisHeads: string[]
  basisSavedAt: string
  authorityFingerprint: string
  policy: string
  heads: string[]
  chainHash: string
  title: string
  archivedAt: string | null
  savedAt: string
  invalidated?: boolean
}

export type StoredWorkspaceDelta = {
  id: string
  workspaceId: string
  generation: string
  sequence: number
  previousHash: string
  hash: string
  chainHash: string
  savedAt: string
  command: WorkspaceDeltaCommand
}

async function jsonHash(value: unknown) {
  return sha256Base64Url(new TextEncoder().encode(canonicalizeJson(value)))
}

function sameHeads(left: string[], right: string[]) {
  return [...left].sort().join() === [...right].sort().join()
}

async function basisHash(snapshot: StoredWorkspaceSnapshot) {
  const evidence = snapshot.causalEvidence
  return jsonHash({ workspaceId: snapshot.workspaceId, heads: [...snapshot.heads].sort(),
    title: snapshot.title, archivedAt: snapshot.archivedAt ?? null, savedAt: snapshot.savedAt,
    bytesHash: await sha256Base64Url(snapshot.bytes),
    evidence: evidence ? { ...evidence, bytes: await sha256Base64Url(evidence.bytes) } : null })
}

async function basisChainHash(frontier: WorkspaceDeltaFrontier) {
  return jsonHash({ generation: frontier.generation, basisHash: frontier.basisHash,
    authorityFingerprint: frontier.authorityFingerprint, policy: frontier.policy })
}

/** Caller has validated the basis checkpoint under these exact current rights. */
export async function createDeltaBasis(snapshot: StoredWorkspaceSnapshot, authorityFingerprint: string): Promise<WorkspaceDeltaFrontier> {
  const checkpoint = snapshot.causalEvidence?.admissionCheckpoint
  if (!checkpoint || snapshot.causalEvidence!.decisions.some(decision => decision.status.type !== "admitted") ||
    !sameHeads(snapshot.heads, checkpoint.projectionHeads)) throw new Error("Delta basis must be fully admitted")
  const hash = await basisHash(snapshot)
  const frontier = { id: snapshot.workspaceId, workspaceId: snapshot.workspaceId, generation: crypto.randomUUID(), revision: 0,
    basisHash: hash, basisHeads: [...snapshot.heads].sort(), basisSavedAt: snapshot.savedAt,
    authorityFingerprint, policy: checkpoint.policy, heads: [...snapshot.heads].sort(), chainHash: hash,
    title: snapshot.title, archivedAt: snapshot.archivedAt ?? null, savedAt: snapshot.savedAt }
  frontier.chainHash = await basisChainHash(frontier)
  return frontier
}

function assertCommand(frontier: WorkspaceDeltaFrontier, command: WorkspaceDeltaCommand) {
  const { receipt, proof } = command
  let decoded: ReturnType<typeof Automerge.decodeChange>
  try { decoded = Automerge.decodeChange(command.changeBytes) }
  catch (cause) { throw new Error("Delta change bytes are invalid", { cause }) }
  if (!receipt.saved || !receipt.transactionId || receipt.changeHash !== decoded.hash ||
    !sameHeads(receipt.beforeHeads, frontier.heads) || !sameHeads(decoded.deps, frontier.heads) ||
    !sameHeads(receipt.afterHeads, [decoded.hash]) || proof.payload.changeHash !== decoded.hash ||
    proof.payload.documentId !== frontier.workspaceId || !command.authorizations.length ||
    command.authorizations.some(record => record.signed.payload.workspaceId !== frontier.workspaceId ||
      !sameHeads(record.signed.payload.hashes, [decoded.hash]))) throw new Error("Delta command does not extend the admitted frontier")
}

async function deltaHash(delta: Omit<StoredWorkspaceDelta, "hash" | "chainHash">) {
  return jsonHash({ ...delta, command: { ...delta.command, changeBytes: await sha256Base64Url(delta.command.changeBytes) } })
}

/** Signature and transition validation precede this storage preparation. Hash only the new command. */
export async function prepareWorkspaceDelta(frontier: WorkspaceDeltaFrontier, command: WorkspaceDeltaCommand): Promise<StoredWorkspaceDelta> {
  assertCommand(frontier, command)
  if (!Number.isSafeInteger(frontier.revision) || frontier.revision < 0 || frontier.revision >= Number.MAX_SAFE_INTEGER)
    throw new Error("Delta frontier revision is invalid")
  const sequence = frontier.revision + 1
  const delta = { id: JSON.stringify([frontier.workspaceId, frontier.generation, sequence]),
    workspaceId: frontier.workspaceId, generation: frontier.generation, sequence,
    previousHash: frontier.chainHash, savedAt: new Date().toISOString(), command: structuredClone(command) }
  const hash = await deltaHash(delta)
  return { ...delta, hash, chainHash: await jsonHash([frontier.chainHash, hash]) }
}

function nextFrontier(frontier: WorkspaceDeltaFrontier, delta: StoredWorkspaceDelta): WorkspaceDeltaFrontier {
  return { ...frontier, revision: delta.sequence, heads: [...delta.command.receipt.afterHeads].sort(),
    chainHash: delta.chainHash, title: delta.command.title, archivedAt: delta.command.archivedAt, savedAt: delta.savedAt }
}

async function verifyDelta(frontier: WorkspaceDeltaFrontier, delta: StoredWorkspaceDelta) {
  if (delta.workspaceId !== frontier.workspaceId || delta.generation !== frontier.generation ||
    delta.sequence !== frontier.revision + 1 || delta.previousHash !== frontier.chainHash ||
    delta.id !== JSON.stringify([frontier.workspaceId, frontier.generation, delta.sequence])) throw new Error("Delta chain does not extend its frontier")
  assertCommand(frontier, delta.command)
  const { hash, chainHash, ...content } = delta
  if (hash !== await deltaHash(content) || chainHash !== await jsonHash([frontier.chainHash, hash]))
    throw new Error("Delta chain integrity check failed")
}

/** Storage only. The application remains responsible for current rights, signatures and transitions. */
export class WorkspaceDeltaJournal {
  constructor(private database?: IDBDatabase) {}

  async readFrontier(workspaceId: string): Promise<WorkspaceDeltaFrontier | undefined> {
    if (!this.database) return structuredClone(readLocalJournalReference(workspaceId).frontier)
    const transaction = this.database.transaction("frontiers", "readonly")
    const done = transactionDone(transaction)
    const frontier = await requestResult(transaction.objectStore("frontiers").get(workspaceId)) as WorkspaceDeltaFrontier | undefined
    await done
    return frontier
  }

  /** Verify only the tail after a previously checked local prefix, from one atomic read. */
  async readAfter(previous: WorkspaceDeltaFrontier): Promise<{ frontier: WorkspaceDeltaFrontier; deltas: StoredWorkspaceDelta[] } | undefined> {
    const tail = await readDeltaTail(this.database, previous)
    if (!tail) return
    const { frontier, deltas } = tail
    let checked = previous
    for (const delta of deltas) {
      await verifyDelta(checked, delta)
      checked = nextFrontier(checked, delta)
    }
    if (canonicalizeJson(checked) !== canonicalizeJson(frontier)) throw new Error("Delta tail does not reach the saved frontier")
    return { frontier, deltas }
  }


  async append(expected: WorkspaceDeltaFrontier, delta: StoredWorkspaceDelta, expectedRevision: string | null,
    ensureCurrent: () => void): Promise<WorkspaceDeltaFrontier> {
    // Crypto runs before opening the transaction; no async crypto can close an IDB transaction early.
    await verifyDelta(expected, delta)
    ensureCurrent()
    const next = nextFrontier(expected, delta)
    if (!this.database) return this.appendMemory(expected, delta, next, expectedRevision, ensureCurrent)
    return this.appendIndexedDb(this.database, expected, delta, next, expectedRevision, ensureCurrent)
  }

  private async appendIndexedDb(database: IDBDatabase, expected: WorkspaceDeltaFrontier, delta: StoredWorkspaceDelta, next: WorkspaceDeltaFrontier,
    expectedRevision: string | null, ensureCurrent: () => void): Promise<WorkspaceDeltaFrontier> {
    const transaction = database.transaction(["frontiers", "deltas", "changes", "proofs", "receipts", "revisions", "snapshots", "historyProgress"], "readwrite")
    const done = transactionDone(transaction)
    try {
      const frontiers = transaction.objectStore("frontiers")
      const current = await requestResult(frontiers.get(expected.workspaceId)) as WorkspaceDeltaFrontier | undefined
      const snapshot = await requestResult(transaction.objectStore("snapshots").get(expected.workspaceId)) as StoredWorkspaceSnapshot | undefined
      const revision = await requestResult(transaction.objectStore("revisions").get(expected.workspaceId)) as { revision: string } | undefined
      const progress = await requestResult(transaction.objectStore("historyProgress").get(expected.workspaceId)) as StoredHistoryProgress | undefined
      const deltas = transaction.objectStore("deltas")
      const receipts = transaction.objectStore("receipts")
      const { receipt, changeBytes, proof } = delta.command
      const receiptKey = `${expected.workspaceId}:${receipt.transactionId}`
      const existing = await requestResult(receipts.get(receiptKey)) as StoredReceiptRecord | undefined
      if (existing) return await returnExistingAppend(transaction, done, deltas, delta, current, existing, receipt.changeHash)
      assertAppendBasis(current, revision, expected, expectedRevision)
      ensureCurrent()
      const changeKey = `${expected.workspaceId}:${receipt.changeHash}`
      deltas.add(delta)
      frontiers.put(next)
      const progressBaselineId = snapshot?.receivedHistory?.baselineId ?? progress?.baselineId
      if (progressBaselineId !== undefined) {
        advanceHistoryProgress(transaction, expected.workspaceId, progressBaselineId,
          1, changeBytes.byteLength)
      }
      transaction.objectStore("changes").put({ id: changeKey, workspaceId: expected.workspaceId,
        changeHash: receipt.changeHash, bytes: new Uint8Array(changeBytes), addedAt: delta.savedAt })
      transaction.objectStore("proofs").put({ id: changeKey, workspaceId: expected.workspaceId, changeHash: receipt.changeHash, proof })
      receipts.add({ id: receiptKey, workspaceId: expected.workspaceId, transactionId: receipt.transactionId, receipt })
      advanceWorkspaceRevision(transaction, expected.workspaceId)
    } catch (error) {
      transaction.abort()
      await done.catch(() => undefined)
      throw error
    }
    await done
    return next
  }

  private appendMemory(expected: WorkspaceDeltaFrontier, delta: StoredWorkspaceDelta, next: WorkspaceDeltaFrontier,
    expectedRevision: string | null, ensureCurrent: () => void) {
    let result = next
    updateLocalJournal(expected.workspaceId, current => {
      const applied = appendMemoryJournal(current, expected, delta, next, expectedRevision, ensureCurrent)
      result = applied.frontier
      return applied.journal
    })
    return structuredClone(result)
  }

  /** Install only against the exact saved basis and proof set checked by the caller. */
  async install(basis: StoredWorkspaceSnapshot, frontier: WorkspaceDeltaFrontier, authorizations: unknown[], expectedRevision: string | null,
    ensureCurrent: () => void, nextRevision: string): Promise<boolean> {
    if (!this.database) {
      let installed = false
      updateLocalJournal(basis.workspaceId, current => {
        ensureCurrent()
        if (current.frontier || (current.revision ?? null) !== expectedRevision ||
            !sameBasis(current.snapshot, basis) || canonicalizeJson(current.authorizations ?? []) !== canonicalizeJson(authorizations))
          return { ...current }
        installed = true
        return { ...current, revision: nextRevision, frontier: structuredClone(frontier), deltas: [] }
      })
      return installed
    }
    const transaction = this.database.transaction(["snapshots", "authorizations", "frontiers", "revisions"], "readwrite")
    const done = transactionDone(transaction)
    const [snapshot, proofs, current, revision] = await Promise.all([
      requestResult(transaction.objectStore("snapshots").get(basis.workspaceId)) as Promise<StoredWorkspaceSnapshot | undefined>,
      requestResult(transaction.objectStore("authorizations").get(basis.workspaceId)) as Promise<{ records: unknown[] } | undefined>,
      requestResult(transaction.objectStore("frontiers").get(basis.workspaceId)) as Promise<WorkspaceDeltaFrontier | undefined>,
      requestResult(transaction.objectStore("revisions").get(basis.workspaceId)) as Promise<{ revision: string } | undefined>,
    ])
    const installed = !current && (revision?.revision ?? null) === expectedRevision &&
      sameBasis(snapshot, basis) && canonicalizeJson(proofs?.records ?? []) === canonicalizeJson(authorizations)
    ensureCurrent()
    if (installed) {
      transaction.objectStore("frontiers").put(frontier)
      transaction.objectStore("revisions").put({ id: basis.workspaceId, workspaceId: basis.workspaceId, revision: nextRevision })
    }
    await done
    return installed
  }

  /** Cold read verifies the immutable basis and append chain without replaying historical authorization. */
  async read(workspaceId: string): Promise<{ basis: StoredWorkspaceSnapshot; frontier: WorkspaceDeltaFrontier; deltas: StoredWorkspaceDelta[] } | undefined> {
    const { basis, frontier, saved } = await this.readSaved(workspaceId)
    if (!frontier) return undefined
    if (!basis || frontier.basisSavedAt !== basis.savedAt || !sameHeads(frontier.basisHeads, basis.heads) ||
      frontier.policy !== basis.causalEvidence?.admissionCheckpoint?.policy ||
      frontier.basisHash !== await basisHash(basis)) throw new Error("Delta basis no longer matches its frontier")
    let checked: WorkspaceDeltaFrontier = { ...frontier, revision: 0, heads: [...basis.heads].sort(), chainHash: await basisChainHash(frontier),
      title: basis.title, archivedAt: basis.archivedAt ?? null, savedAt: basis.savedAt }
    const deltas = saved.filter(delta => delta.generation === frontier.generation).sort((a, b) => a.sequence - b.sequence)
    for (const delta of deltas) {
      await verifyDelta(checked, delta)
      checked = nextFrontier(checked, delta)
    }
    if (canonicalizeJson(checked) !== canonicalizeJson(frontier)) throw new Error("Delta chain does not reach the saved frontier")
    return { basis, frontier, deltas }
  }

  private async readSaved(workspaceId: string) {
    if (!this.database) {
      const journal = structuredClone(readLocalJournalReference(workspaceId))
      const frontier = journal.frontier
      return { basis: journal.snapshot, frontier,
        saved: frontier ? (journal.deltas ?? []).filter(delta => delta.generation === frontier.generation) : [] }
    }
    const transaction = this.database.transaction(["snapshots", "frontiers", "deltas"], "readonly")
    const done = transactionDone(transaction)
    const [basis, frontier] = await Promise.all([
      requestResult(transaction.objectStore("snapshots").get(workspaceId)) as Promise<StoredWorkspaceSnapshot | undefined>,
      requestResult(transaction.objectStore("frontiers").get(workspaceId)) as Promise<WorkspaceDeltaFrontier | undefined>,
    ])
    const saved = frontier
      ? await requestResult(transaction.objectStore("deltas").index("sequence").getAll(
          IDBKeyRange.bound([workspaceId, frontier.generation, 0], [workspaceId, frontier.generation, frontier.revision]),
        )) as StoredWorkspaceDelta[]
      : []
    await done
    return { basis, frontier, saved }
  }
}

async function returnExistingAppend(
  transaction: IDBTransaction, done: Promise<void>, deltas: IDBObjectStore, delta: StoredWorkspaceDelta,
  current: WorkspaceDeltaFrontier | undefined, existing: StoredReceiptRecord, changeHash: string,
): Promise<WorkspaceDeltaFrontier> {
  const committed = await requestResult(deltas.get(delta.id)) as StoredWorkspaceDelta | undefined
  if (!current || existing.receipt.changeHash !== changeHash || committed?.hash !== delta.hash) {
    throw new Error("Delta transaction conflicts with a committed receipt")
  }
  await done
  return current
}

function assertAppendBasis(
  current: WorkspaceDeltaFrontier | undefined, revision: { revision: string } | undefined,
  expected: WorkspaceDeltaFrontier, expectedRevision: string | null,
): void {
  if (canonicalizeJson(current) !== canonicalizeJson(expected)) throw new Error("Delta frontier changed in another tab")
  if ((revision?.revision ?? null) !== expectedRevision) throw new Error("Workspace revision changed in another tab")
}

function appendMemoryJournal(
  current: ReturnType<typeof readLocalJournalReference>, expected: WorkspaceDeltaFrontier,
  delta: StoredWorkspaceDelta, next: WorkspaceDeltaFrontier, expectedRevision: string | null,
  ensureCurrent: () => void,
): { journal: ReturnType<typeof readLocalJournalReference>; frontier: WorkspaceDeltaFrontier } {
  const { receipt, proof, changeBytes } = delta.command
  const existing = current.receipts[receipt.transactionId]
  if (existing) return existingMemoryAppend(current, existing, delta)
  assertMemoryAppendBasis(current, expected, expectedRevision)
  ensureCurrent()
  const nextJournal = { ...current, revision: crypto.randomUUID(), frontier: structuredClone(next), deltas: [...current.deltas ?? [], structuredClone(delta)],
    changes: [...current.changes, { workspaceId: expected.workspaceId, changeHash: receipt.changeHash,
      bytesBase64: toBase64Url(changeBytes), addedAt: delta.savedAt }],
    receipts: { ...current.receipts, [receipt.transactionId]: receipt }, proofs: { ...current.proofs, [receipt.changeHash]: proof } }
  const progressBaselineId = current.snapshot?.receivedHistory?.baselineId ?? current.historyProgress?.baselineId
  if (progressBaselineId !== undefined) advanceLocalHistoryProgress(nextJournal, expected.workspaceId, progressBaselineId, 1, changeBytes.byteLength)
  return { journal: nextJournal, frontier: next }
}

function existingMemoryAppend(
  current: ReturnType<typeof readLocalJournalReference>, existing: TransactionReceipt,
  delta: StoredWorkspaceDelta,
): { journal: ReturnType<typeof readLocalJournalReference>; frontier: WorkspaceDeltaFrontier } {
  const committed = current.deltas?.find(item => item.id === delta.id)
  if (!current.frontier || existing.changeHash !== delta.command.receipt.changeHash || committed?.hash !== delta.hash) {
    throw new Error("Delta transaction conflicts with a committed receipt")
  }
  return { journal: { ...current }, frontier: current.frontier }
}

function assertMemoryAppendBasis(
  current: ReturnType<typeof readLocalJournalReference>, expected: WorkspaceDeltaFrontier, expectedRevision: string | null,
): void {
  if (canonicalizeJson(current.frontier) !== canonicalizeJson(expected)) throw new Error("Delta frontier changed in another tab")
  if ((current.revision ?? null) !== expectedRevision) throw new Error("Workspace revision changed in another tab")
}


function sameBasis(left: StoredWorkspaceSnapshot | undefined, right: StoredWorkspaceSnapshot) {
  if (!left) return false
  const descriptor = (snapshot: StoredWorkspaceSnapshot) => ({ ...snapshot, bytes: null,
    causalEvidence: snapshot.causalEvidence ? { ...snapshot.causalEvidence, bytes: null } : undefined })
  const bytesEqual = (a: Uint8Array | undefined, b: Uint8Array | undefined) => a?.length === b?.length && (!a || a.every((byte, index) => byte === b?.[index]))
  return canonicalizeJson(descriptor(left)) === canonicalizeJson(descriptor(right)) && bytesEqual(left.bytes, right.bytes) &&
    bytesEqual(left.causalEvidence?.bytes, right.causalEvidence?.bytes)
}

type CheckedDeltaWorkspace = NonNullable<Awaited<ReturnType<WorkspaceDeltaJournal["read"]>>>

export function createDeltaWorkspaceDocument(saved: CheckedDeltaWorkspace,
  prefix?: { document: Automerge.Doc<WorkspaceDocumentV2>; revision: number }): Automerge.Doc<WorkspaceDocumentV2> {
  let doc = prefix ? Automerge.clone(prefix.document) : Automerge.load<WorkspaceDocumentV2>(saved.basis.bytes)
  const deltas = prefix ? saved.deltas.slice(prefix.revision) : saved.deltas
  if (deltas.length) [doc] = Automerge.applyChanges(doc, deltas.map(delta => delta.command.changeBytes))
  if (!sameHeads(Automerge.getHeads(doc), saved.frontier.heads) || doc.id !== saved.frontier.workspaceId ||
    doc.title !== saved.frontier.title || (doc.archivedAt ?? null) !== saved.frontier.archivedAt) {
    Automerge.free(doc)
    throw new Error("Delta document does not match its frontier")
  }
  return doc
}

/** Full assembly belongs to export/reclassification, never ordinary local persistence. */
export function materializeDeltaWorkspace(saved: CheckedDeltaWorkspace): StoredWorkspaceSnapshot {
  if (!saved.deltas.length) return saved.basis
  const doc = createDeltaWorkspaceDocument(saved)
  try {
    const bytes = Automerge.save(doc)
    const basis = saved.basis.causalEvidence!
    return { ...saved.basis, title: saved.frontier.title, archivedAt: saved.frontier.archivedAt,
      heads: [...saved.frontier.heads], savedAt: saved.frontier.savedAt, bytes,
      causalEvidence: { ...basis, bytes,
        decisions: [...basis.decisions, ...saved.deltas.map(delta => ({ hash: delta.command.receipt.changeHash,
          status: { type: "admitted" as const, role: delta.command.role } }))],
        authorizationEvidence: mergeAuthorizationRecords((basis.authorizationEvidence ?? []) as WorkspaceChangeAuthorization[],
          saved.deltas.flatMap(delta => delta.command.authorizations)),
        admissionCheckpoint: { policy: saved.frontier.policy, projectionHeads: [...saved.frontier.heads],
          inputHash: saved.frontier.chainHash, decisionsHash: saved.frontier.chainHash, incremental: true } } }
  } finally { Automerge.free(doc) }
}
