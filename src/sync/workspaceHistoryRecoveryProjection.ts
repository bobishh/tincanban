import { BrowserMeshStore } from "@meta-uber/mesh-browser-store"
import { canonicalizeJson, sha256Base64Url, type LocalProfile } from "../domain/identity"
import { readLocal } from "../localDb"
import { defaultStorage, type WorkspaceAuthorityMutationContext } from "../storage"
import { registerWorkspaceInCurrentRoot } from "../statePersonalRoot"
import { readWorkspaceCatalogRecords } from "../storageCatalog"
import { openWorkspaceJournal } from "../storageJournal"
import { peerStore, type WorkspaceAuthorityRecord, type WorkspaceMeshCredential } from "./peerStore"
import { readIdentityDeviceTransfer } from "./identityDeviceTransfer"
import { activateIdentityDeviceTransfer } from "./identityDeviceActivation"

const DATABASE = "tincanban-private-workspace-recovery-v1"
const STORE = "records"
const PREFIX = "workspace-history-projection.v1."
const encoder = new TextEncoder()
type ProjectionInput = { personId: string; workspaceId: string; recoveryId: string; manifest: unknown;
  authority: WorkspaceAuthorityRecord | null; credential: WorkspaceMeshCredential | null; title: string }
type ProjectionIntent = { kind: "workspace-history-recovery-projection"; version: 1; personId: string; workspaceId: string;
  recoveryId: string; manifest: unknown; authority: WorkspaceAuthorityRecord | null; credential: WorkspaceMeshCredential | null;
  title: string; digest: string; status: "pending" | "completed" }

function store() { return new BrowserMeshStore(DATABASE, [STORE]) }
function validId(value: unknown, max = 512): value is string { return typeof value === "string" && value.length > 0 && value.length <= max }
function captureInput(value: ProjectionInput): Omit<ProjectionIntent, "kind" | "version" | "digest" | "status"> {
  const input = structuredClone(value)
  if (!input || !validId(input.personId) || !validId(input.workspaceId, 256) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.recoveryId) ||
      !validId(input.title, 512) || !input.manifest || typeof input.manifest !== "object" ||
      (input.authority !== null && input.authority.workspaceId !== input.workspaceId) ||
      (input.credential !== null && input.credential.workspaceId !== input.workspaceId)) {
    throw new Error("Invalid workspace history projection intent")
  }
  return input
}
async function intentDigest(intent: Omit<ProjectionIntent, "digest" | "status">): Promise<string> {
  return sha256Base64Url(encoder.encode(canonicalizeJson(intent)))
}
function intentContent(intent: ProjectionIntent): Omit<ProjectionIntent, "digest" | "status"> {
  return { kind: intent.kind, version: intent.version, personId: intent.personId, workspaceId: intent.workspaceId,
    recoveryId: intent.recoveryId, manifest: intent.manifest, authority: intent.authority,
    credential: intent.credential, title: intent.title }
}
async function intentKey(personId: string, workspaceId: string, recoveryId: string): Promise<string> {
  const [owner, binding] = await Promise.all([
    sha256Base64Url(encoder.encode(personId)),
    sha256Base64Url(encoder.encode(canonicalizeJson([workspaceId, recoveryId]))),
  ])
  return `${PREFIX}${owner}.${binding}`
}
async function personPrefix(personId: string): Promise<string> {
  return `${PREFIX}${await sha256Base64Url(encoder.encode(personId))}.`
}
function captureIntent(value: unknown, personId?: string): ProjectionIntent {
  const intent = structuredClone(value) as ProjectionIntent
  if (!validIntentRecord(intent) || !validIntentScope(intent, personId) || !validIntentPayload(intent)) {
    throw new Error("Stored workspace projection intent is invalid")
  }
  return intent
}
function validIntentRecord(intent: ProjectionIntent): boolean {
  const fields = ["kind", "version", "personId", "workspaceId", "recoveryId", "manifest", "authority", "credential", "title", "digest", "status"]
  return Boolean(intent && typeof intent === "object" && !Array.isArray(intent) && Object.keys(intent).length === fields.length &&
    fields.every(field => Object.hasOwn(intent, field)) && intent.kind === "workspace-history-recovery-projection" && intent.version === 1 &&
    (intent.status === "pending" || intent.status === "completed"))
}
function validIntentScope(intent: ProjectionIntent, personId?: string): boolean {
  return validId(intent.personId) && (personId === undefined || intent.personId === personId) &&
    validId(intent.workspaceId, 256) && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intent.recoveryId)
}
function validIntentPayload(intent: ProjectionIntent): boolean {
  return validId(intent.title, 512) && Boolean(intent.manifest) && typeof intent.manifest === "object" && typeof intent.digest === "string" &&
    (intent.authority === null || intent.authority?.workspaceId === intent.workspaceId) &&
    (intent.credential === null || intent.credential?.workspaceId === intent.workspaceId)
}
async function assertCurrent(personId: string, ensureCurrent: () => void): Promise<LocalProfile> {
  ensureCurrent()
  const raw = await readLocal("tincanban.local_profile.v1")
  ensureCurrent()
  if (raw === null) throw new Error("Durable identity profile is missing")
  let profile: LocalProfile
  try { profile = JSON.parse(raw) as LocalProfile } catch { throw new Error("Durable identity profile is invalid") }
  if (profile?.identity?.personId !== personId) throw new Error("Identity changed during workspace recovery")
  return profile
}
async function hasCommittedRecovery(workspaceId: string, recoveryId: string, ensureCurrent: () => void): Promise<boolean> {
  ensureCurrent()
  const database = await openWorkspaceJournal()
  ensureCurrent()
  const tx = database.transaction("revisions", "readonly")
  const completion = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error("Workspace recovery revision read failed"))
    tx.onabort = () => reject(tx.error ?? new Error("Workspace recovery revision read aborted"))
  })
  const request = tx.objectStore("revisions").get(workspaceId)
  const result = await new Promise<unknown>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("Workspace recovery revision read failed"))
  })
  await completion
  ensureCurrent()
  const row = result as { recoveryId?: unknown } | undefined
  return row?.recoveryId === recoveryId
}

