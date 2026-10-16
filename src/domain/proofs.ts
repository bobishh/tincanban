import type {
  DeviceCertificate,
  ActorBinding,
  ChangeProof,
  WorkspaceGrant,
  AutomationGrantScope,
  WorkspaceGenesis,
  PersonId,
  DeviceId,
  WorkspaceId,
  Heads,
  Hash,
} from "./model"
import {
  canonicalizeJson,
  sha256Base64Url,
  signEnvelope,
  verifyEnvelope,
} from "./identityCrypto"
import type { LocalProfile } from "./identity"
import { signWithContext, type VerifiedSigningContext } from "./signingContext"
import { readLocal, updateLocal } from "../localDb"
export { certHashDefault, validateCertificateChain } from "./proofValidation"
export type { ChainValidationOptions, ChainValidationResult } from "./proofValidation"

export type StoredProofsV1 = {
  grants: WorkspaceGrant[]
  certificates: DeviceCertificate[]
  actorBindings: ActorBinding[]
  changeProofs: ChangeProof[]
}

type StoredProofData = {
  actorBindings: Record<string, ActorBinding>
  changeProofs: Record<string, ChangeProof>
  certificates: Record<string, DeviceCertificate>
  genesis: Record<string, WorkspaceGenesis>
  grants: Record<string, WorkspaceGrant>
}
const proofStoreKey = "tincanban.v1.proof_store"

function emptyStoredProofData(): StoredProofData {
  return { grants: {}, certificates: {}, actorBindings: {}, changeProofs: {}, genesis: {} }
}

function decodeStoredProofData(raw: string | null): StoredProofData {
  if (raw === null) return emptyStoredProofData()
  let parsed: Partial<StoredProofData>
  try { parsed = JSON.parse(raw) as Partial<StoredProofData> }
  catch { throw new Error("Stored proof evidence is invalid") }
  const known = ["actorBindings", "changeProofs", "certificates", "genesis", "grants"]
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some(key => !known.includes(key))) {
    throw new Error("Stored proof evidence requires an upgrade")
  }
  const records = <T>(value: unknown): Record<string, T> => {
    if (value === undefined) return {}
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored proof evidence table is invalid")
    return value as Record<string, T>
  }
  return { actorBindings: records(parsed.actorBindings), changeProofs: records(parsed.changeProofs),
    certificates: records(parsed.certificates), genesis: records(parsed.genesis), grants: records(parsed.grants) }
}

export async function createDelegatedCertificate(
  delegatorDevicePrivateKey: CryptoKey,
  delegatorDeviceId: DeviceId,
  personId: PersonId,
  subjectDeviceId: DeviceId,
  subjectDevicePublicKey: string,
  issuerCertificateHash: Hash
): Promise<DeviceCertificate> {
  const payload = {
    kind: "device-certificate" as const,
    version: 1 as const,
    personId,
    deviceId: subjectDeviceId,
    devicePublicKey: subjectDevicePublicKey,
    issuerCertificateHash,
    canEnrollDevices: true as const,
  }

  return (await signEnvelope(
    delegatorDevicePrivateKey,
    payload,
    delegatorDeviceId
  )) as unknown as DeviceCertificate
}

export async function createWorkspaceGenesis(
  profile: LocalProfile,
  workspaceId: WorkspaceId,
  initialHeads: Heads,
  legacyCheckpoint = false
): Promise<WorkspaceGenesis> {
  const payload = {
    kind: "workspace-genesis" as const,
    version: 1 as const,
    workspaceId,
    ownerPersonId: profile.identity.personId,
    initialHeads,
    legacyCheckpoint,
  }

  const signerKey = profile.privateKeys.identityPrivateKey ?? profile.privateKeys.devicePrivateKey
  const signerId = profile.privateKeys.identityPrivateKey ? profile.identity.personId : profile.device.deviceId

  return (await signEnvelope(signerKey, payload, signerId)) as unknown as WorkspaceGenesis
}

export async function verifyWorkspaceGenesis(
  genesis: WorkspaceGenesis,
  publicKey: string
): Promise<boolean> {
  return verifyEnvelope(genesis, publicKey)
}

