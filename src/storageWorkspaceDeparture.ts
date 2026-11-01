import type { WorkspaceDeparture } from "@meta-uber/mesh-workspace"
import { compareAndSwapLocal, readLocal } from "./localDb"

const prefix = "tincanban.workspace-departure.v1."
const indexKey = "tincanban.workspace-departure-index.v1"
export type PendingWorkspaceDeparture = {
  workspaceId: string
  personId: string
  departure: WorkspaceDeparture
  baselineId?: string
  snapshot: string
  delivered: boolean
  removeCopy: boolean
  resumed?: boolean
}

function entryKey(workspaceId: string, personId: string): string { return prefix + JSON.stringify([workspaceId, personId]) }

function parseDeparture(raw: string, key: string): PendingWorkspaceDeparture {
  const entry = JSON.parse(raw) as PendingWorkspaceDeparture
  if (!entry || typeof entry.workspaceId !== "string" || !entry.workspaceId || typeof entry.personId !== "string" || !entry.personId ||
    entryKey(entry.workspaceId, entry.personId) !== key || typeof entry.snapshot !== "string" || !entry.snapshot ||
    typeof entry.delivered !== "boolean" || typeof entry.removeCopy !== "boolean" || !entry.departure) {
    throw new Error("Invalid pending workspace departure")
  }
  return entry
}

export type WorkspaceDepartureSummary = Pick<PendingWorkspaceDeparture, "workspaceId" | "personId" | "delivered" | "resumed">

function isSummary(entry: unknown): entry is WorkspaceDepartureSummary {
  const value = entry as Partial<WorkspaceDepartureSummary> | null
  return !!value && typeof value.workspaceId === "string" && !!value.workspaceId &&
    typeof value.personId === "string" && !!value.personId && typeof value.delivered === "boolean"
}

function parseIndex(raw: string | null): WorkspaceDepartureSummary[] {
  const entries: unknown = raw === null ? [] : JSON.parse(raw)
  if (!Array.isArray(entries) || !entries.every(isSummary)) throw new Error("Invalid workspace departure index")
  return entries
}

export async function readPendingWorkspaceDeparture(workspaceId: string, personId: string): Promise<PendingWorkspaceDeparture | null> {
  const key = entryKey(workspaceId, personId), raw = await readLocal(key)
  return raw === null ? null : parseDeparture(raw, key)
}

/** Metadata-only discovery keeps idle retries and local edit guards independent of snapshot size. */
export async function listPendingWorkspaceDepartures(): Promise<WorkspaceDepartureSummary[]> {
  return parseIndex(await readLocal(indexKey))
}

export async function assertWorkspaceNotDeparting(workspaceId: string, personId?: string): Promise<void> {
  if ((await listPendingWorkspaceDepartures()).some(entry => entry.workspaceId === workspaceId && (!personId || entry.personId === personId) && !entry.resumed)) {
    throw new Error("Workspace departure is pending; final changes are queued for delivery")
  }
}

/** Entry and discovery index commit together; a crash cannot orphan a hidden board's delivery intent. */
async function mutateEntry(key: string, update: (current: string | null) => string | null): Promise<void> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const [current, index] = await Promise.all([readLocal(key), readLocal(indexKey)])
    const next = update(current), entries = parseIndex(index).filter(entry => entryKey(entry.workspaceId, entry.personId) !== key)
    if (next !== null) {
      const { workspaceId, personId, delivered, resumed } = parseDeparture(next, key)
      entries.push({ workspaceId, personId, delivered, ...(resumed ? { resumed: true } : {}) })
    }
    const nextIndex = JSON.stringify(entries)
    if (next === current && nextIndex === index) return
    if (await compareAndSwapLocal({ conditions: [{ key, value: current }, { key: indexKey, value: index }],
      writes: [{ key, value: next }, { key: indexKey, value: nextIndex }] })) return
  }
  throw new Error("Workspace departures changed too often to save safely")
}

export async function savePendingWorkspaceDeparture(entry: PendingWorkspaceDeparture): Promise<void> {
  const key = entryKey(entry.workspaceId, entry.personId), raw = JSON.stringify(entry)
  parseDeparture(raw, key)
  await mutateEntry(key, current => current ?? raw)
}

export async function updatePendingWorkspaceDeparture(workspaceId: string, personId: string,
  patch: Partial<Pick<PendingWorkspaceDeparture, "delivered" | "removeCopy" | "resumed">>): Promise<void> {
  const key = entryKey(workspaceId, personId)
  await mutateEntry(key, current => {
    if (!current) throw new Error("Workspace departure is unavailable")
    const entry = parseDeparture(current, key)
    return JSON.stringify({ ...entry, ...patch, delivered: entry.delivered || patch.delivered === true })
  })
}

export async function completeWorkspaceDeparture(workspaceId: string, personId: string): Promise<void> {
  const key = entryKey(workspaceId, personId)
  await mutateEntry(key, current => {
    if (current && !parseDeparture(current, key).delivered) throw new Error("Workspace delivery is not confirmed")
    return null
  })
}
