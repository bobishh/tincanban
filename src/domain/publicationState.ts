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

export function reconcilePublicationRecord(record: PublicationRecord | undefined, remote: {
  revision: number; published: boolean; availability?: PublicationAvailability; hash?: string; projection?: PublicBoardProjection
}): { published: boolean; withdrawn: boolean; recoveryNeeded: boolean; revision: number; hash: string; record?: PublicationRecord } {
  const availability = remote.availability ?? (remote.published ? "published" : "withdrawn")
  if (record?.ownerIntent === "withdrawn") return withdrawnIntent(record, availability, remote)
  if (record?.ownerIntent === "published" && availability === "missing") return missingPublishedCopy(record, remote.revision)
  if (record && availability === "withdrawn") return observedRemoteWithdrawal(record, remote.revision, remote.hash)
  return observedRemoteState(record, remote, availability)
}

function withdrawnIntent(record: PublicationRecord, availability: PublicationAvailability, remote: { revision: number }) {
  const next = { ...record, remoteAvailability: availability }
  const pending = next.intent && !next.intent.confirmed && next.intent.action === "unpublish" && next.intent.expectedRevision + 1 === remote.revision
    ? { ...next.intent, confirmed: true, confirmedBy: "status" as const } : next.intent
  const confirmed = pending === next.intent ? next : { ...next, intent: pending }
  return { published: false, withdrawn: true, recoveryNeeded: false, revision: remote.revision,
    hash: record.confirmedHash, record: confirmed }
}
function missingPublishedCopy(record: PublicationRecord, remoteRevision: number) {
  const next = { ...record, remoteAvailability: "missing" as const }
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
  const ownerConfirmed = confirmPublishedIntent(record, remote)
  const observed = ownerConfirmed ? { ...ownerConfirmed, remoteAvailability: availability } : undefined
  const confirmed = remote.published && observed ? { ...observed, confirmedRevision: remote.revision,
    confirmedHash: remote.hash ?? observed.confirmedHash, ...(remote.projection ? { confirmedProjection: remote.projection } : {}) } : observed
  return { published: remote.published, withdrawn: !remote.published && remote.revision > 0,
    recoveryNeeded: false, revision: remote.revision, hash: remote.hash ?? "",
    record: confirmed }
}
function confirmPublishedIntent(record: PublicationRecord | undefined,
  remote: { revision: number; published: boolean; hash?: string }): PublicationRecord | undefined {
  const intent = record?.intent
  if (!record || !intent || intent.confirmed || intent.action === "unpublish" || !remote.published ||
      intent.expectedRevision + 1 !== remote.revision || intent.projectionHash !== remote.hash) return record
  return { ...record, intent: { ...intent, confirmed: true, confirmedBy: "status" } }
}
