import { computed, onScopeDispose, ref, watch } from "vue"
import type { LocalProfile } from "../domain/identity"
import type { WorkspaceDocumentV2, WorkspaceGrant } from "../domain/model"
import type { WorkspaceAuthorityRecord, WorkspaceMeshCredential } from "../sync/peerStore"
import type { PublicBoardProjection } from "../public/publicSchema"
import type { PublicDeliveryCommand } from "../public/publicDelivery"

type DeliveryStatus = "idle" | "waiting" | "sending" | "delivered" | "private" | "retry" | "blocked"
type DeliveryMarker = { version: 1; workspaceId: string; boardId: string; sourceHeads: string[]; status: DeliveryStatus; attempts: number; updatedAt: number }
type DeliveryCapture = { workspaceId: string; boardId: string; document: WorkspaceDocumentV2; profile: LocalProfile; sourceHeads: string[]; sourceVersion: number }
export interface PublicBoardDeliveryInput {
  origin: string
  workspaceId: () => string
  boardId: () => string | undefined
  document: () => WorkspaceDocumentV2 | null | undefined
  sourceVersion: () => number
  sourceHeads: () => string[]
  role: () => string | null | undefined
  profile: () => LocalProfile | null | undefined
  debounceMs?: number
}

const retryDelays = [2_000, 5_000, 15_000, 30_000, 60_000]
function markerKey(workspaceId: string, boardId: string, personId: string, deviceId: string) {
  return `tincanban.public-delivery.v1:${encodeURIComponent(workspaceId)}:${encodeURIComponent(boardId)}:${encodeURIComponent(personId)}:${encodeURIComponent(deviceId)}`
}
function sortedHeads(heads: string[]) { return [...new Set(heads)].sort() }
function parseMarker(raw: string | null): DeliveryMarker | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as Partial<DeliveryMarker>
    if (value.version !== 1 || typeof value.workspaceId !== "string" || typeof value.boardId !== "string" ||
        !Array.isArray(value.sourceHeads) || !value.sourceHeads.every(head => typeof head === "string") ||
        !["idle", "waiting", "sending", "delivered", "private", "retry", "blocked"].includes(String(value.status)) ||
        !Number.isSafeInteger(value.attempts) || !Number.isSafeInteger(value.updatedAt)) return undefined
    return value as DeliveryMarker
  } catch { return undefined }
}
async function currentEditorCredential(captured: DeliveryCapture, sameSource: (capture: DeliveryCapture) => boolean) {
  if (!sameSource(captured)) throw new Error("Editor access or source changed during public delivery")
  const credentialState = await readEditorCredential(captured)
  if (!sameSource(captured)) throw new Error("Editor access or source changed during public delivery")
  return credentialState
}
async function readEditorCredential(captured: DeliveryCapture) {
  const [peerStoreModule, meshBase, proofs, meshRecords] = await Promise.all([
    import("../sync/peerStore"), import("../sync/durableMeshBase"), import("../domain/proofs"),
    import("../sync/meshRecords"),
  ])
  const { peerStore } = peerStoreModule
  const [credential, authority] = await Promise.all([peerStore.getWorkspaceCredential(captured.workspaceId), peerStore.getWorkspaceAuthority(captured.workspaceId)])
  const grant = credential?.localGrant as WorkspaceGrant | undefined
  const revoked = !credential || !grant || meshBase.isGrantRevoked(credential, captured.profile.identity.personId, grant) ||
    meshBase.isDeviceRevoked(credential, captured.profile.identity.personId, captured.profile.device.deviceId) ||
    meshBase.hasLeftWorkspace(credential, captured.profile.identity.personId, grant)
  assertEditorCredential(credential, authority, grant, captured, revoked)
  const owner = { personId: credential!.ownerPersonId, publicKey: credential!.ownerPublicKey,
    certificates: [...credential!.ownerCertificates, ...authority!.ownerCertificates] as LocalProfile["certificate"][] }
  const role = await meshRecords.verifyWorkspaceGrant(grant!, { workspaceId: captured.workspaceId, personId: captured.profile.identity.personId,
    ownerPersonId: owner.personId, ownerPublicKey: owner.publicKey, ownerCertificates: owner.certificates })
  if (role !== "editor") throw new Error("Public delivery requires an active editor grant")
  const writerCertificates = meshBase.uniqueCertificates(captured.profile, [captured.profile.certificate, ...await proofs.defaultProofStore.listCertificates()])
  return { credential: credential!, authority: authority!, grant: grant!, ownerCertificates: owner.certificates, writerCertificates }
}
function assertEditorCredential(credential: WorkspaceMeshCredential | null, authority: WorkspaceAuthorityRecord | null, grant: WorkspaceGrant | undefined,
  captured: DeliveryCapture, revoked: boolean) {
  if (!credential || !authority || credential.workspaceId !== captured.workspaceId || authority.workspaceId !== captured.workspaceId || !grant ||
      grant.payload.workspaceId !== captured.workspaceId || grant.payload.personId !== captured.profile.identity.personId || grant.payload.role !== "editor" ||
      (grant.payload.accessEpoch ?? 1) !== credential.epoch || revoked) throw new Error("Editor workspace grant is no longer active")
}
function deliveryMarker(capture: DeliveryCapture, status: DeliveryStatus, attempts: number): DeliveryMarker {
  return { version: 1, workspaceId: capture.workspaceId, boardId: capture.boardId, sourceHeads: capture.sourceHeads,
    status, attempts, updatedAt: Date.now() }
}
async function persistDeliveryMarker(capture: DeliveryCapture, marker: DeliveryMarker) {
  const { writeLocal } = await import("../localDb")
  await writeLocal(markerKey(capture.workspaceId, capture.boardId, capture.profile.identity.personId, capture.profile.device.deviceId), JSON.stringify(marker))
}
function canStartDelivery(running: boolean, disposed: boolean, role: string | null | undefined) {
  return !running && !disposed && role === "editor"
}
function deliveryAccessKey(input: PublicBoardDeliveryInput) {
  return `${input.workspaceId()}:${input.boardId() ?? ""}:${input.profile()?.identity.personId ?? ""}:${input.profile()?.device.deviceId ?? ""}`
}
function sameDeliverySource(input: PublicBoardDeliveryInput, captured: DeliveryCapture, disposed: boolean) {
  return !disposed && input.role() === "editor" && input.workspaceId() === captured.workspaceId && input.boardId() === captured.boardId &&
    input.profile()?.identity.personId === captured.profile.identity.personId && input.profile()?.device.deviceId === captured.profile.device.deviceId &&
    input.sourceVersion() === captured.sourceVersion && JSON.stringify(sortedHeads(input.sourceHeads())) === JSON.stringify(captured.sourceHeads)
}
function scheduleDeliveryRetry(current: ReturnType<typeof setTimeout> | undefined, attempts: number, schedule: () => void) {
  if (current) clearTimeout(current)
  return setTimeout(schedule, retryDelays[Math.min(attempts - 1, retryDelays.length - 1)] ?? retryDelays.at(-1))
}

