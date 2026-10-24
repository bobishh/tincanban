import type { IdentityProfileState } from "./identityProfileState"
import type { AutomationGrantScope as MeshAutomationGrantScope } from "@meta-uber/mesh-workspace"

export type EntityId = string
export type WorkspaceId = string
export type PersonId = string // base64url SHA-256(raw identity public key)
export type DeviceId = string // base64url SHA-256(raw device public key)
export type ActorId = string // Automerge writer ID, never reused by parallel writers
type IsoTime = string
export type Hash = string
export type Heads = Hash[]

export type { Board, Column, FieldValue, PriorityRule, PriorityPolicy, CardAgingPolicy, Item, FieldDefinition, FileReference, AttachedDocument, DocumentTemplate, LegacyWritingTemplate, PdfArtifact, WorkspaceEntity, WorkspaceDocumentV2, EntityKind } from "./entitySchemas"
export { isItem, entityKind, hasEntityKind } from "./entitySchemas"
export { isValidRank } from "./rank"
export { validatePlacementParent, validateEntity, validateWorkspaceDoc } from "./validation"

export type PublicIdentity = {
  personId: PersonId
  publicKey: string // base64url raw Ed25519 public key
  displayName: string
}

export type RegisteredDevice = {
  deviceId: DeviceId
  publicKey: string
  displayName: string
  certificateHash: Hash
  addedAt: IsoTime
}

type WorkspaceReference = {
  workspaceId: WorkspaceId
  documentId: string
  grantHash: Hash
  forgotten: boolean // own catalog scope only, separate from shared archive state
}

export type PersonalRootDocumentV1 = {
  kind: "personal-root"
  formatVersion: 1
  rootId: string
  identity: PublicIdentity
  photo?: { avatarData: string | null; changedAt: string }
  profileState?: IdentityProfileState
  displayNamePreset?: string
  devices: Record<DeviceId, RegisteredDevice>
  workspaces: Record<WorkspaceId, WorkspaceReference>
  keeperIntegrations?: Record<string, KeeperIntegrationReference>
  pendingKeeperWithdrawals?: Record<string, {
    pairingId: string
    operationId: string
    pairing: unknown
    grantScopes?: Array<{ workspaceId: WorkspaceId; document: string; authorizationBundle: unknown; grant: unknown }>
    orphanResolution?: { verifiedAt: IsoTime; serviceRevision: number; integrationRevision: number;
      signedStatus: { payload: Record<string, unknown>; signerKeyId: string; signature: string };
      localRevocationScopes: Array<{ workspaceId: WorkspaceId; document: string; authorizationBundle: unknown }> }
  }>
}

/** Public, service-signed locator and policy cache; Rusty status remains authoritative. */
export type KeeperIntegrationReference = {
  integrationId: string
  serviceOrigin: string
  servicePersonId: PersonId
  serviceDeviceId: DeviceId
  servicePublicKey: string
  serviceCertificates: DeviceCertificate[]
  workspaceIds: WorkspaceId[]
  scopeReceipts?: Array<{ workspaceId: WorkspaceId; grantEpoch: number; activationOperationId: string }>
  futureBoards: boolean
  integrationSettingsSupported?: boolean
  /** Owner scopes present before this integration was approved; never auto-offer these later. */
  futureBoardBaselineIds?: WorkspaceId[]
  revision: number
  state: "active" | "removing" | "removed"
  verifiedAt: IsoTime
  pendingRemoval?: {
    operationId: string
    expectedRevision: number
    scopes: Array<{ workspaceId: WorkspaceId; expectedGrantEpoch: number }>
  }
  pendingSettings?: {
    operationId: string
    expectedRevision: number
    requestHash?: string
    futureBoards: boolean
    scopes: Array<{ workspaceId: WorkspaceId; expectedGrantEpoch: number }>
  }
  completedRemoval?: {
    operationId: string
    scopes: Array<{ workspaceId: WorkspaceId; grantEpoch: number }>
  }
}

export type TransactionMetadataV1 = {
  kind: "workspace-change-metadata"
  version: 1
  transactionId: string
  action: string
  entityIds: EntityId[]
  personId: PersonId
  deviceId: DeviceId
  authorityGrantHash?: string
  restoredFrom?: { baselineId: string; historyEpoch: number; changeHash: string; observation: "admitted" | "pending" | "quarantined" }
}

type SignedEnvelope<T> = {
  payload: T
  signerKeyId: PersonId | DeviceId
  signature: string // base64url signature of the canonical, domain-separated payload
}

export type DeviceCertificate = SignedEnvelope<{
  kind: "device-certificate"
  version: 1
  personId: PersonId
  deviceId: DeviceId
  devicePublicKey: string
  issuerCertificateHash: Hash | null // null means signed by identity authority
  canEnrollDevices: boolean
}>

export type ActorBinding = SignedEnvelope<{
  kind: "actor-binding"
  version: 1
  personId: PersonId
  deviceId: DeviceId
  documentId: string
  actorId: ActorId
}>

export type ChangeProof = SignedEnvelope<{
  kind: "change-proof"
  version: 1
  documentId: string
  changeHash: Hash
  actorBindingHash: Hash
}>

export type WorkspaceGrant = SignedEnvelope<{
  kind: "workspace-grant"
  version: 1
  grantId: string
  workspaceId: WorkspaceId
  personId: PersonId
  role: "owner" | "editor" | "visitor" | "automation"
  accessEpoch?: number
  automation?: AutomationGrantScope
}>

export type AutomationGrantScope = MeshAutomationGrantScope

export type WorkspaceGenesis = SignedEnvelope<{
  kind: "workspace-genesis"
  version: 1
  workspaceId: WorkspaceId
  ownerPersonId: PersonId
  initialHeads: Heads
  legacyCheckpoint: boolean
}>

export type ProjectionIssue =
  | { type: "missing-parent"; entityId: EntityId; parentId: EntityId }
  | { type: "invalid-parent-kind"; entityId: EntityId; parentId: EntityId | null }
  | { type: "cycle"; entityId: EntityId; cycleIds: EntityId[] }
  | { type: "invalid-field-value"; entityId: EntityId; fieldId: EntityId }

export type TransactionReceipt = {
  transactionId: string
  beforeHeads: Heads
  afterHeads: Heads
  changeHash: Hash
  changedEntityIds: EntityId[]
  saved: true
}

export type CommandErrorCode =
  | "invalid_input"
  | "not_found"
  | "invalid_parent"
  | "cycle"
  | "cross_board_move"
  | "field_type_change"
  | "hidden_ancestor"
  | "permission_denied"
  | "storage_failed"
  | "unsupported_format"
  | "conflict"
  | "identity_conflict"
  | "migration_conflict"
  | "invalid_proof"
  | "invite_expired"
  | "invite_consumed"
  | "invite_cancelled"

export type CommandResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: CommandErrorCode; message: string; field?: string } }