/** Persist verified projection intent before the recovered workspace journal is activated. */
export async function prepareWorkspaceHistoryRecoveryProjection(input: ProjectionInput, ensureCurrent: () => void): Promise<void> {
  const captured = captureInput(input)
  await assertCurrent(captured.personId, ensureCurrent)
  const base = { kind: "workspace-history-recovery-projection" as const, version: 1 as const, ...captured }
  const digest = await intentDigest(base)
  await assertCurrent(captured.personId, ensureCurrent)
  const intent: ProjectionIntent = { ...base, digest, status: "pending" }
  const key = await intentKey(captured.personId, captured.workspaceId, captured.recoveryId)
  await assertCurrent(captured.personId, ensureCurrent)
  await store().updateRecords(STORE, [key], current => {
    ensureCurrent()
    const previous = current[0] as ProjectionIntent | undefined
    if (previous === undefined) return { writes: [{ key, value: intent }], result: undefined }
    const saved = captureIntent(previous, captured.personId)
    if (saved.digest !== digest || saved.workspaceId !== captured.workspaceId || saved.recoveryId !== captured.recoveryId ||
        saved.status === "completed" && canonicalizeJson({ ...saved, status: "pending" }) !== canonicalizeJson(intent)) {
      throw new Error("A different workspace recovery projection is already recorded")
    }
    return { writes: [], result: undefined }
  })
  await assertCurrent(captured.personId, ensureCurrent)
}

async function project(intent: ProjectionIntent, ensureCurrent: () => void): Promise<void> {
  const profile = await assertCurrent(intent.personId, ensureCurrent)
  if (!await hasCommittedRecovery(intent.workspaceId, intent.recoveryId, ensureCurrent)) return
  const transfer = await readIdentityDeviceTransfer(intent.manifest, intent.personId)
  await assertCurrent(intent.personId, ensureCurrent)
  if (!await hasCommittedRecovery(intent.workspaceId, intent.recoveryId, ensureCurrent)) return
  const reference = transfer.personalRoot.workspaces[intent.workspaceId]
  if (!reference || reference.forgotten || reference.workspaceId !== intent.workspaceId || !reference.grantHash) {
    throw new Error("Recovered workspace is missing its authenticated personal-root reference")
  }
  await activateIdentityDeviceTransfer(transfer, ensureCurrent)
  await assertCurrent(intent.personId, ensureCurrent)
  // Identity activation can acquire workspace locks for its own projections.
  // Fence board-local writes only after those effects release their locks.
  const projected = await defaultStorage.withWorkspaceAuthorityMutation(intent.workspaceId, async context => {
    if (!await hasCommittedRecovery(intent.workspaceId, intent.recoveryId, ensureCurrent)) return false
    await projectWorkspace(intent, profile, reference.grantHash, context, ensureCurrent)
    return true
  })
  if (projected) defaultStorage.invalidateWorkspaceCache(intent.workspaceId)
}

