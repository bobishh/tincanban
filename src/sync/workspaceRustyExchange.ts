import type { LocalProfile } from "../domain/identity"
import { canonicalizeJson } from "../domain/identity"
import type { WorkspaceSetStore } from "./workspaceSet"
import type { PeerStore } from "./peerStore"
import { getReplicaConfigurations } from "./privateReplicaRepository"
import { createBoardStorageAccess, receiveBoardStorageAccess, selectBoardStorageAccess, verifyBoardStorageAccess } from "./workspaceRustyAccess"
import type { BoardStorageAccess } from "../domain/boardStorageAccess"
import { verifyWorkspaceMemberBundle, type WorkspaceAuthority } from "@meta-uber/mesh-workspace"
import type { WorkspaceGrant } from "../domain/model"
import type { DeviceCertificate } from "../domain/model"
import type { ReadWorkspaceOwnerAuthority } from "./workspaceOwnerSigning"

/** Board access is separate from personal settings, and travels only over an authenticated participant channel. */
export function withWorkspaceRustyAccess(store: WorkspaceSetStore, input: {
  workspaceId: string; profile: LocalProfile; remotePersonId: string; remoteDeviceId: string;
  peers: PeerStore; guard: () => Promise<void>
}): WorkspaceSetStore {
  const attestations = new Map<string, BoardStorageAccess>()
  const authority: ReadWorkspaceOwnerAuthority = async () => {
    await input.guard()
    const credential = await input.peers.getWorkspaceCredential(input.workspaceId)
    if (!credential) throw new Error("Board storage authority is unavailable")
    const storedAuthority = await input.peers.getWorkspaceAuthority(input.workspaceId)
    if (storedAuthority && (storedAuthority.workspaceId !== credential.workspaceId ||
        storedAuthority.ownerPersonId !== credential.ownerPersonId || storedAuthority.ownerPublicKey !== credential.ownerPublicKey)) {
      throw new Error("Workspace credential and stored authority disagree")
    }
    await input.guard()
    return { ...credential,
      scopeAuthoritySnapshot: storedAuthority ? storedAuthority.scopeAuthoritySnapshot : credential.scopeAuthoritySnapshot }
  }
  return { ...store,
    readMesh: id => readWorkspaceRustyMesh(store, input, authority, attestations, id),
    mergeMesh: async (id, raw) => {
      if (id !== input.workspaceId || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid board storage metadata")
      const { boardStorageAccess, ...mesh } = raw as Record<string, unknown>
      await input.guard()
      await store.mergeMesh?.(id, mesh)
      if (boardStorageAccess === undefined) return
      const current = await authority()
      if (!current) throw new Error("Board storage authority is unavailable")
      const profile = input.profile
      const grant = current.localGrant as { payload?: { role?: string } } | undefined
      const role = current.ownerPersonId === profile.identity.personId ? "owner" : grant?.payload?.role
      if (role !== "owner" && role !== "editor" && role !== "visitor") throw new Error("Current participant cannot receive board storage")
      await receiveBoardStorageAccess(profile.identity.personId, id, current, role, boardStorageAccess, input.guard, profile.identity.publicKey)
    },
  }
}

type RustyExchangeInput = {
  workspaceId: string; profile: LocalProfile; remotePersonId: string; remoteDeviceId: string;
  peers: PeerStore; guard: () => Promise<void>
}
type CurrentWorkspaceAuthority = NonNullable<Awaited<ReturnType<ReadWorkspaceOwnerAuthority>>>
async function readWorkspaceRustyMesh(store: WorkspaceSetStore, input: RustyExchangeInput,
  authority: ReadWorkspaceOwnerAuthority, attestations: Map<string, BoardStorageAccess>, id: string) {
  if (id !== input.workspaceId) throw new Error("Board storage exchange changed workspace")
  const mesh = await store.readMesh?.(id)
  await input.guard()
  const configurations = (await getReplicaConfigurations(input.profile.identity.personId))
    .filter(config => config.workspaceId === id && !config.removalPending)
  await input.guard()
  if (!configurations.length) return mesh
  const current = await authority()
  if (!current) throw new Error("Board storage authority is unavailable")
  if (input.remotePersonId === current.ownerPersonId) return mesh
  const member = await readRustyExchangeMember(input, current, id)
  const connections = await readRustyExchangeConnections(input, current, member, authority, attestations, configurations)
  await input.guard()
  return connections.length ? { ...mesh as object, boardStorageAccess: connections } : mesh
}

async function readRustyExchangeMember(input: RustyExchangeInput, current: CurrentWorkspaceAuthority, id: string) {
  const remote = await input.peers.getPeer(id, input.remoteDeviceId)
  if (!remote || remote.personId !== input.remotePersonId) throw new Error("Board storage recipient changed")
  if (!remote.advertisement) throw new Error("Verified participant identity is required before sharing Rusty storage")
  const member = await verifyWorkspaceMemberBundle(remote.advertisement, { workspaceId: id,
    ownerPersonId: current.ownerPersonId, ownerPublicKey: current.ownerPublicKey,
    ownerCertificates: current.ownerCertificates as DeviceCertificate[], ownerHistory: (current.ownerHistory ?? []) as WorkspaceAuthority[] })
  if (member.payload.personId !== input.remotePersonId || member.payload.deviceId !== input.remoteDeviceId ||
      !member.grant || member.grant.payload.role !== member.role) {
    throw new Error("Verified participant grant does not match the Rusty recipient")
  }
  return member
}

async function readRustyExchangeConnections(input: RustyExchangeInput,
  current: CurrentWorkspaceAuthority,
  member: Awaited<ReturnType<typeof readRustyExchangeMember>>, authority: ReadWorkspaceOwnerAuthority,
  attestations: Map<string, BoardStorageAccess>, configurations: Awaited<ReturnType<typeof getReplicaConfigurations>>) {
  const connections = []
  for (const config of configurations) {
    await input.guard()
    const selected = await prepareRustyExchangeConnection(input, current, member, config, authority, attestations, input.workspaceId)
    if (selected) connections.push(selected)
  }
  return connections
}

async function prepareRustyExchangeConnection(input: RustyExchangeInput,
  current: CurrentWorkspaceAuthority,
  member: Awaited<ReturnType<typeof readRustyExchangeMember>>,
  config: Awaited<ReturnType<typeof getReplicaConfigurations>>[number], authority: ReadWorkspaceOwnerAuthority,
  attestations: Map<string, BoardStorageAccess>, id: string) {
  let access = config.boardAccess
  if (!access) {
    if (input.profile.identity.personId !== current.ownerPersonId) return undefined
    access = await cachedOwnerBoardAccess(input, config, member, authority, attestations)
  } else {
    await verifyBoardStorageAccess(config, id, current, access.mode === "write" ? "editor" : "visitor",
      input.profile.identity.personId, input.profile.identity.publicKey)
  }
  if (access.authorization.payload.subjectPersonId !== input.remotePersonId ||
      access.authorization.payload.subjectPublicKey !== member.publicKey) return undefined
  return selectBoardStorageAccess(access, config.writeToken, member.role)
}

async function cachedOwnerBoardAccess(input: RustyExchangeInput,
  config: Awaited<ReturnType<typeof getReplicaConfigurations>>[number],
  member: Awaited<ReturnType<typeof readRustyExchangeMember>>, authority: ReadWorkspaceOwnerAuthority,
  attestations: Map<string, BoardStorageAccess>): Promise<BoardStorageAccess> {
  const grant = member.grant as WorkspaceGrant
  const key = canonicalizeJson([config.origin, config.scopeId, config.policyRevision, config.keyEpoch, config.minimumWriterVersion,
    config.readToken, config.writeToken, config.contentKey, config.historicalContentKeys, config.historicalContentKeyVariants,
    grant.payload.grantId, grant.payload.accessEpoch ?? 1, member.publicKey])
  const previous = attestations.get(key)
  if (previous) return previous
  const access = await createBoardStorageAccess(input.profile, config, grant, member.publicKey, authority, input.guard)
  if (attestations.size >= 32) attestations.clear()
  attestations.set(key, access)
  return access
}