async function deliverBoard(input: PublicBoardDeliveryInput, captured: DeliveryCapture, disposed: boolean) {
  const sameSource = (value: DeliveryCapture) => sameDeliverySource(input, value, disposed)
  const before = await currentEditorCredential(captured, sameSource)
  const { deliverPublicBoard } = await import("../public/publicDelivery")
  const ensureCurrent = async () => { await currentEditorCredential(captured, sameSource) }
  return await deliverPublicBoard({ origin: input.origin, boardId: captured.boardId, workspaceId: captured.workspaceId,
    identity: captured.profile.identity, deviceId: captured.profile.device.deviceId, certificates: before.writerCertificates,
    grant: before.grant, sourceHeads: captured.sourceHeads, ensureCurrent,
    ensureSourceCovers: async heads => {
      const { includesWorkspaceHeads } = await import("../storageCatalog")
      if (!includesWorkspaceHeads(captured.document, heads)) throw new Error("Synchronize board before public delivery")
    },
    sign: async (payload: PublicDeliveryCommand) => {
      const [{ resolveLocalSigningContext }, { signWithContext }] = await Promise.all([
        import("../domain/localSigningContext"), import("../domain/signingContext"),
      ])
      const current = await currentEditorCredential(captured, sameSource)
      const context = await resolveLocalSigningContext(captured.profile, "rusty-publication-command", payload, {
        certificates: current.writerCertificates, ensureCurrent,
        currentAuthority: async () => {
          const live = await currentEditorCredential(captured, sameSource)
          const { canonicalizeJson } = await import("../domain/identity")
          return canonicalizeJson([live.credential.ownerPersonId, live.credential.ownerPublicKey,
            live.credential.epoch, live.grant, live.authority.scopeAuthoritySnapshot])
        },
      })
      return signWithContext(context, payload)
    },
    buildProjection: async (current: PublicBoardProjection, stageAsset) => {
      const [{ snapshotPublicBoardSource }, { createBrowserBoardPublication }] = await Promise.all([
        import("../public/publicProjection"), import("./publicBoardPublication"),
      ])
      if (current.board.id !== captured.boardId) throw new Error("Public projection belongs to another board")
      const publication = await createBrowserBoardPublication(snapshotPublicBoardSource(captured.document, captured.boardId),
        captured.workspaceId, captured.boardId, stageAsset)
      return publication.projection
    },
  })
}

