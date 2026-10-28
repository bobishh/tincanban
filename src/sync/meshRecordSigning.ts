import { captureIdentityProfile } from "../domain/identity"
import type { WorkspaceRecordSigner } from "@meta-uber/mesh-workspace"
import { type LocalProfile } from "../domain/identity"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { assertSigningContextCurrent, signingEvidence, signWithContext } from "../domain/signingContext"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { canonicalAuthorityJson } from "./authorityFingerprint"
import type { PeerStore, WorkspaceMeshCredential } from "./peerStore"
import { workspaceOwnerSigningContext, type ReadWorkspaceOwnerAuthority } from "./workspaceOwnerSigning"
import { assertMeshRecordMembership, assertMeshRecordOperation, assertMeshRecordPayload, type MeshRecordOperation } from "./meshRecordPolicy"
export type { MeshRecordOperation } from "./meshRecordPolicy"

export class WorkspaceRecordAuthorityChangedError extends Error {
  constructor() { super("Workspace record authority changed while signing") }
}

/** Public proof and private signing stay behind the same immutable, live-checked boundary. */
export async function workspaceRecordSigning(profile: LocalProfile, workspaceId: string,
  currentAuthority: (payload?: Record<string, unknown>) => Promise<string>, purposes: string[],
  assertPayload?: (payload: Record<string, unknown>) => void): Promise<WorkspaceRecordSigner> {
  profile = captureIdentityProfile(profile)
  purposes = purposes.slice()
  const { proof, unchanged } = await prepareRecordProof(profile, workspaceId, currentAuthority)
  const evidence = signingEvidence(proof)
  return Object.freeze({ personId: profile.identity.personId, deviceId: profile.device.deviceId, publicKey: profile.identity.publicKey,
    get certificates() { return structuredClone(evidence.certificates) },
    async sign<T extends { kind: string }>(payload: T) {
      const snapshot = structuredClone(payload)
      if (!purposes.includes(snapshot.kind)) throw new Error("Workspace signer purpose is not authorized")
      if ((snapshot as Record<string, unknown>).workspaceId !== workspaceId) throw new Error("Workspace signer scope does not match")
      assertPayload?.(snapshot as Record<string, unknown>)
      const context = await resolveLocalSigningContext(profile, snapshot.kind, { workspaceId },
        { currentAuthority: () => unchanged(snapshot as Record<string, unknown>) })
      return signWithContext(context, snapshot)
    },
  })
}

async function prepareRecordProof(profile: LocalProfile, workspaceId: string,
  currentAuthority: (payload?: Record<string, unknown>) => Promise<string>) {
  for (let attempt = 0; ; attempt++) {
    const revision = await currentAuthority()
    const changed = new WorkspaceRecordAuthorityChangedError()
    const unchanged = async (payload?: Record<string, unknown>) => {
      if (await currentAuthority(payload) !== revision) throw changed
      return revision
    }
    try {
      const proof = await resolveLocalSigningContext(profile, "workspace-record-proof", { workspaceId },
        { currentAuthority: unchanged })
      return { proof, unchanged }
    } catch (error) {
      // No record was signed. Reprepare only our stale snapshot, never a denied
      // credential; after returning the signer its captured authority stays fixed.
      if (error !== changed || attempt === 2) throw error
    }
  }
}

const ownerPurposes = ["workspace-revocation", "workspace-succession-policy", "workspace-ownership-transfer", "workspace-grant"]
export async function ownerWorkspaceRecordSigning(profile: LocalProfile, workspaceId: string,
  readAuthority?: ReadWorkspaceOwnerAuthority): Promise<WorkspaceRecordSigner> {
  const owner = await workspaceOwnerSigningContext(profile, workspaceId, "workspace-record-proof", {}, readAuthority)
  return workspaceRecordSigning(profile, workspaceId, async () => {
    await assertSigningContextCurrent(owner)
    return owner.authorityRevision
  }, ownerPurposes)
}

type RecordStore = Pick<PeerStore, "getWorkspaceCredential" | "getWorkspaceAuthority" | "listPeers">

/** Keep each existing operation's rights; participants do not acquire an Owner requirement. */
export async function meshRecordSigning(profile: LocalProfile, expected: WorkspaceMeshCredential,
  operation: MeshRecordOperation, store: RecordStore): Promise<WorkspaceRecordSigner> {
  expected = structuredClone(expected)
  operation = structuredClone(operation)
  const expectedRevision = credentialRevision(expected)
  const workspaceId = expected.workspaceId
  const currentAuthority = async (payload?: Record<string, unknown>) => {
    const [credential, authority, peers] = await Promise.all([
      store.getWorkspaceCredential(workspaceId), store.getWorkspaceAuthority(workspaceId), store.listPeers(workspaceId),
    ])
    if (!credential || credentialRevision(credential) !== expectedRevision) throw new Error("Workspace record credential changed while signing")
    assertMeshRecordMembership(credential, authority, profile)
    assertMeshRecordOperation(credential, operation, peers, profile, payload)
    // Live editor membership constrains succession-policy payloads above; it is
    // not an authority revision for an unrelated owner grant or advertisement.
    return canonicalAuthorityJson({ credential: expectedRevision, authority: authority ? credentialRevision(authority) : null,
      removalPeer: operation.kind === "device-revocation"
        ? peers.filter(peer => peer.deviceId === operation.deviceId).map(peer => [peer.personId, peer.revokedAt ?? null]) : null })
  }
  const purposes = operation.kind === "owner" ? ownerPurposes : operation.kind === "advertisement" ? ["peer-advertisement"]
    : operation.kind === "departure" ? ["workspace-departure"] : (operation.kind === "device-revocation" || operation.kind === "device-restoration") ? ["workspace-device-revocation"]
      : operation.kind === "vote" ? ["workspace-succession-vote"] : ["workspace-succession-claim", "workspace-grant"]
  const signing = await workspaceRecordSigning(profile, workspaceId, currentAuthority, purposes, payload => {
    assertMeshRecordPayload(expected, operation, profile, payload)
  })
  if (operation.kind !== "claim") return signing
  return Object.freeze({ personId: signing.personId, deviceId: signing.deviceId, publicKey: signing.publicKey,
    get certificates() { return signing.certificates },
    async sign<T extends { kind: string }>(payload: T) {
      const record = await signing.sign(payload)
      if (payload.kind === "workspace-succession-claim") {
        const catalog = expected.catalog as { revocations?: Array<{ payload: { personId: string } }> } | undefined
        meshRustRuntime().state.verifyWorkspaceSuccessionClaim(record, workspaceId, { personId: expected.ownerPersonId,
          publicKey: expected.ownerPublicKey, certificates: expected.ownerCertificates }, expected.epoch,
        [...new Set((catalog?.revocations ?? []).map(record => record.payload.personId))], Date.now())
      }
      return record
    },
  })
}

function credentialRevision(credential: object): string {
  const stable = { ...credential } as Record<string, unknown>
  delete stable.updatedAt
  delete stable.transportSecret
  return canonicalAuthorityJson(stable)
}
