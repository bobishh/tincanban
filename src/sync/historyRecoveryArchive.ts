import { canonicalizeJson, sha256Base64Url, toBase64Url } from "../domain/identity"
import { isValidBlobId } from "@meta-uber/mesh-blob"
import { validateArchiveObjectId } from "@meta-uber/mesh-replication/history-archive"
import { iterateArchiveLocatorEntries, type ArchiveLocatorRoot } from "@meta-uber/mesh-replication/history-archive-locators"
import { captureArchiveEncryptionScope, captureEncryptedArchiveObject,
  type ArchiveEncryptionScope, type EncryptedArchiveObject } from "@meta-uber/mesh-replication/history-archive-crypto"

export type HistoryRecoveryArchiveSource = {
  id: string; workspaceId: string; scope: ArchiveEncryptionScope; roots: ArchiveLocatorRoot[]
  signedJson: Uint8Array; authorityEvidence: unknown
}
export type HistoryRecoveryManifest = {
  kind: "history-recovery-manifest"; version: 1; workspaceId: string; coverage: "complete" | "incomplete"
  sourceCount: number; objectCount: number; encryptedBytes: number; transcriptDigest: string
  missingObjects: Array<{ scopeId: string; ciphertextId: string }>
  unresolvedDirectories: Array<{ sourceId: string; ciphertextId: string }>
  evidencePartCount?: number
  missingAttachmentIds?: string[]
  missingPeerObjects?: Array<{ baselineId: string; objectId: string }>
}
export type HistoryRecoveryEvidencePart = { kind: "local-evidence-part"; category: string; id: string;
  partIndex: number; partCount: number; data: string }
export type HistoryRecoveryRecord = {
  kind: "archive-source"; id: string; workspaceId: string; scopeId: string; keyEpoch: number; key: string
  roots: ArchiveLocatorRoot[]; signedJson: string; authorityEvidence: unknown
} | { kind: "encrypted-object"; scopeId: string; ciphertextId: string; object: EncryptedArchiveObject } | HistoryRecoveryEvidencePart | HistoryRecoveryManifest
type ExportPorts = {
  ensureCurrent(): void | Promise<void>
  /** Caller supplies the encrypted private-backup sink. This stream contains reading keys and must never enter a public workspace bundle. */
  write(record: HistoryRecoveryRecord): Promise<void>
  download(source: HistoryRecoveryArchiveSource, ciphertextId: string): Promise<EncryptedArchiveObject | undefined>
  evidence?: AsyncIterable<HistoryRecoveryEvidencePart>
  unavailableAttachments?: () => string[]
  unavailablePeerObjects?: () => Array<{ baselineId: string; objectId: string }>
}
class MissingObject extends Error {
  constructor(readonly ciphertextId: string) { super("History archive object unavailable") }
}
const encoder = new TextEncoder()
const MAX_OBJECTS = 1_048_576
const MAX_BYTES = 512 * 1024 * 1024
const MAX_MISSING = 4096

function captureMissingPeerObject(input: unknown): { baselineId: string; objectId: string } {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2 ||
      !Object.hasOwn(input, "baselineId") || !Object.hasOwn(input, "objectId")) throw new Error("Invalid missing peer history object")
  const value = structuredClone(input) as { baselineId: string; objectId: string }
  try { validateArchiveObjectId(value.baselineId); validateArchiveObjectId(value.objectId) }
  catch { throw new Error("Invalid missing peer history object identifier") }
  return value
}
/** Optional field is present only for a nonempty canonical set; writer and opener share this validation. */
export function captureMissingPeerObjects(input: unknown): NonNullable<HistoryRecoveryManifest["missingPeerObjects"]> {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_MISSING) throw new Error("Invalid missing peer history coverage")
  let previous = ""
  return input.map(entry => {
    const value = captureMissingPeerObject(entry), key = `${value.baselineId}:${value.objectId}`
    if (key <= previous) throw new Error("Missing peer history coverage is not unique and canonically sorted")
    previous = key
    return value
  })
}

function assertArchiveSource(source: HistoryRecoveryArchiveSource, workspaceId: string, sourceIds: Set<string>): void {
    if (!source || source.workspaceId !== workspaceId || typeof source.id !== "string" || !source.id || source.id.length > 256 ||
      sourceIds.has(source.id) || !(source.signedJson instanceof Uint8Array) || source.signedJson.length > 256 * 1024 ||
      !Array.isArray(source.roots) || source.roots.length < 1 || source.roots.length > 4) throw new Error("Invalid recovery archive source")
}

