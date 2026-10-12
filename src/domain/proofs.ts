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
  type LocalProfile,
} from "./identity"
import { readLocal, writeLocal } from "../localDb"

export type ChainValidationResult =
  | { ok: true }
  | { ok: false; error: string }

export type StoredProofsV1 = {
  grants: WorkspaceGrant[]
  certificates: DeviceCertificate[]
  actorBindings: ActorBinding[]
  changeProofs: ChangeProof[]
}

export type ChainValidationOptions = {
  hashFn?: (cert: DeviceCertificate) => string | Promise<string>
  skipSigVerify?: boolean
}

export async function certHashDefault(cert: DeviceCertificate): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeJson(cert))
  return sha256Base64Url(bytes)
}

export async function validateCertificateChain(
  cert: DeviceCertificate,
  identityPublicKey: string,
  certPool: DeviceCertificate[],
  options: ChainValidationOptions = {}
): Promise<ChainValidationResult> {
  const getHash = options.hashFn ?? certHashDefault
  let current = cert
  const visited = new Set<string>()
  let depth = 0

  while (current) {
    depth++
    if (depth > 32) {
      return { ok: false, error: "Certificate chain depth exceeds limit 32" }
    }

    const currentHash = await getHash(current)
    if (visited.has(currentHash)) {
      return { ok: false, error: "Cycle detected in certificate chain" }
    }
    visited.add(currentHash)

    if (current.payload.issuerCertificateHash === null) {
      return verifyRootCertificate(current, identityPublicKey, options.skipSigVerify)
    }

    // Delegated certificate: find issuer by hash
    const issuerHash = current.payload.issuerCertificateHash
    if (visited.has(issuerHash)) {
      return { ok: false, error: "Cycle detected in certificate chain" }
    }

    const issuer = await findCertificate(certPool, issuerHash, getHash)

    if (!issuer) {
      return { ok: false, error: `Missing issuer certificate for hash ${issuerHash}` }
    }

    const delegation = await validateDelegation(current, issuer, options.skipSigVerify)
    if (!delegation.ok) return delegation

    current = issuer
  }

  return { ok: true }
}

async function verifyRootCertificate(cert: DeviceCertificate, publicKey: string, skipVerify?: boolean): Promise<ChainValidationResult> {
  if (skipVerify || await verifyEnvelope(cert, publicKey)) return { ok: true }
  return { ok: false, error: "Root certificate signature invalid" }
}

async function findCertificate(pool: DeviceCertificate[], hash: string, getHash: NonNullable<ChainValidationOptions["hashFn"]>): Promise<DeviceCertificate | undefined> {
  for (const certificate of pool) if (await getHash(certificate) === hash) return certificate
  return undefined
}

async function validateDelegation(current: DeviceCertificate, issuer: DeviceCertificate, skipVerify?: boolean): Promise<ChainValidationResult> {
  if (issuer.payload.personId !== current.payload.personId) return { ok: false, error: "Issuer personId does not match subject personId" }
  if (!issuer.payload.canEnrollDevices) return { ok: false, error: "Issuer certificate lacks canEnrollDevices capability" }
  if (skipVerify || await verifyEnvelope(current, issuer.payload.devicePublicKey)) return { ok: true }
  return { ok: false, error: "Certificate signature invalid under issuer key" }
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
): Promise<WorkspaceGrant> {
  if (role !== "owner" && role !== "editor" && role !== "visitor") throw new TypeError("Use createAutomationWorkspaceGrant for automation access")
  const payload = {
    kind: "workspace-grant" as const,
    version: 1 as const,
    grantId: crypto.randomUUID(),
    workspaceId,
    personId: subjectPersonId,
    role,
    accessEpoch,
  }

  return (await signEnvelope(
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
): Promise<WorkspaceGrant> {
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
  return (await signEnvelope(profile.privateKeys.devicePrivateKey, payload, profile.device.deviceId)) as unknown as WorkspaceGrant
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
    scope.version !== 1 || typeof scope.boardId !== "string" || !scope.boardId.trim() ||
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

  private async load() {
    const raw = await readLocal("tincanban.v1.proof_store")
    if (raw) {
      try {
        const data = JSON.parse(raw)
        if (data.actorBindings) this.actorBindings = new Map(Object.entries(data.actorBindings))
        if (data.changeProofs) this.changeProofs = new Map(Object.entries(data.changeProofs))
        if (data.certificates) this.certificates = new Map(Object.entries(data.certificates))
        if (data.genesis) this.genesis = new Map(Object.entries(data.genesis))
        if (data.grants) this.grants = new Map(Object.entries(data.grants))
      } catch { return }
    }
  }

  private async save() {
    if (!this.persist) return
    await this.loaded
      const data = {
        actorBindings: Object.fromEntries(this.actorBindings),
        changeProofs: Object.fromEntries(this.changeProofs),
        certificates: Object.fromEntries(this.certificates),
        genesis: Object.fromEntries(this.genesis),
        grants: Object.fromEntries(this.grants),
      }
      await writeLocal("tincanban.v1.proof_store", JSON.stringify(data))
  }

  async putActorBinding(hash: string, binding: ActorBinding): Promise<void> {
    await this.loaded
    this.actorBindings.set(hash, binding)
    await this.save()
  }

  async getActorBinding(hash: string): Promise<ActorBinding | null> {
    await this.loaded
    return this.actorBindings.get(hash) ?? null
  }

  async putChangeProof(hash: string, proof: ChangeProof): Promise<void> {
    await this.loaded
    this.changeProofs.set(hash, proof)
    await this.save()
  }

  async getChangeProof(hash: string): Promise<ChangeProof | null> {
    await this.loaded
    return this.changeProofs.get(hash) ?? null
  }

  async listChangeProofs(): Promise<ChangeProof[]> {
    await this.loaded
    return Array.from(this.changeProofs.values())
  }

  async putCertificate(hash: string, cert: DeviceCertificate): Promise<void> {
    await this.loaded
    this.certificates.set(hash, cert)
    await this.save()
  }

  async getCertificate(hash: string): Promise<DeviceCertificate | null> {
    await this.loaded
    return this.certificates.get(hash) ?? null
  }

  async listCertificates(): Promise<DeviceCertificate[]> {
    await this.loaded
    return Array.from(this.certificates.values())
  }

  async putGenesis(workspaceId: string, gen: WorkspaceGenesis): Promise<void> {
    await this.loaded
    this.genesis.set(workspaceId, gen)
    await this.save()
  }

  async getGenesis(workspaceId: string): Promise<WorkspaceGenesis | null> {
    await this.loaded
    return this.genesis.get(workspaceId) ?? null
  }

  async putGrant(grantId: string, grant: WorkspaceGrant): Promise<void> {
    await this.loaded
    this.grants.set(grantId, grant)
    await this.save()
  }

  async getGrant(grantId: string): Promise<WorkspaceGrant | null> {
    await this.loaded
    return this.grants.get(grantId) ?? null
  }

  async listGrants(workspaceId?: string): Promise<WorkspaceGrant[]> {
    await this.loaded
    const list = Array.from(this.grants.values())
    if (!workspaceId) return list
    return list.filter((g) => g.payload.workspaceId === workspaceId)
  }

  async removeWorkspaceGrants(workspaceId: string): Promise<void> {
    await this.loaded
    if (!workspaceId) throw new Error("Invalid workspaceId")
    for (const [grantId, grant] of this.grants) {
      if (grant.payload.workspaceId === workspaceId) this.grants.delete(grantId)
    }
    await this.save()
  }
}

export const defaultProofStore = new ProofStore()