export async function createWorkspaceGrant(
  profile: LocalProfile,
  workspaceId: WorkspaceId,
  subjectPersonId: PersonId,
  role: "owner" | "editor" | "visitor",
  accessEpoch = 1,
  signingContext?: VerifiedSigningContext,
): Promise<WorkspaceGrant> {
  if (role !== "owner" && role !== "editor" && role !== "visitor") throw new TypeError("Use createAutomationWorkspaceGrant for automation access")
  if (signingContext && (signingContext.personId !== profile.identity.personId || signingContext.deviceId !== profile.device.deviceId)) {
    throw new Error("Workspace grant signing context belongs to another owner device")
  }
  const payload = {
    kind: "workspace-grant" as const,
    version: 1 as const,
    grantId: crypto.randomUUID(),
    workspaceId,
    personId: subjectPersonId,
    role,
    accessEpoch,
  }

  return (signingContext ? await signWithContext(signingContext, payload) : await signEnvelope(
    profile.privateKeys.devicePrivateKey,
    payload,
    profile.device.deviceId
  )) as unknown as WorkspaceGrant
}

export async function createAutomationWorkspaceGrant(
  profile: LocalProfile,
  workspaceId: WorkspaceId,
  subjectPersonId: PersonId,
  automation: AutomationGrantScope,
  accessEpoch = 1,
  signingContext?: VerifiedSigningContext,
): Promise<WorkspaceGrant> {
  if (signingContext && (signingContext.personId !== profile.identity.personId || signingContext.deviceId !== profile.device.deviceId)) {
    throw new Error("Automation grant signing context belongs to another owner device")
  }
  automation = structuredClone(automation)
  assertAutomationGrantScope(automation, Date.now())
  if (!workspaceId || !subjectPersonId || !Number.isSafeInteger(accessEpoch) || accessEpoch < 1) {
    throw new TypeError("Invalid automation workspace grant")
  }
  const payload = {
    kind: "workspace-grant" as const,
    version: 1 as const,
    grantId: crypto.randomUUID(),
    workspaceId,
    personId: subjectPersonId,
    role: "automation" as const,
    accessEpoch,
    automation,
  }
  return (signingContext ? await signWithContext(signingContext, payload)
    : await signEnvelope(profile.privateKeys.devicePrivateKey, payload, profile.device.deviceId)) as unknown as WorkspaceGrant
}

function exactAutomationKeys(value: object, expected: string[]): boolean {
  const keys = Object.keys(value).sort()
  const sorted = expected.slice().sort()
  return keys.length === expected.length && keys.every((key, index) => key === sorted[index])
}
function validAutomationColumns(columns: AutomationGrantScope["columns"]): boolean {
  if (!columns || !exactAutomationKeys(columns, ["lead", "interview", "rejected", ...(columns.applied === undefined ? [] : ["applied"])])) return false
  const ids = [columns.lead, columns.interview, columns.rejected, ...(columns.applied === undefined ? [] : [columns.applied])]
  return ids.every(id => typeof id === "string" && Boolean(id)) && new Set(ids).size === ids.length
}
function validAutomationFields(ids: AutomationGrantScope["fieldIds"]): boolean {
  return Array.isArray(ids) && ids.length <= 128 && ids.every(id => typeof id === "string" && Boolean(id)) && new Set(ids).size === ids.length
}
function assertAutomationGrantScope(scope: AutomationGrantScope, now: number): void {
  if (!scope || !exactAutomationKeys(scope, ["version", "boardId", "columns", "fieldIds", "expiresAt"]) ||
    ![1, 2].includes(scope.version) || typeof scope.boardId !== "string" || !scope.boardId.trim() ||
    !validAutomationColumns(scope.columns) || !validAutomationFields(scope.fieldIds) ||
    !Number.isSafeInteger(scope.expiresAt) || scope.expiresAt <= now) {
    throw new TypeError("Invalid automation grant scope")
  }
}

export async function verifyWorkspaceGrant(
  grant: WorkspaceGrant,
  publicKey: string
): Promise<boolean> {
  if (grant?.payload?.role === "automation") {
    try { assertAutomationGrantScope(grant.payload.automation!, Date.now()) }
    catch { return false }
  } else if (!grant?.payload || grant.payload.automation !== undefined ||
    !["owner", "editor", "visitor"].includes(grant.payload.role)) return false
  return verifyEnvelope(grant, publicKey)
}

export class ProofStore {
  private readonly loaded: Promise<void>
  private readonly persist: boolean
  private actorBindings = new Map<string, ActorBinding>()
  private changeProofs = new Map<string, ChangeProof>()
  private certificates = new Map<string, DeviceCertificate>()
  private genesis = new Map<string, WorkspaceGenesis>()
  private grants = new Map<string, WorkspaceGrant>()

