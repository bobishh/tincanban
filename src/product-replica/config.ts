import type { ReplicaContentKeys } from "../domain/replicaContentKeys"
import type { RustyReplicaAccess } from "@meta-uber/mesh-replication/rusty-replica"
import type { BoardStorageAccess } from "../domain/boardStorageAccess"

export type BlindReplicaConfig = RustyReplicaAccess & ReplicaContentKeys & {
  boardAccess?: BoardStorageAccess
  purpose?: "workspace"
  workspaceId: string
  cursor: number
  lastUploaded: string
  removalPending?: boolean
  preferenceRevision?: string
  minimumWriterVersion?: 2
}
export type IdentityReplicaConfig = Omit<RustyReplicaAccess, "client" | "clientBuild"> & ReplicaContentKeys & {
  purpose: "identity"
  personId: string
  cursor: number
  lastUploaded: string
  removalPending?: boolean
  preferenceRevision?: string
}
export type PrivateReplicaConfig = BlindReplicaConfig | IdentityReplicaConfig