/** Retries delivery from admitted durable source; works while settings are closed. */
export function usePublicBoardDelivery(input: PublicBoardDeliveryInput) {
  const status = ref<DeliveryStatus>("idle")
  const error = ref("")
  const deliveredHeads = ref<string[]>([])
  const busy = computed(() => status.value === "sending")
  let timer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let queued = false
  let disposed = false
  let lastAttempts = 0

  function capture() {
    const workspaceId = input.workspaceId(), boardId = input.boardId(), document = input.document(), profile = input.profile()
    const sourceHeads = sortedHeads(input.sourceHeads())
    if (input.role() !== "editor" || !workspaceId || !boardId || !document || !profile || document.id !== workspaceId || sourceHeads.length === 0) {
      throw new Error("Current editor, board, or admitted source is unavailable")
    }
    return { workspaceId, boardId, document, profile, sourceHeads, sourceVersion: input.sourceVersion() }
  }
  function schedule(delay = input.debounceMs ?? 350) {
    if (disposed || input.role() !== "editor") return
    queued = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; void deliver() }, delay)
  }
  function scheduleRetry() {
    retryTimer = scheduleDeliveryRetry(retryTimer, lastAttempts, () => { retryTimer = undefined; schedule(0) })
  }
  async function deliver() {
    if (!canStartDelivery(running, disposed, input.role())) { queued = true; return }
    queued = false
    running = true
    status.value = "sending"
    error.value = ""
    let captured: ReturnType<typeof capture> | undefined
    try {
      captured = capture()
      const key = markerKey(captured.workspaceId, captured.boardId, captured.profile.identity.personId, captured.profile.device.deviceId)
        const { readLocal } = await import("../localDb")
        const previous = parseMarker(await readLocal(key))
      lastAttempts = previous?.status === "retry" ? previous.attempts : 0
      const marker = deliveryMarker(captured, "sending", lastAttempts)
      await persistDeliveryMarker(captured, marker)
      const result = await deliverBoard(input, captured, disposed)
      if (!sameDeliverySource(input, captured, disposed)) throw new Error("Editor source changed before delivery was confirmed")
      status.value = result ? "delivered" : "private"
      deliveredHeads.value = result ? captured.sourceHeads : []
      lastAttempts = 0
      await persistDeliveryMarker(captured, deliveryMarker(captured, status.value, 0))
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "Public delivery failed"
      lastAttempts++
      status.value = input.role() === "editor" ? "retry" : "blocked"
      if (captured) await persistDeliveryMarker(captured, deliveryMarker(captured, status.value, lastAttempts)).catch(() => {})
      if (status.value === "retry") scheduleRetry()
    } finally {
      running = false
      if (queued && input.role() === "editor") schedule(0)
    }
  }

  watch(() => deliveryAccessKey(input), async () => {
    if (timer) clearTimeout(timer)
    if (retryTimer) clearTimeout(retryTimer)
    queued = false
    error.value = ""
    deliveredHeads.value = []
    status.value = input.role() === "editor" ? "waiting" : "idle"
    if (input.role() === "editor") {
      try {
        const captured = capture()
        const { readLocal } = await import("../localDb")
        const marker = parseMarker(await readLocal(markerKey(captured.workspaceId, captured.boardId,
          captured.profile.identity.personId, captured.profile.device.deviceId)))
        if (disposed || input.role() !== "editor") return
        if (marker?.status === "retry") { lastAttempts = marker.attempts; scheduleRetry() }
        else schedule(0)
      } catch { status.value = "blocked" }
    }
  }, { immediate: true })
  watch(() => input.sourceVersion(), () => {
    if (input.role() === "editor") { status.value = "waiting"; schedule() }
  })
  watch(() => input.role(), role => {
    if (role !== "editor") {
      if (timer) clearTimeout(timer)
      if (retryTimer) clearTimeout(retryTimer)
      queued = false
      status.value = "idle"
    } else schedule(0)
  })
  onScopeDispose(() => { disposed = true; if (timer) clearTimeout(timer); if (retryTimer) clearTimeout(retryTimer) })
  return { status, busy, error, deliveredHeads, retry: () => schedule(0) }
}