  constructor(persist = true) {
    this.persist = persist
    this.loaded = persist ? this.load() : Promise.resolve()
  }

  private replace(data: StoredProofData): void {
    this.actorBindings = new Map(Object.entries(data.actorBindings) as [string, ActorBinding][])
    this.changeProofs = new Map(Object.entries(data.changeProofs) as [string, ChangeProof][])
    this.certificates = new Map(Object.entries(data.certificates) as [string, DeviceCertificate][])
    this.genesis = new Map(Object.entries(data.genesis) as [string, WorkspaceGenesis][])
    this.grants = new Map(Object.entries(data.grants) as [string, WorkspaceGrant][])
  }

  private async load() {
    this.replace(decodeStoredProofData(await readLocal(proofStoreKey)))
  }

  private async mutate(change: (data: StoredProofData) => void): Promise<void> {
    await this.loaded
    if (!this.persist) {
      const data = {
        actorBindings: Object.fromEntries(this.actorBindings), changeProofs: Object.fromEntries(this.changeProofs),
        certificates: Object.fromEntries(this.certificates), genesis: Object.fromEntries(this.genesis), grants: Object.fromEntries(this.grants),
      }
      change(data)
      this.replace(data)
      return
    }
    let updated: StoredProofData | undefined
    await updateLocal(proofStoreKey, raw => {
      const data = decodeStoredProofData(raw)
      change(data)
      updated = data
      return JSON.stringify(data)
    })
    this.replace(updated!)
  }

  async putActorBinding(hash: string, binding: ActorBinding): Promise<void> {
    const snapshot = structuredClone(binding)
    await this.mutate(data => { data.actorBindings[hash] = snapshot })
  }

  async getActorBinding(hash: string): Promise<ActorBinding | null> {
    await this.loaded
    const value = this.actorBindings.get(hash)
    return value ? structuredClone(value) : null
  }

  async putChangeProof(hash: string, proof: ChangeProof): Promise<void> {
    const snapshot = structuredClone(proof)
    await this.mutate(data => { data.changeProofs[hash] = snapshot })
  }

  async getChangeProof(hash: string): Promise<ChangeProof | null> {
    await this.loaded
    const value = this.changeProofs.get(hash)
    return value ? structuredClone(value) : null
  }

  async listChangeProofs(): Promise<ChangeProof[]> {
    await this.loaded
    return structuredClone(Array.from(this.changeProofs.values()))
  }

  async putCertificate(hash: string, cert: DeviceCertificate): Promise<void> {
    const snapshot = structuredClone(cert)
    await this.mutate(data => { data.certificates[hash] = snapshot })
  }

  async getCertificate(hash: string): Promise<DeviceCertificate | null> {
    await this.loaded
    const value = this.certificates.get(hash)
    return value ? structuredClone(value) : null
  }

  async listCertificates(): Promise<DeviceCertificate[]> {
    await this.loaded
    return structuredClone(Array.from(this.certificates.values()))
  }

  async putGenesis(workspaceId: string, gen: WorkspaceGenesis): Promise<void> {
    const snapshot = structuredClone(gen)
    await this.mutate(data => { data.genesis[workspaceId] = snapshot })
  }

  async getGenesis(workspaceId: string): Promise<WorkspaceGenesis | null> {
    await this.loaded
    const value = this.genesis.get(workspaceId)
    return value ? structuredClone(value) : null
  }

  async putGrant(grantId: string, grant: WorkspaceGrant): Promise<void> {
    const snapshot = structuredClone(grant)
    await this.mutate(data => { data.grants[grantId] = snapshot })
  }

  async getGrant(grantId: string): Promise<WorkspaceGrant | null> {
    await this.loaded
    const value = this.grants.get(grantId)
    return value ? structuredClone(value) : null
  }

  async listGrants(workspaceId?: string): Promise<WorkspaceGrant[]> {
    await this.loaded
    const list = structuredClone(Array.from(this.grants.values()))
    if (!workspaceId) return list
    return list.filter((g) => g.payload.workspaceId === workspaceId)
  }

  async removeWorkspaceGrants(workspaceId: string): Promise<void> {
    if (!workspaceId) throw new Error("Invalid workspaceId")
    await this.mutate(data => {
      for (const [grantId, grant] of Object.entries(data.grants)) {
        if ((grant as WorkspaceGrant).payload.workspaceId === workspaceId) delete data.grants[grantId]
      }
    })
  }
}

export const defaultProofStore = new ProofStore()
