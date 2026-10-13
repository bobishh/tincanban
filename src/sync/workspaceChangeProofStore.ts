import { openWorkspaceJournal, readLocalJournal, writeLocalJournal, withLocalJournalLock, requestResult, transactionDone } from "../storageJournal"
import { canonicalizeJson, type SignedEnvelope } from "../domain/identity"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"

export type WorkspaceChangeAuthorization = {
  signed: SignedEnvelope<{ kind: "workspace-changes"; version: 1; workspaceId: string; hashes: string[]; personId: string; deviceId: string }>
  publicKey: string
  certificates: DeviceCertificate[]
  grant?: WorkspaceGrant
  ownerPublicKey: string
  ownerCertificates: DeviceCertificate[]
}

let dbPromise: Promise<IDBDatabase> | undefined

function database() {
  return dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("tincanban-write-authorizations-v1")
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("records")) request.result.createObjectStore("records")
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function legacyRecords(workspaceId: string): Promise<WorkspaceChangeAuthorization[]> {
  if (typeof indexedDB === "undefined") return []
  const db = await database()
  return new Promise((resolve, reject) => {
    const request = db.transaction("records").objectStore("records").get(workspaceId)
    request.onsuccess = () => resolve(request.result ?? [])
    request.onerror = () => reject(request.error)
  })
}

function canonicalChoice<T>(left: T, right: T): T {
  return canonicalizeJson(left) <= canonicalizeJson(right) ? left : right
}

function mergeCertificates(left: DeviceCertificate[] | undefined, right: DeviceCertificate[] | undefined): DeviceCertificate[] {
  const merged = new Map<string, DeviceCertificate>()
  for (const certificate of [...(left ?? []), ...(right ?? [])]) {
    const current = merged.get(certificate.signature)
    merged.set(certificate.signature, current ? canonicalChoice(current, certificate) : certificate)
  }
  return [...merged.values()].sort((a, b) => a.signature.localeCompare(b.signature))
}

function mergeRequiredText(left: string | undefined, right: string | undefined): string {
  if (!left) return right ?? ""
  if (!right) return left
  return canonicalChoice(left, right)
}

function mergeAuthorization(current: WorkspaceChangeAuthorization, incoming: WorkspaceChangeAuthorization): WorkspaceChangeAuthorization {
  return { signed: canonicalChoice(current.signed, incoming.signed), publicKey: canonicalChoice(current.publicKey, incoming.publicKey),
    certificates: mergeCertificates(current.certificates, incoming.certificates),
    ...(current.grant || incoming.grant ? { grant: current.grant && incoming.grant ? canonicalChoice(current.grant, incoming.grant) : current.grant ?? incoming.grant } : {}),
    ownerPublicKey: mergeRequiredText(current.ownerPublicKey, incoming.ownerPublicKey),
    ownerCertificates: mergeCertificates(current.ownerCertificates, incoming.ownerCertificates) }
}

function authorizationVariantKey(record: WorkspaceChangeAuthorization): string {
  return `${record.signed.signature}:${canonicalizeJson(record.grant ?? null)}`
}

export function mergeAuthorizationRecords(existing: WorkspaceChangeAuthorization[], incoming: WorkspaceChangeAuthorization[]) {
  const result = new Map<string, WorkspaceChangeAuthorization>()
  for (const record of [...existing, ...incoming]) {
    const key = authorizationVariantKey(record)
    const current = result.get(key)
    result.set(key, current ? mergeAuthorization(current, record) : {
      ...record,
      certificates: mergeCertificates([], record.certificates),
      ownerCertificates: mergeCertificates([], record.ownerCertificates),
    })
  }
  return [...result.values()].sort((left, right) => left.signed.signature.localeCompare(right.signed.signature) ||
    canonicalizeJson(left.grant ?? null).localeCompare(canonicalizeJson(right.grant ?? null)))
}

export async function records(workspaceId: string): Promise<WorkspaceChangeAuthorization[]> {
  if (typeof indexedDB === "undefined") return (readLocalJournal(workspaceId).authorizations ?? []) as WorkspaceChangeAuthorization[]
  const db = await openWorkspaceJournal()
  const transaction = db.transaction("authorizations", "readonly")
  const completion = transactionDone(transaction)
  const stored = await requestResult(transaction.objectStore("authorizations").get(workspaceId)) as { records: WorkspaceChangeAuthorization[] } | undefined
  await completion
  return stored?.records ?? legacyRecords(workspaceId)
}

export async function putRecords(workspaceId: string, incoming: WorkspaceChangeAuthorization[]): Promise<boolean> {
  const previous = await records(workspaceId)
  if (typeof indexedDB === "undefined") return withLocalJournalLock(workspaceId, async () => {
    const journal = readLocalJournal(workspaceId)
    const existing = mergeAuthorizationRecords(previous, (journal.authorizations ?? []) as WorkspaceChangeAuthorization[])
    const next = mergeAuthorizationRecords(existing, incoming)
    const changed = canonicalizeJson(existing) !== canonicalizeJson(next)
    journal.authorizations = next
    writeLocalJournal(workspaceId, journal)
    return changed
  })
  const db = await openWorkspaceJournal()
  return new Promise<boolean>((resolve, reject) => {
    let changed = false
    const transaction = db.transaction("authorizations", "readwrite")
    const store = transaction.objectStore("authorizations")
    const get = store.get(workspaceId)
    get.onsuccess = () => {
      try {
        const existing = mergeAuthorizationRecords(previous, get.result?.records ?? [])
        const next = mergeAuthorizationRecords(existing, incoming)
        changed = canonicalizeJson(existing) !== canonicalizeJson(next)
        store.put({ id: workspaceId, workspaceId, records: next })
      } catch (error) { transaction.abort(); reject(error) }
    }
    transaction.oncomplete = () => resolve(changed)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}
