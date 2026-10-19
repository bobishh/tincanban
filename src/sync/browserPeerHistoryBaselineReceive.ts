import * as Automerge from "@automerge/automerge/slim"
import { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import type { StoredWorkspaceSnapshot } from "../storageJournal"
import { readWorkspaceBasisSnapshot, readWorkspaceSnapshot } from "../storageJournal"
import { WorkspaceUnavailableError } from "../workspaceAvailability"
import { defaultStorage } from "../storage"
import { decodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import type { PeerHistoryBaselineDescriptor, PeerHistoryObjectReader } from "./workspaceSet"
import { verifyPeerReceivedHistoryBaseline } from "./peerHistoryBaselineReceiver"
import { createReceivedHistoryBaselineRepository } from "./receivedHistoryBaselineRepository"
import { createBlindSnapshotRevision } from "./blindSnapshotRevision"
import type { useTincanban } from "../state"
import { peerStore } from "./peerStore"
import { preflightPeerHistoryAncestors } from "./peerHistoryAncestorPreflight"
import type { VerifiedHistoryAncestors } from "./verifiedHistoryAncestors"

const verifiedAncestors = new WeakMap<WasmVerifiedReceivedHistoryBaseline, VerifiedHistoryAncestors>()

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}
function sameSnapshot(left: { bytes: Uint8Array; heads: string[]; revision: string | undefined; baselineId?: string },
  right: { bytes: Uint8Array; heads: string[]; revision: string | undefined; baselineId?: string }) {
  return left.revision === right.revision && left.baselineId === right.baselineId && sameBytes(left.bytes, right.bytes) &&
    left.heads.length === right.heads.length && left.heads.every((head, index) => head === right.heads[index])
}
type PeerBaselinePayload = { workspaceId: string; baselineId: string; sourceHeads: string[] }
function readPeerBaselinePayload(basis: WasmVerifiedReceivedHistoryBaseline): PeerBaselinePayload {
  const envelope = basis.envelope() as unknown as { payload?: unknown }
  const payload = envelope.payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Peer history baseline payload is invalid")
  const value = payload as Record<string, unknown>
  if (typeof value.workspaceId !== "string" || typeof value.baselineId !== "string" || !Array.isArray(value.sourceHeads) ||
      !value.sourceHeads.every((head): head is string => typeof head === "string")) throw new Error("Peer history baseline payload is invalid")
  return { workspaceId: value.workspaceId, baselineId: value.baselineId, sourceHeads: value.sourceHeads }
}
async function readLocalSnapshot(workspaceId: string, tincanban: ReturnType<typeof useTincanban>) {
  const revision = await defaultStorage.readWorkspaceRevision(workspaceId)
  if (!revision) return { bytes: new Uint8Array(), heads: [], revision: undefined as string | undefined }
  let bytes: Uint8Array
  try { bytes = await tincanban.readWorkspaceBytes(workspaceId) }
  catch (error) {
    if (!(error instanceof WorkspaceUnavailableError) || await readWorkspaceSnapshot(workspaceId)) throw error
    return { bytes: new Uint8Array(), heads: [], revision }
  }
  const doc = Automerge.load(bytes)
  try { return { bytes: bytes.slice(), heads: Automerge.getHeads(doc).sort(), revision: await createBlindSnapshotRevision(tincanban)(workspaceId) } }
  finally { Automerge.free(doc) }
}

type ReceiveInput = { workspaceId: string; workspaceBytes: Uint8Array; authorization: unknown; descriptor: PeerHistoryBaselineDescriptor;
  baselineDocument: Uint8Array; reader: PeerHistoryObjectReader; tincanban: ReturnType<typeof useTincanban>; ensureCurrent(): void }
function captureReceiveInput(input: ReceiveInput): ReceiveInput {
  const captured = { ...input, workspaceBytes: input.workspaceBytes.slice(), baselineDocument: input.baselineDocument.slice(),
    authorization: structuredClone(input.authorization), descriptor: structuredClone(input.descriptor) }
  if (!captured.workspaceId || captured.workspaceId.length > 256 || captured.descriptor.documentLength !== captured.baselineDocument.length) {
    throw new Error("Peer history bootstrap does not match its bounded descriptor")
  }
  return captured
}

async function previousVerifiedBasis(workspaceId: string, personId: string, guard: () => void): Promise<{ basis?: WasmVerifiedReceivedHistoryBaseline; owned: boolean }> {
  let basis = await defaultStorage.getVerifiedReceivedHistoryBaseline(workspaceId, guard)
  let owned = false
  const repository = createReceivedHistoryBaselineRepository(workspaceId, guard)
  if (!basis && await repository.readActive()) {
    basis = await (await import("./historyBaselineStartup")).reverifyActiveHistoryForWorkspace(workspaceId, personId, guard) ?? undefined
    owned = Boolean(basis)
  }
  guard()
  return { basis, owned }
}

async function verifyIncomingBasis(captured: ReceiveInput, trustedScopeAuthority: unknown,
  previous: WasmVerifiedReceivedHistoryBaseline | undefined): Promise<WasmVerifiedReceivedHistoryBaseline> {
  const previousForVerification = previous && readPeerBaselinePayload(previous).baselineId === captured.descriptor.baselineId ? null : previous
  const candidate = await verifyPeerReceivedHistoryBaseline({ signedJson: decodeBlindBytes(captured.descriptor.signedJson),
    baselineDocument: captured.baselineDocument, trustedScopeAuthority, previous: previousForVerification,
    fetch: { ensureCurrent: captured.reader.ensureCurrent, read: (objectId, binding) => {
      if (!binding) throw new Error("Peer history proof read requires its archive binding")
      return captured.reader.read(objectId, binding, captured.descriptor.baselineId)
    } }, ensureCurrent: captured.ensureCurrent })
  try {
    captured.ensureCurrent()
    const payload = readPeerBaselinePayload(candidate)
    if (payload.workspaceId !== captured.workspaceId || payload.baselineId !== captured.descriptor.baselineId) {
      throw new Error("Peer history baseline differs from its descriptor")
    }
    return candidate
  } catch (error) { candidate.free(); throw error }
}

async function verifyLocalReceiveState(captured: ReceiveInput, candidate: WasmVerifiedReceivedHistoryBaseline): Promise<void> {
  const guard = captured.ensureCurrent
  const payload = readPeerBaselinePayload(candidate)
  const local = await readLocalSnapshot(captured.workspaceId, captured.tincanban)
  const progress = await defaultStorage.ensureHistoryProgress(captured.workspaceId)
  guard()
  const before = { ...local, baselineId: progress.baselineId ?? undefined }
  if (progress.transitionId) throw new Error("Finish the current workspace history transition before receiving a peer baseline")
  const active = await createReceivedHistoryBaselineRepository(captured.workspaceId, guard).readActive()
  guard()
  const sameActiveBaseline = progress.baselineId === payload.baselineId && active?.baselineId === payload.baselineId
  if (!sameActiveBaseline && local.heads.some(head => !payload.sourceHeads.includes(head))) throw new Error("Peer baseline does not cover a local workspace head")
  guard()
  const afterLocal = await readLocalSnapshot(captured.workspaceId, captured.tincanban)
  const afterProgress = await defaultStorage.ensureHistoryProgress(captured.workspaceId)
  guard()
  if (!sameSnapshot(before, { ...afterLocal, baselineId: afterProgress.baselineId ?? undefined })) {
    throw new Error("Workspace changed while peer history was being received")
  }
}

/** Receive a bounded peer baseline. Native verifies owner authority; peer proofs never imply Rusty ciphertext correspondence. */
export async function receivePeerBrowserHistoryBaseline(input: {
  workspaceId: string
  workspaceBytes: Uint8Array
  authorization: unknown
  descriptor: PeerHistoryBaselineDescriptor
  baselineDocument: Uint8Array
  reader: PeerHistoryObjectReader
  tincanban: ReturnType<typeof useTincanban>
  ensureCurrent(): void
}): Promise<WasmVerifiedReceivedHistoryBaseline> {
  const captured = captureReceiveInput(input)
  const guard = captured.ensureCurrent
  guard()
  const [authority, credential] = await Promise.all([
    peerStore.getWorkspaceAuthority(captured.workspaceId), peerStore.getWorkspaceCredential(captured.workspaceId),
  ])
  guard()
  const trustedScopeAuthority = (authority ?? credential)?.scopeAuthoritySnapshot ??
    captured.reader.invitationScopeAuthority?.(captured.workspaceId)
  if (!trustedScopeAuthority) throw new Error("Peer history requires an independently admitted signed scope authority")
  const personId = captured.tincanban.getCurrentProfile()?.identity.personId ?? ""
  const { basis: previous, owned: ownedPrevious } = await previousVerifiedBasis(captured.workspaceId, personId, guard)
  let candidate: WasmVerifiedReceivedHistoryBaseline | undefined
  let retained = false
  try {
    candidate = await verifyIncomingBasis(captured, trustedScopeAuthority, previous)
    const ancestors = await preflightPeerHistoryAncestors({ workspaceId: captured.workspaceId, candidate, reader: captured.reader,
      trustedScopeAuthority, ensureCurrent: guard })
    await verifyLocalReceiveState(captured, candidate)
    verifiedAncestors.set(candidate, ancestors)
    retained = true
    return candidate
  } finally {
    if (!retained) candidate?.free()
    if (ownedPrevious) previous?.free()
  }
}

/** Activate only after the containing workspace-set has passed all snapshot validation. */
export async function activatePeerBrowserHistoryBaseline(input: {
  workspaceId: string
  candidate: WasmVerifiedReceivedHistoryBaseline
  tincanban: ReturnType<typeof useTincanban>
  ensureCurrent(): void
}): Promise<void> {
  const guard = input.ensureCurrent
  guard()
  if (!(input.candidate instanceof WasmVerifiedReceivedHistoryBaseline)) throw new Error("Peer history basis is not Native-verified")
  const payload = readPeerBaselinePayload(input.candidate)
  if (payload.workspaceId !== input.workspaceId) {
    throw new Error("Peer history basis belongs to another workspace")
  }
  const repository = createReceivedHistoryBaselineRepository(input.workspaceId, guard)
  const active = await repository.readActive()
  guard()
  if (active?.baselineId === payload.baselineId) {
    await repository.retainVerifiedAncestors(input.candidate, verifiedAncestors.get(input.candidate))
    guard()
    await defaultStorage.acceptVerifiedReceivedHistoryBaseline(input.candidate, guard)
    return
  }
  const before = await readLocalSnapshot(input.workspaceId, input.tincanban)
  const heads = before.heads
  if (heads.some(head => !payload.sourceHeads.includes(head))) throw new Error("Peer history baseline does not cover the current workspace head")
  const progress = await defaultStorage.ensureHistoryProgress(input.workspaceId)
  guard()
  if (progress.transitionId) throw new Error("Finish the current workspace history transition before receiving a peer baseline")
  const expected: StoredWorkspaceSnapshot | null = (await readWorkspaceBasisSnapshot(input.workspaceId)) ?? null
  guard()
  const current = await readLocalSnapshot(input.workspaceId, input.tincanban)
  if (!sameSnapshot(before, current)) {
    throw new Error("Workspace changed before peer history activation")
  }
  const stageId = await repository.stage(input.candidate, expected, undefined, verifiedAncestors.get(input.candidate))
  guard()
  await defaultStorage.withWorkspaceTransaction(input.workspaceId,
    transaction => repository.activate(stageId, input.candidate, transaction))
  guard()
  await defaultStorage.acceptVerifiedReceivedHistoryBaseline(input.candidate, guard)
}
