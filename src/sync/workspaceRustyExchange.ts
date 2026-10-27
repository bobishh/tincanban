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
import { readWorkspaceParticipantGrant } from "./workspaceParticipants"
import { requireIdentityAuthorityView } from "./identityAuthorityStore"
import { authorizeIdentityDataDevice } from "@meta-uber/mesh-identity"

export type WorkspaceRustyAccessStore = WorkspaceSetStore & {
  /** Retryable control-plane preparation. Mesh reads never perform this operation. */
  prepareRustyAccess: (id: string) => Promise<WorkspaceRustyPreparationResult>
}
type WorkspaceRustyPreparationResult = { changed: boolean; failures: Error[] }

/** Board access is separate from personal settings, and travels only over an authenticated participant channel. */
export function withWorkspaceRustyAccess(store: WorkspaceSetStore, input: {
  workspaceId: string; profile: LocalProfile; remotePersonId: string; remoteDeviceId: string;
  peers: PeerStore; guard: () => Promise<void>
}): WorkspaceRustyAccessStore {
  const attestations = new Map<string, BoardStorageAccess>()
  const authority: WorkspaceRustyAuthorityReader = async guard => {
    const ensureCurrent = guard ?? input.guard
    await ensureCurrent()
    const credential = await input.peers.getWorkspaceCredential(input.workspaceId)
    if (!credential) throw new Error("Board storage authority is unavailable")
    const storedAuthority = await input.peers.getWorkspaceAuthority(input.workspaceId)
    if (storedAuthority && (storedAuthority.workspaceId !== credential.workspaceId ||
        storedAuthority.ownerPersonId !== credential.ownerPersonId || storedAuthority.ownerPublicKey !== credential.ownerPublicKey)) {
      throw new Error("Workspace credential and stored authority disagree")
    }
    await ensureCurrent()
    return { ...credential,
      scopeAuthoritySnapshot: storedAuthority ? storedAuthority.scopeAuthoritySnapshot : credential.scopeAuthoritySnapshot }
  }
  return { ...store,
    prepareRustyAccess: id => prepareWorkspaceRustyAccess(input, authority, attestations, id),
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
type WorkspaceRustyAuthorityReader = (guard?: () => Promise<void>) => ReturnType<ReadWorkspaceOwnerAuthority>
type CurrentWorkspaceAuthority = NonNullable<Awaited<ReturnType<ReadWorkspaceOwnerAuthority>>>
type VerifiedRustyRecipient = { publicKey: string; grant: WorkspaceGrant; role: "editor" | "visitor" }

class WorkspaceRustySessionGuardFailure extends Error {
  constructor(readonly original: unknown) { super("Workspace session guard failed", { cause: original }) }
}

function rustySessionGuard(input: RustyExchangeInput): () => Promise<void> {
  return async () => {
    try { await input.guard() }
    catch (cause) { throw new WorkspaceRustySessionGuardFailure(cause) }
  }
}

async function readWorkspaceRustyMesh(store: WorkspaceSetStore, input: RustyExchangeInput,
  authority: WorkspaceRustyAuthorityReader, attestations: Map<string, BoardStorageAccess>, id: string) {
  if (id !== input.workspaceId) throw new Error("Board storage exchange changed workspace")
  const mesh = await store.readMesh?.(id)
  await input.guard()
  let result = mesh
  try {
    result = await readOptionalRustyMesh(input, authority, attestations, id, mesh)
  } catch (cause) {
    if (cause instanceof WorkspaceRustySessionGuardFailure) throw cause.original
  }
  await input.guard()
  return result
}

async function readOptionalRustyMesh(input: RustyExchangeInput, authority: WorkspaceRustyAuthorityReader,
  attestations: Map<string, BoardStorageAccess>, id: string, mesh: unknown) {
  const sessionGuard = rustySessionGuard(input)
  const configurations = (await getReplicaConfigurations(input.profile.identity.personId))
    .filter(config => config.workspaceId === id && !config.removalPending)
  await sessionGuard()
  if (!configurations.length) return mesh
  const current = await authority(sessionGuard)
  if (!current) throw new Error("Board storage authority is unavailable")
  if (input.remotePersonId === current.ownerPersonId) return mesh
  const recipient = await readRustyExchangeRecipient(input, current, id)
  if (!recipient) return mesh
  const identityView = await identityViewForDisclosure(input)
  if (!identityView) return mesh
  const connections = await readRustyExchangeConnections({ ...input, guard: sessionGuard }, current,
    recipient, attestations, configurations)
  const latestIdentityView = await identityViewForDisclosure(input)
  if (!latestIdentityView) return mesh
  if (canonicalizeJson(latestIdentityView) !== canonicalizeJson(identityView)) return mesh
  await sessionGuard()
  return connections.length ? { ...mesh as object, boardStorageAccess: connections } : mesh
}

async function prepareWorkspaceRustyAccess(input: RustyExchangeInput, authority: ReadWorkspaceOwnerAuthority,
  attestations: Map<string, BoardStorageAccess>, id: string): Promise<WorkspaceRustyPreparationResult> {
  if (id !== input.workspaceId) throw new Error("Board storage exchange changed workspace")
  await input.guard()
  const configurations = (await getReplicaConfigurations(input.profile.identity.personId))
    .filter(config => config.workspaceId === id && !config.removalPending)
  await input.guard()
  if (!configurations.length) return { changed: false, failures: [] }
  const current = await authority()
  if (!current) throw new Error("Board storage authority is unavailable")
  if (input.remotePersonId === current.ownerPersonId) return { changed: false, failures: [] }
  const recipient = await readRustyExchangeRecipient(input, current, id)
  if (!recipient) return { changed: false, failures: [] }
  const identityView = await readCurrentRustyOwnerIdentity(input)
  const { staged, failures } = await stageRustyAccess(input, current, recipient, attestations, configurations, id)
  await assertRustyAccessPreparationCurrent(input, authority, current, recipient, identityView, configurations, id)
  let changed = false
  if (attestations.size + staged.size > 32) attestations.clear()
  for (const [key, access] of staged) {
    if (canonicalizeJson(attestations.get(key) ?? null) !== canonicalizeJson(access)) changed = true
    attestations.set(key, access)
  }
  return { changed, failures }
}

async function stageRustyAccess(input: RustyExchangeInput, current: CurrentWorkspaceAuthority,
  recipient: VerifiedRustyRecipient, attestations: Map<string, BoardStorageAccess>,
  configurations: Awaited<ReturnType<typeof getReplicaConfigurations>>, id: string) {
  const staged = new Map<string, BoardStorageAccess>()
  const failures: Error[] = []
  for (const config of configurations) {
    await input.guard()
    const key = attestationKey(config, recipient, current)
    try {
      const access = attestations.get(key) ?? await prepareRustyExchangeConnection(input, current, recipient, config, id)
      if (access) staged.set(key, access)
    } catch (cause) {
      failures.push(new Error(`Rusty access preparation failed for ${config.origin}`, { cause }))
    }
  }
  return { staged, failures }
}

async function assertRustyAccessPreparationCurrent(input: RustyExchangeInput, authority: ReadWorkspaceOwnerAuthority,
  current: CurrentWorkspaceAuthority, recipient: VerifiedRustyRecipient, identityView: Awaited<ReturnType<typeof requireIdentityAuthorityView>>,
  configurations: Awaited<ReturnType<typeof getReplicaConfigurations>>, id: string): Promise<void> {
  await input.guard()
  const confirmed = await authority()
  if (!confirmed) throw new Error("Board storage authority is unavailable")
  const confirmedRecipient = await readRustyExchangeRecipient(input, confirmed, id)
  if (!confirmedRecipient) throw new Error("Workspace recipient grant was revoked while preparing Rusty access")
  const confirmedIdentityView = await readCurrentRustyOwnerIdentity(input)
  const latestConfigurations = (await getReplicaConfigurations(input.profile.identity.personId))
    .filter(config => config.workspaceId === id && !config.removalPending)
  if (canonicalizeJson(confirmed) !== canonicalizeJson(current) ||
      canonicalizeJson(confirmedIdentityView) !== canonicalizeJson(identityView) ||
      canonicalizeJson(confirmedRecipient) !== canonicalizeJson(recipient) ||
      !sameRustyConfigurations(latestConfigurations, configurations, confirmedRecipient, recipient, confirmed, current)) {
    throw new Error("Workspace membership or Rusty configuration changed while preparing access; retry required")
  }
}

function sameRustyConfigurations(left: Awaited<ReturnType<typeof getReplicaConfigurations>>,
  right: Awaited<ReturnType<typeof getReplicaConfigurations>>, leftRecipient: VerifiedRustyRecipient,
  rightRecipient: VerifiedRustyRecipient, leftAuthority: CurrentWorkspaceAuthority,
  rightAuthority: CurrentWorkspaceAuthority): boolean {
  return canonicalizeJson(left.map(config => attestationKey(config, leftRecipient, leftAuthority)).sort()) ===
    canonicalizeJson(right.map(config => attestationKey(config, rightRecipient, rightAuthority)).sort())
}

async function readCurrentRustyOwnerIdentity(input: RustyExchangeInput) {
  const view = await requireIdentityAuthorityView(input.profile.identity.personId)
  if (view.identityPublicKey !== input.profile.identity.publicKey) throw new Error("Rusty owner Identity authority changed; retry required")
  const key = await authorizeIdentityDataDevice(view, input.profile.device.deviceId)
  if (key !== input.profile.device.publicKey) throw new Error("Current Rusty owner device is not active in Identity authority")
  return view
}

async function identityViewForDisclosure(input: RustyExchangeInput) {
  try { return await readCurrentRustyOwnerIdentity(input) }
  catch (cause) {
    if (cause instanceof Error && cause.message === "Identity device access is revoked") return undefined
    throw cause
  }
}

async function readRustyExchangeRecipient(input: RustyExchangeInput, current: CurrentWorkspaceAuthority, id: string): Promise<VerifiedRustyRecipient | undefined> {
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
  const grant = await readWorkspaceParticipantGrant(id, input.remotePersonId, member.grant)
  if (!grant) return undefined
  const role = grant.payload.role
  if (role !== "editor" && role !== "visitor") return undefined
  return { publicKey: member.publicKey, grant, role }
}

async function readRustyExchangeConnections(input: RustyExchangeInput,
  current: CurrentWorkspaceAuthority,
  recipient: VerifiedRustyRecipient,
  attestations: Map<string, BoardStorageAccess>, configurations: Awaited<ReturnType<typeof getReplicaConfigurations>>) {
  const connections = []
  for (const config of configurations) {
    await input.guard()
    try {
      const access = config.boardAccess ?? attestations.get(attestationKey(config, recipient, current))
      if (!access || access.authorization.payload.subjectPersonId !== input.remotePersonId ||
        access.authorization.payload.subjectPublicKey !== recipient.publicKey ||
        canonicalizeJson(access.authorization.payload.workspaceGrant) !== canonicalizeJson(recipient.grant)) continue
      const selected = selectBoardStorageAccess(access, config.writeToken, recipient.role)
      if (selected) await verifyBoardStorageAccess(selected, input.workspaceId, current,
        recipient.role, input.remotePersonId, recipient.publicKey)
      if (selected) connections.push(selected)
    } catch { /* A malformed or stale optional connection cannot hide other configured services. */ }
  }
  return connections
}

async function prepareRustyExchangeConnection(input: RustyExchangeInput,
  current: CurrentWorkspaceAuthority,
  recipient: VerifiedRustyRecipient,
  config: Awaited<ReturnType<typeof getReplicaConfigurations>>[number], id: string): Promise<BoardStorageAccess | undefined> {
  let access = config.boardAccess
  if (!access) {
    if (input.profile.identity.personId !== current.ownerPersonId) return undefined
    access = await createBoardStorageAccess(input.profile, config, recipient.grant, recipient.publicKey,
      async () => current, input.guard)
  } else {
    await verifyBoardStorageAccess(config, id, current, access.mode === "write" ? "editor" : "visitor",
      input.profile.identity.personId, input.profile.identity.publicKey)
  }
  if (access.authorization.payload.subjectPersonId !== input.remotePersonId ||
      access.authorization.payload.subjectPublicKey !== recipient.publicKey ||
      canonicalizeJson(access.authorization.payload.workspaceGrant) !== canonicalizeJson(recipient.grant)) return undefined
  return access
}

function attestationKey(config: Awaited<ReturnType<typeof getReplicaConfigurations>>[number],
  recipient: VerifiedRustyRecipient, current: CurrentWorkspaceAuthority): string {
  const grant = recipient.grant
  return canonicalizeJson([config.origin, config.scopeId, config.policyRevision, config.keyEpoch, config.minimumWriterVersion,
    config.readToken, config.writeToken, config.contentKey, config.historicalContentKeys, config.historicalContentKeyVariants,
    grant.payload.grantId, grant.payload.accessEpoch ?? 1, recipient.publicKey, current.scopeAuthoritySnapshot,
    config.boardAccess ?? null])
}