function unavailableExportCoverage(ports: ExportPorts) {
  const missingAttachmentIds = [...new Set(ports.unavailableAttachments?.() ?? [])].sort()
  if (missingAttachmentIds.length > 1024 || missingAttachmentIds.some(id => typeof id !== "string" || !isValidBlobId(id))) throw new Error("Invalid missing attachment coverage")
  const unavailablePeerObjects = structuredClone(ports.unavailablePeerObjects?.() ?? [])
  if (!Array.isArray(unavailablePeerObjects) || unavailablePeerObjects.length > MAX_MISSING) throw new Error("Invalid missing peer history coverage")
  const peerPairs = new Map(unavailablePeerObjects.map(input => {
    const value = captureMissingPeerObject(input)
    return [`${value.baselineId}:${value.objectId}`, value] as const
  }))
  const missingPeerObjects = [...peerPairs].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, value]) => value)
  return { missingAttachmentIds, missingPeerObjects }
}

class PrivateHistoryExport {
  private readonly sourceIds = new Set<string>()
  private readonly objects = new Map<string, string>()
  private readonly completedRoots = new Set<string>()
  private readonly missing = new Map<string, { scopeId: string; ciphertextId: string }>()
  private readonly unresolvedDirectories: HistoryRecoveryManifest["unresolvedDirectories"] = []
  private encryptedBytes = 0
  private recordBytes = 0
  private evidencePartCount = 0
  private transcriptDigest = sha256Base64Url(encoder.encode("tincanban/history-recovery/v1"))
  constructor(private readonly workspaceId: string, private readonly ports: ExportPorts) {}

  private async guard(): Promise<void> {
    if (await this.ports.ensureCurrent() !== undefined) throw new Error("Invalid private export guard")
  }
  private async write(record: Exclude<HistoryRecoveryRecord, HistoryRecoveryManifest>): Promise<void> {
    await this.guard()
    const detached = structuredClone(record), encoded = canonicalizeJson(detached)
    this.recordBytes += encoder.encode(encoded).byteLength
    if (this.recordBytes > MAX_BYTES) throw new Error("Private history export exceeds total size limit")
    this.transcriptDigest = sha256Base64Url(encoder.encode(canonicalizeJson([await this.transcriptDigest, await sha256Base64Url(encoder.encode(encoded))])))
    await this.guard(); await this.ports.write(detached); await this.guard()
  }
  async evidence(): Promise<void> {
  if (this.ports.evidence) for await (const part of this.ports.evidence) {
    assertLocalEvidencePart(part)
    if (++this.evidencePartCount > MAX_OBJECTS) throw new Error("Too many local recovery evidence parts")
    await this.write(part)
  }
  }
  private async retain(scope: ArchiveEncryptionScope, id: string, input: EncryptedArchiveObject): Promise<EncryptedArchiveObject> {
      await this.guard()
      const object = captureEncryptedArchiveObject(input, scope.scopeId), encoded = canonicalizeJson(object)
      if (object.keyEpoch !== scope.keyEpoch || await sha256Base64Url(encoder.encode(encoded)) !== id) throw new Error("Recovery archive ciphertext hash or epoch mismatch")
      const identity = `${scope.scopeId}/${id}`, fingerprint = await sha256Base64Url(encoder.encode(encoded)), old = this.objects.get(identity)
      if (old !== undefined && old !== fingerprint) throw new Error("Recovery archive ciphertext changed during export")
      if (old === undefined) {
        this.encryptedBytes += encoder.encode(encoded).byteLength
        if (this.objects.size >= MAX_OBJECTS || this.encryptedBytes > MAX_BYTES) throw new Error("Private history export exceeds size limit")
        await this.write({ kind: "encrypted-object", scopeId: scope.scopeId, ciphertextId: id, object })
        this.objects.set(identity, fingerprint)
      }
      this.missing.delete(identity)
      return object
    }
  private async download(source: HistoryRecoveryArchiveSource, scope: ArchiveEncryptionScope, id: string): Promise<EncryptedArchiveObject | undefined> {
      await this.guard()
      const object = await this.ports.download(structuredClone(source), id)
      await this.guard()
      if (object === undefined) {
        if (this.missing.size >= MAX_MISSING && !this.missing.has(`${scope.scopeId}/${id}`)) throw new Error("Too many missing archive objects; incomplete export stopped")
        this.missing.set(`${scope.scopeId}/${id}`, { scopeId: scope.scopeId, ciphertextId: id })
        return undefined
      }
      return this.retain(scope, id, object)
    }
  async source(source: HistoryRecoveryArchiveSource): Promise<void> {
    assertArchiveSource(source, this.workspaceId, this.sourceIds)
    this.sourceIds.add(source.id)
    const scope = captureArchiveEncryptionScope(source.scope)
    try {
    if (encoder.encode(canonicalizeJson(source.authorityEvidence)).length > 2 * 1024 * 1024) throw new Error("Recovery authority evidence exceeds size limit")
    await this.write({ kind: "archive-source", id: source.id, workspaceId: this.workspaceId, scopeId: scope.scopeId, keyEpoch: scope.keyEpoch,
      key: toBase64Url(scope.key), roots: source.roots, signedJson: toBase64Url(source.signedJson), authorityEvidence: source.authorityEvidence })
    for (const root of source.roots) {
      if (root.context.workspaceId !== this.workspaceId) throw new Error("Recovery directory belongs to another workspace")
      // Signed generations often retain the same directory. Its content-addressed
      // bytes are already in the encrypted stream; keep the source, not another traversal.
      const rootIdentity = canonicalizeJson([scope.scopeId, scope.keyEpoch, toBase64Url(scope.key), root])
      if (this.completedRoots.has(rootIdentity)) continue
      try {
        let complete = true
        for await (const entry of iterateArchiveLocatorEntries(scope, root, {
          ensureCurrent: () => this.guard(), download: async id => { const object = await this.download(source, scope, id); if (!object) throw new MissingObject(id); return object },
        })) complete = await this.download(source, scope, entry.ciphertextId) !== undefined && complete
        // A later source may supply bytes missing from this source's local or remote copy.
        if (complete) this.completedRoots.add(rootIdentity)
      } catch (error) {
        if (!(error instanceof MissingObject)) throw error
        this.unresolvedDirectories.push({ sourceId: source.id, ciphertextId: error.ciphertextId })
      }
    }
    } finally { scope.key.fill(0) }
  }
  async finish(): Promise<HistoryRecoveryManifest> {
  const { missingAttachmentIds, missingPeerObjects } = unavailableExportCoverage(this.ports)
  const manifest: HistoryRecoveryManifest = { kind: "history-recovery-manifest", version: 1, workspaceId: this.workspaceId,
    coverage: this.missing.size || this.unresolvedDirectories.length || missingAttachmentIds.length || missingPeerObjects.length ? "incomplete" : "complete", sourceCount: this.sourceIds.size,
    objectCount: this.objects.size, encryptedBytes: this.encryptedBytes, transcriptDigest: await this.transcriptDigest, ...(this.evidencePartCount ? { evidencePartCount: this.evidencePartCount } : {}), missingObjects: [...this.missing.values()].sort((a, b) => {
      const left = `${a.scopeId}/${a.ciphertextId}`, right = `${b.scopeId}/${b.ciphertextId}`
      return left < right ? -1 : left > right ? 1 : 0
    }), unresolvedDirectories: this.unresolvedDirectories,
    ...(missingAttachmentIds.length ? { missingAttachmentIds } : {}),
    ...(missingPeerObjects.length ? { missingPeerObjects: captureMissingPeerObjects(missingPeerObjects) } : {}) }
  await this.guard(); await this.ports.write(structuredClone(manifest)); await this.guard()
  return manifest
  }
}

