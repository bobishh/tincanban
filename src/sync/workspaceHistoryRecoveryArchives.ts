import { BrowserMeshStore } from "@meta-uber/mesh-browser-store"
import { canonicalizeJson, fromBase64Url, sha256Base64Url, toBase64Url } from "../domain/identity"
import type { HistoryRecoveryRecord } from "./historyRecoveryArchive"

type Source = Extract<HistoryRecoveryRecord, { kind: "archive-source" }>
type Retained = { kind: "workspace-recovery-archive-source"; version: 1; personId: string; workspaceId: string;
  recoveryId: string; source: Source; digest: string }
const STORE = "records", encoder = new TextEncoder()
function persistence() { return new BrowserMeshStore("tincanban-private-workspace-recovery-v1", [STORE]) }
async function hash(value: unknown) { return sha256Base64Url(encoder.encode(canonicalizeJson(value))) }
async function prefix(personId: string, workspaceId: string) {
  if (!personId || personId.length > 512 || !workspaceId || workspaceId.length > 256) throw new Error("Invalid private history archive binding")
  return `workspace-recovery.archive.v1.${await hash(personId)}.${await hash(workspaceId)}.`
}
function captureSource(input: unknown, workspaceId: string): Source {
  const source = structuredClone(input) as Source
  if (!validSourceShape(source, workspaceId)) throw new Error("Invalid retained recovery archive source")
  const key = fromBase64Url(source.key)
  try { if (key.length !== 32 || toBase64Url(key) !== source.key) throw new Error("Invalid retained archive key") }
  finally { key.fill(0) }
  return source
}
function validSourceShape(source: Source, workspaceId: string): boolean {
  return Boolean(source && source.kind === "archive-source" && source.workspaceId === workspaceId && validSourceId(source) &&
    validSourceStorage(source) && validSourceEvidence(source))
}
function validSourceId(source: Source): boolean {
  return typeof source.id === "string" && source.id.length > 0 && source.id.length <= 256
}
function validSourceStorage(source: Source): boolean {
  return typeof source.scopeId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(source.scopeId) &&
    Number.isSafeInteger(source.keyEpoch) && source.keyEpoch >= 1 && typeof source.key === "string"
}
function validSourceEvidence(source: Source): boolean {
  return typeof source.signedJson === "string" && Array.isArray(source.roots) && source.roots.length > 0 && source.roots.length <= 4 &&
    encoder.encode(canonicalizeJson(source)).length <= 3 * 1024 * 1024
}

/** Private original evidence only. Retention never activates a publication or grants document admission. */
export async function retainWorkspaceRecoveryArchives(personId: string, workspaceId: string, recoveryId: string,
  records: HistoryRecoveryRecord[], ensureCurrent: () => void): Promise<void> {
  ensureCurrent()
  if (!/^[0-9a-f-]{36}$/i.test(recoveryId)) throw new Error("Invalid private recovery ID")
  const base = await prefix(personId, workspaceId), store = persistence()
  const sources = records.filter((record): record is Source => record.kind === "archive-source")
  if (sources.length > 256) throw new Error("Too many retained archive sources")
  for (const input of sources) {
    ensureCurrent()
    const source = captureSource(input, workspaceId), digest = await hash(source)
    const key = base + await hash([recoveryId, source.id])
    const value: Retained = { kind: "workspace-recovery-archive-source", version: 1, personId, workspaceId, recoveryId, source, digest }
    await store.updateRecords(STORE, [key], values => {
      ensureCurrent()
      const previous = values[0] as Retained | undefined
      if (previous !== undefined && canonicalizeJson(previous) !== canonicalizeJson(value)) throw new Error("Recovery archive ID already has different original evidence")
      return { writes: previous === undefined ? [{ key, value }] : [], result: undefined }
    })
    ensureCurrent()
  }
}

export async function listRetainedWorkspaceRecoveryArchives(personId: string, workspaceId: string,
  ensureCurrent: () => void): Promise<Array<{ sourceId: string; source: Source }>> {
  ensureCurrent()
  const base = await prefix(personId, workspaceId), store = persistence(), result: Array<{ sourceId: string; source: Source }> = []
  let after: string | undefined
  for (;;) {
    ensureCurrent()
    const page = await store.scan<Retained>(STORE, base, after, 64)
    for (const entry of page.entries) {
      ensureCurrent()
      const value = entry.value
      if (!value || value.kind !== "workspace-recovery-archive-source" || value.version !== 1 || value.personId !== personId ||
          value.workspaceId !== workspaceId || await hash(value.source) !== value.digest ||
          entry.key !== base + await hash([value.recoveryId, value.source.id])) throw new Error("Retained recovery archive evidence is invalid")
      result.push({ sourceId: "recovered:" + await hash([value.recoveryId, value.source.id]), source: captureSource(value.source, workspaceId) })
      if (result.length > 256) throw new Error("Too many retained archive sources; recovery export requires selecting a backup")
    }
    after = page.nextAfter ?? undefined
    if (!after) break
  }
  ensureCurrent()
  return result
}
