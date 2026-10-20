/**
 * Reference contract for the planned implementation; not application runtime.
 * Runtime validators must enforce the documented formats and references.
 * IDs are strings to preserve legacy IDs. New record IDs must be UUIDv4.
 */
export type EntityId = string
export type WorkspaceId = string
export type PersonId = string // base64url SHA-256(raw identity public key)
export type DeviceId = string // base64url SHA-256(raw device public key)
export type ActorId = string // Automerge writer ID, never reused by parallel writers
export type IsoTime = string
export type Rank = string // canonical reduced rational: signed numerator/positive denominator
export type Hash = string
export type Heads = Hash[]

export type Placement = Readonly<{ parentId: EntityId | null; rank: Rank }>

export type EntityBase = {
  id: EntityId
  title: string
  placement: Placement
  archivedAt: IsoTime | null
  createdAt: IsoTime
  updatedAt: IsoTime // display only; never used to resolve conflicts
}

export type Board = EntityBase & {
  kind: "board"
  entityName?: string
  preset: null | {
    key: "job-search" | "blank"
    version: 1
    /** Stable preset keys -> seeded IDs; rename never changes IDs. */
    bindings: Record<string, EntityId>
  }
}

export type Column = EntityBase & {
  kind: "column"
  archive?: true
}

export type FieldValue = string | number | boolean | null

export type Item = EntityBase & {
  body: string
  values: Record<EntityId, FieldValue>
}

export type FieldOption = {
  id: EntityId
  title: string
  rank: Rank
  archivedAt: IsoTime | null
}

export type FieldDefinition = EntityBase & {
  kind: "field"
  required: boolean
} & (
  | { valueType: "text" | "url" | "date" | "datetime" | "boolean" }
  | { valueType: "number"; min: number | null; max: number | null }
  | { valueType: "select"; options: Record<EntityId, FieldOption> }
)

export type FileReference =
  | { type: "blob"; sha256: Hash; byteLength: number; mimeType: string; fileName: string }
  | { type: "local-file"; fileId: EntityId; fileName: string }

export type AttachedDocument = EntityBase & {
  kind: "document"
  documentKind: "cv" | "cover_letter" | "note" | "attachment"
  format: "markdown" | "html" | "pdf" | "path"
  content: string | null
  file: FileReference | null
}

export type DocumentTemplate = EntityBase & {
  kind: "document_template"
  markdown: string
}

export type LegacyWritingTemplate = EntityBase & {
  kind: "template"
  markdown: string
  templateKind?: string
}

export type PdfArtifact = EntityBase & {
  kind: "artifact"
  artifactKind: "cv" | "cover_letter"
  templateId: EntityId
  pdf: FileReference
  sourceMarkdown: FileReference | null
}

export type WorkspaceEntity =
  | Board | Column | Item | FieldDefinition
  | AttachedDocument | DocumentTemplate | LegacyWritingTemplate | PdfArtifact

export type WorkspaceSettingsDraft = {
  formatVersion: 1
  workspace: { title: string }
  board: {
    boardId: EntityId
    boardTitle: string
    entityName: string
    columns: Array<{ id?: EntityId; title: string; archive?: true }>
    fields: Array<{
      id?: EntityId
      title: string
      valueType: "text" | "number" | "boolean" | "select" | "url" | "date" | "datetime"
      required: boolean
      min?: number | null
      max?: number | null
      options?: Array<{ id?: EntityId; title: string }>
    }>
  }
  documentTemplates: Array<{ id?: EntityId; title: string; markdown: string }>
}

export type WorkspaceDocumentV2 = {
  kind: "workspace"
  formatVersion: 2
  id: WorkspaceId
  title: string
  archivedAt: IsoTime | null
  ownerPersonId: PersonId
  entities: Record<EntityId, WorkspaceEntity>
  migration: null | {
    migrationId: string
    sourceFormat: "match-0.0.1"
    sourceHeads: Heads
  }
  /** Retained, immutable migration inputs; v2 readers never use these as state. */
  leads?: unknown[]
  documents?: unknown[]
  templates?: unknown[]
  artifacts?: unknown[]
}

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

export type WorkspaceReference = {
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
  devices: Record<DeviceId, RegisteredDevice>
  workspaces: Record<WorkspaceId, WorkspaceReference>
}

export type TransactionMetadataV1 = {
  version: 1
  transactionId: string
  action: string
  entityIds: EntityId[]
  personId: PersonId
  deviceId: DeviceId
}

/** Signed proof envelopes live in a durable proof store, outside their own changes. */
export type SignedEnvelope<T> = {
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
  canEnrollDevices: true
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
  role: "owner" | "editor"
}>

export type WorkspaceGenesis = SignedEnvelope<{
  kind: "workspace-genesis"
  version: 1
  workspaceId: WorkspaceId
  ownerPersonId: PersonId
  initialHeads: Heads
  legacyCheckpoint: boolean
}>

type InvitationBase = {
  protocolVersion: 1
  invitationId: string
  issuerPersonId: PersonId
  issuerDeviceId: DeviceId
  endpoint: string
  expiresAt: IsoTime
  secret: string // 32 random bytes, base64url; never stored in replicated content
}

export type Invitation = SignedEnvelope<InvitationBase & (
  | { kind: "device-enrollment"; rootId: string }
  | { kind: "workspace-join"; workspaceId: WorkspaceId; role: "editor" }
)>

export type PeerAdvertisement = SignedEnvelope<{
  kind: "peer-advertisement"
  version: 1
  workspaceId: WorkspaceId
  personId: PersonId
  deviceId: DeviceId
  endpoint: string
  issuedAt: IsoTime
  /** Signed self-reported presentation metadata; never authority input. */
  deviceName?: string
  userAgent?: string
}>

export type LocalFileLocation = {
  fileId: EntityId
  deviceId: DeviceId
  path: string
}

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
  | "invalid_input" | "not_found" | "invalid_parent" | "cycle"
  | "cross_board_move" | "field_type_change" | "hidden_ancestor"
  | "permission_denied" | "storage_failed" | "unsupported_format"
  | "identity_conflict" | "migration_conflict" | "invalid_proof"
  | "invite_expired" | "invite_consumed" | "invite_cancelled"

export type CommandResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: CommandErrorCode; message: string; field?: string } }