function assertLocalEvidencePart(part: HistoryRecoveryEvidencePart): void {
    if (part.kind !== "local-evidence-part" || !/^[A-Za-z0-9_-]{1,64}$/.test(part.category) ||
      typeof part.id !== "string" || !part.id || part.id.length > 512 || !Number.isSafeInteger(part.partCount) || part.partCount < 1 ||
      part.partCount > MAX_OBJECTS || !Number.isSafeInteger(part.partIndex) || part.partIndex < 0 || part.partIndex >= part.partCount ||
      typeof part.data !== "string" || !/^[A-Za-z0-9_-]*$/.test(part.data) || part.data.length > Math.ceil(256 * 1024 * 4 / 3)) {
      throw new Error("Invalid local recovery evidence part")
    }
 }

/** Explicit full recovery export only. Completeness describes retained bytes, never grants history admission authority. */
export async function exportHistoryRecoveryArchive(workspaceId: string, inputs: HistoryRecoveryArchiveSource[], ports: ExportPorts): Promise<HistoryRecoveryManifest> {
  if (!workspaceId || workspaceId.length > 256 || !Array.isArray(inputs) || inputs.length > 256 ||
    typeof ports?.ensureCurrent !== "function" || typeof ports.write !== "function" || typeof ports.download !== "function") throw new Error("Invalid private history export")
  const session = new PrivateHistoryExport(workspaceId, ports)
  const sources = structuredClone(inputs)
  await session.evidence()
  for (const source of sources) await session.source(source)
  return session.finish()
}
