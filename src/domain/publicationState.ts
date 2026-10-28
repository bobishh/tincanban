import type { LocalProfile, SignedEnvelope } from "./identity"
import type { PublicBoardProjection } from "../public/publicSchema"

export type PublicationIntentAction = "publish" | "update" | "unpublish"
export type PublicationAvailability = "published" | "withdrawn" | "missing"

type PublicationIntent = {
  operationId: string
  action: PublicationIntentAction
  expectedRevision: number
  projection: PublicBoardProjection | null
  projectionHash: string
  preparedAssetManifest?: Array<{ sha256: string; byteLength: number }>
  sourceHeads: string[]
  deliveryPolicy?: unknown
  confirmed?: boolean
  confirmedBy?: "receipt" | "status"
}

export type PublicationRecord = {
  version: 1
  origin: string
  workspaceId: string
  boardId: string
  ownerPersonId: string
  ownerIntent: "published" | "withdrawn"
  intent?: PublicationIntent
  receipt?: SignedEnvelope<unknown>
  confirmedRevision: number
  confirmedHash: string
  confirmedProjection?: PublicBoardProjection
  remoteAvailability: PublicationAvailability | "unknown"
}

export function publicationRecordKey(origin: string, workspaceId: string, boardId: string, profile: LocalProfile): string {
  return `publication:${encodeURIComponent(origin)}:${encodeURIComponent(workspaceId)}:${encodeURIComponent(boardId)}:${encodeURIComponent(profile.identity.personId)}`
}

export function parsePublicationRecord(raw: string | null): PublicationRecord | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as PublicationRecord
    if (value.version !== 1 || typeof value.origin !== "string" || typeof value.workspaceId !== "string" ||
        typeof value.boardId !== "string" || typeof value.ownerPersonId !== "string" ||
        !["published", "withdrawn"].includes(value.ownerIntent) || !Number.isSafeInteger(value.confirmedRevision) ||
        value.confirmedRevision < 0 || typeof value.confirmedHash !== "string") return undefined
    return value
  } catch { return undefined }
}

/** Remote state must come from the authenticated, integrity-checked publication reader. */
export function reconcilePublicationRecord(record: PublicationRecord | undefined, remote: {
  revision: number; published: boolean; availability?: PublicationAvailability; hash?: string; projection?: PublicBoardProjection
}): { published: boolean; withdrawn: boolean; recoveryNeeded: boolean; revision: number; hash: string; record?: PublicationRecord; retryWithdrawal?: boolean } {
  const availability = remote.availability ?? (remote.published ? "published" : "withdrawn")
  if (record?.ownerIntent === "withdrawn") return withdrawnIntent(record, availability, remote)
  if (record?.ownerIntent === "published" && availability === "missing") return missingPublishedCopy(record, remote.revision)
  if (record && availability === "withdrawn") return observedRemoteWithdrawal(record, remote.revision, remote.hash)
  return observedRemoteState(record, remote, availability)
}

function withdrawnIntent(record: PublicationRecord, availability: PublicationAvailability, remote: { revision: number }) {
  const next = { ...record, remoteAvailability: availability }
  const intent = next.intent
  const unconfirmed = intent?.action === "unpublish" && !intent.confirmed
  const pending = availability === "withdrawn" && intent && unconfirmed && intent.expectedRevision + 1 === remote.revision
    ? { ...intent, confirmed: true, confirmedBy: "status" as const } : intent
  const confirmed = pending === next.intent ? next : { ...next, intent: pending }
  return { published: false, withdrawn: true, recoveryNeeded: false, revision: remote.revision,
    hash: record.confirmedHash, record: confirmed, retryWithdrawal: availability === "published" && unconfirmed }
}
function missingPublishedCopy(record: PublicationRecord, remoteRevision: number) {
  const next = { ...record, remoteAvailability: "missing" as const }
  if (record.confirmedRevision === 0) {
    // No public snapshot was ever confirmed. Preserve the owner's intent, but
    // resolve any failed operation so repeated missing reads stay private.
    const resolved = { ...next }
    delete resolved.intent
    return { published: false, withdrawn: false, recoveryNeeded: false, revision: remoteRevision,
      hash: record.confirmedHash, record: resolved }
  }
  if (record.remoteAvailability === "withdrawn") return { published: false, withdrawn: true, recoveryNeeded: false,
    revision: remoteRevision, hash: record.confirmedHash, record: next }
  return { published: true, withdrawn: false, recoveryNeeded: true, revision: remoteRevision,
    hash: record.confirmedHash, record: next }
}
function observedRemoteWithdrawal(record: PublicationRecord, revision: number, hash?: string) {
  const next = { ...record, remoteAvailability: "withdrawn" as const, confirmedRevision: revision,
    ...(hash ? { confirmedHash: hash } : {}) }
  const pending = next.intent && !next.intent.confirmed && next.intent.action === "unpublish" && next.intent.expectedRevision + 1 === revision
    ? { ...next.intent, confirmed: true, confirmedBy: "status" as const } : next.intent
  const confirmed = pending === next.intent ? next : { ...next, intent: pending }
  return { published: false, withdrawn: true, recoveryNeeded: false, revision, hash: confirmed.confirmedHash, record: confirmed }
}
function observedRemoteState(record: PublicationRecord | undefined, remote: { revision: number; published: boolean; hash?: string; projection?: PublicBoardProjection },
  availability: PublicationAvailability) {
  const ownerConfirmed = reconcilePublishedIntent(record, remote)
  const observed = ownerConfirmed ? { ...ownerConfirmed, remoteAvailability: availability } : undefined
  const pendingUpdate = observed?.intent?.action === "update" && !observed.intent.confirmed
  const confirmed = remote.published && observed && !pendingUpdate ? { ...observed, confirmedRevision: remote.revision,
    confirmedHash: remote.hash ?? observed.confirmedHash, ...(remote.projection ? { confirmedProjection: remote.projection } : {}) } : observed
  return { published: remote.published, withdrawn: !remote.published && remote.revision > 0,
    recoveryNeeded: false, revision: remote.revision, hash: remote.hash ?? "",
    record: confirmed }
}
function reconcilePublishedIntent(record: PublicationRecord | undefined,
  remote: { revision: number; published: boolean; hash?: string }): PublicationRecord | undefined {
  const intent = record?.intent
  if (!record || !intent || intent.confirmed || intent.action === "unpublish" || !remote.published ||
      remote.revision < Math.max(record.confirmedRevision, intent.expectedRevision)) return record
  if (intent.expectedRevision + 1 === remote.revision && intent.projectionHash === remote.hash) {
    return { ...record, intent: { ...intent, confirmed: true, confirmedBy: "status" as const } }
  }
  if (intent.action !== "update" || !remote.hash) return record
  const unchangedBase = remote.revision === record.confirmedRevision && remote.hash === record.confirmedHash
  if (!unchangedBase && remote.revision === intent.expectedRevision) return record
  // A current base can be retried under CAS. An advanced revision makes this
  // older CAS attempt unable to commit, even if another request won the race.
  const retryable = { ...record }
  delete retryable.intent
  return retryable
}