async function projectWorkspace(intent: ProjectionIntent, profile: LocalProfile, grantHash: string,
  context: WorkspaceAuthorityMutationContext, ensureCurrent: () => void): Promise<void> {
  if (intent.credential) {
    const current = await peerStore.getWorkspaceCredential(intent.workspaceId)
    await assertCurrent(intent.personId, ensureCurrent)
    if (current && current.ownerPersonId !== intent.credential.ownerPersonId) {
      if (intent.credential.epoch === current.epoch) throw new Error("Recovered workspace ownership conflicts with current authority")
      if (intent.credential.epoch > current.epoch) await context.write(() => peerStore.transferWorkspaceCredential(current.ownerPersonId,
        { ...intent.credential!, transportSecret: current.transportSecret }, intent.authority?.scopeAuthoritySnapshot))
    } else {
      await context.write(() => peerStore.putWorkspaceCredential(current ? { ...intent.credential!, transportSecret: current.transportSecret } : intent.credential!))
    }
    await assertCurrent(intent.personId, ensureCurrent)
  }
  if (intent.authority) {
    // PeerStore performs the durable monotonic merge and retains a newer admitted ledger.
    await context.write(() => peerStore.putWorkspaceAuthority(intent.authority!))
    await assertCurrent(intent.personId, ensureCurrent)
  }
  await assertCurrent(intent.personId, ensureCurrent)
  await registerWorkspaceInCurrentRoot(defaultStorage, profile, intent.workspaceId, grantHash)
  await assertCurrent(intent.personId, ensureCurrent)
  await readWorkspaceCatalogRecords()
  await assertCurrent(intent.personId, ensureCurrent)
  const key = await intentKey(intent.personId, intent.workspaceId, intent.recoveryId)
  const completed = { ...intent, status: "completed" as const }
  await store().updateRecords(STORE, [key], values => {
    ensureCurrent()
    const current = captureIntent(values[0], intent.personId)
    if (current.digest !== intent.digest || current.status !== "pending") throw new Error("Workspace recovery projection intent changed")
    return { writes: [{ key, value: completed }], result: undefined }
  })
  await assertCurrent(intent.personId, ensureCurrent)
}

/** Resume every current-person projection whose workspace journal transaction committed. */
export async function resumeWorkspaceHistoryRecoveryProjection(personId: string, ensureCurrent: () => void): Promise<void> {
  if (!validId(personId) || typeof ensureCurrent !== "function") throw new Error("Invalid workspace recovery projection session")
  await assertCurrent(personId, ensureCurrent)
  const database = store()
  const prefix = await personPrefix(personId)
  await assertCurrent(personId, ensureCurrent)
  let after: string | undefined
  let complete = false
  while (!complete) {
    const page = await database.scan<unknown>(STORE, prefix, after, 64)
    await assertCurrent(personId, ensureCurrent)
    for (const entry of page.entries) {
      const intent = captureIntent(entry.value)
      const expectedKey = await intentKey(intent.personId, intent.workspaceId, intent.recoveryId)
      if (entry.key !== expectedKey) throw new Error("Workspace recovery projection key binding mismatch")
      if (intent.personId !== personId || intent.status === "completed") continue
      if (await intentDigest(intentContent(intent)) !== intent.digest) throw new Error("Workspace recovery projection intent integrity check failed")
      await assertCurrent(personId, ensureCurrent)
      await project(intent, ensureCurrent)
    }
    if (page.nextAfter === null) { complete = true; continue }
    if (!page.entries.length || page.nextAfter !== page.entries.at(-1)?.key) throw new Error("Invalid workspace recovery projection page")
    after = page.nextAfter
  }
}
