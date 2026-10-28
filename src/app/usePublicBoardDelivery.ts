import { computed, onScopeDispose, ref, watch } from "vue"
import type { LocalProfile } from "../domain/identity"
import type { WorkspaceDocumentV2, WorkspaceGrant } from "../domain/model"
import type { WorkspaceAuthorityRecord } from "../sync/peerStore"
import type { PublicBoardProjection } from "../public/publicSchema"
import type { PublicDeliveryCommand } from "../public/publicDelivery"

type DeliveryStatus = "idle" | "waiting" | "checking" | "sending" | "delivered" | "private" | "retry" | "blocked"
class PublicDeliveryAccessError extends Error {
  constructor() { super("Editor access could not be verified on this device. Open Sync to reconnect and check board access.") }
}
type DeliveryMarker = { version: 1; workspaceId: string; boardId: string; sourceHeads: string[]; status: DeliveryStatus; attempts: number; updatedAt: number }
type DeliveryCapture = { origin: string; workspaceId: string; boardId: string; document: WorkspaceDocumentV2; profile: LocalProfile; sourceHeads: string[]; sourceVersion: number }
export interface PublicBoardDeliveryInput {
  origin: () => string
  workspaceId: () => string
  boardId: () => string | undefined
  document: () => WorkspaceDocumentV2 | null | undefined
  sourceVersion: () => number
  sourceHeads: () => string[]
  role: () => string | null | undefined
  profile: () => LocalProfile | null | undefined
  authorityVersion?: () => number
  recoveryActive?: () => boolean
  debounceMs?: number
}

const retryDelays = [2_000, 5_000, 15_000, 30_000, 60_000]
function markerKey(workspaceId: string, boardId: string, personId: string, deviceId: string, origin: string) {
  return `tincanban.public-delivery.v1:${encodeURIComponent(workspaceId)}:${encodeURIComponent(boardId)}:${encodeURIComponent(personId)}:${encodeURIComponent(deviceId)}:${encodeURIComponent(origin)}`
}
function sortedHeads(heads: string[]) { return [...new Set(heads)].sort() }
function parseMarker(raw: string | null): DeliveryMarker | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as Partial<DeliveryMarker>
    if (value.version !== 1 || typeof value.workspaceId !== "string" || typeof value.boardId !== "string" ||
        !Array.isArray(value.sourceHeads) || !value.sourceHeads.every(head => typeof head === "string") ||
        !["idle", "waiting", "checking", "sending", "delivered", "private", "retry", "blocked"].includes(String(value.status)) ||
        !Number.isSafeInteger(value.attempts) || !Number.isSafeInteger(value.updatedAt)) return undefined
    return value as DeliveryMarker
  } catch { return undefined }
}
async function currentEditorAuthority(captured: DeliveryCapture, sameSource: (capture: DeliveryCapture) => boolean) {
  if (!sameSource(captured)) throw new Error("Editor access or source changed during public delivery")
  const authorityState = await readEditorAuthority(captured)
  if (!sameSource(captured)) throw new Error("Editor access or source changed during public delivery")
  return authorityState
}
async function readEditorAuthority(captured: DeliveryCapture) {
  const [peerStoreModule, meshBase, proofs, access, fingerprints] = await Promise.all([
    import("../sync/peerStore"), import("../sync/durableMeshBase"), import("../domain/proofs"),
    import("../sync/changeAuthorization"), import("../sync/authorityFingerprint"),
  ])
  const { peerStore } = peerStoreModule
  // Durable authority owns membership. A replaced or missing connection
  // credential must not hide a current editor grant or historical owner chain.
  const authority = await peerStore.getWorkspaceAuthority(captured.workspaceId).catch(() => { throw new PublicDeliveryAccessError() })
  if (!authority) throw new Error("Waiting for workspace authority. Changes will sync automatically.")
  const grant = authority.localGrant as WorkspaceGrant | undefined
  assertEditorAuthority(authority, grant, captured)
  if (await access.workspaceRole(captured.document, captured.profile) !== "editor") throw new PublicDeliveryAccessError()
  const latest = await peerStore.getWorkspaceAuthority(captured.workspaceId)
  const revision = fingerprints.workspaceAuthorityFingerprint([], [authority!])
  if (revision !== fingerprints.workspaceAuthorityFingerprint([], latest ? [latest] : [])) {
    throw new Error("Editor authority changed during public delivery; retry the action")
  }
  const writerCertificates = meshBase.uniqueCertificates(captured.profile, [captured.profile.certificate, ...await proofs.defaultProofStore.listCertificates()])
  return { grant: grant!, writerCertificates, revision }
}
function assertEditorAuthority(authority: WorkspaceAuthorityRecord | null, grant: WorkspaceGrant | undefined,
  captured: DeliveryCapture) {
  if (!authority || authority.workspaceId !== captured.workspaceId || !grant || grant.payload.workspaceId !== captured.workspaceId ||
      grant.payload.personId !== captured.profile.identity.personId || grant.payload.role !== "editor") throw new PublicDeliveryAccessError()
}
function deliveryMarker(capture: DeliveryCapture, status: DeliveryStatus, attempts: number): DeliveryMarker {
  return { version: 1, workspaceId: capture.workspaceId, boardId: capture.boardId, sourceHeads: capture.sourceHeads,
    status, attempts, updatedAt: Date.now() }
}
async function persistDeliveryMarker(capture: DeliveryCapture, marker: DeliveryMarker) {
  const { writeLocal } = await import("../localDb")
  await writeLocal(markerKey(capture.workspaceId, capture.boardId, capture.profile.identity.personId, capture.profile.device.deviceId, capture.origin), JSON.stringify(marker))
}
function canStartDelivery(running: boolean, disposed: boolean, role: string | null | undefined) {
  return !running && !disposed && role === "editor"
}
function deliveryAccessKey(input: PublicBoardDeliveryInput) {
  return `${input.origin()}:${input.workspaceId()}:${input.boardId() ?? ""}:${input.profile()?.identity.personId ?? ""}:${input.profile()?.device.deviceId ?? ""}`
}
function sameDeliverySource(input: PublicBoardDeliveryInput, captured: DeliveryCapture, disposed: boolean) {
  return !disposed && input.origin() === captured.origin && input.role() === "editor" && input.workspaceId() === captured.workspaceId && input.boardId() === captured.boardId &&
    input.profile()?.identity.personId === captured.profile.identity.personId && input.profile()?.device.deviceId === captured.profile.device.deviceId &&
    input.sourceVersion() === captured.sourceVersion && JSON.stringify(sortedHeads(input.sourceHeads())) === JSON.stringify(captured.sourceHeads)
}
function scheduleDeliveryRetry(current: ReturnType<typeof setTimeout> | undefined, attempts: number, schedule: () => void) {
  if (current) clearTimeout(current)
  return setTimeout(schedule, retryDelays[Math.min(attempts - 1, retryDelays.length - 1)] ?? retryDelays.at(-1))
}

async function deliverBoard(input: PublicBoardDeliveryInput, captured: DeliveryCapture, disposed: () => boolean, discoveredPublic: () => void) {
  const sameSource = (value: DeliveryCapture) => sameDeliverySource(input, value, disposed())
  let writerResolved = false
  const [{ deliverPublicBoard }, { fetchBlind, readBlindJson }] = await Promise.all([
    import("../public/publicDelivery"), import("../sync/rustyHttp"),
  ])
  const ensureCurrent = async () => {
    if (!sameSource(captured)) throw new Error("Editor access or source changed during public delivery")
    if (writerResolved) await currentEditorAuthority(captured, sameSource)
  }
  return await deliverPublicBoard({ origin: captured.origin, boardId: captured.boardId, workspaceId: captured.workspaceId,
    identity: captured.profile.identity, deviceId: captured.profile.device.deviceId,
    sourceHeads: captured.sourceHeads, ensureCurrent,
    resolveWriter: async () => {
      if (!sameSource(captured)) throw new Error("Editor access or source changed during public delivery")
      discoveredPublic()
      const current = await currentEditorAuthority(captured, sameSource)
      writerResolved = true
      return { certificates: current.writerCertificates, grant: current.grant }
    },
    http: { request: (url, init, diagnosticContext) => fetchBlind(url, { ...init, diagnosticContext }), readJson: readBlindJson },
    ensureSourceCovers: async heads => {
      const { includesWorkspaceHeads } = await import("../storageCatalog")
      if (!includesWorkspaceHeads(captured.document, heads)) throw new Error("Synchronize board before public delivery")
    },
    sign: async (payload: PublicDeliveryCommand) => {
      const [{ resolveLocalSigningContext }, { signWithContext }] = await Promise.all([
        import("../domain/localSigningContext"), import("../domain/signingContext"),
      ])
      const current = await currentEditorAuthority(captured, sameSource)
      const context = await resolveLocalSigningContext(captured.profile, "rusty-publication-command", payload, {
        certificates: current.writerCertificates, ensureCurrent,
        currentAuthority: async () => {
          const live = await currentEditorAuthority(captured, sameSource)
          return live.revision
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
  const busy = computed(() => status.value === "checking" || status.value === "sending")
  let publicAvailable = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let queued = false
  let disposed = false
  let lastAttempts = 0

  function capture() {
    const origin = input.origin()
    const workspaceId = input.workspaceId(), boardId = input.boardId(), document = input.document(), profile = input.profile()
    const sourceHeads = sortedHeads(input.sourceHeads())
    if (!origin || input.role() !== "editor" || !workspaceId || !boardId || !document || !profile || document.id !== workspaceId || sourceHeads.length === 0) {
      throw new Error("Current editor, board, or admitted source is unavailable")
    }
    return { origin, workspaceId, boardId, document, profile, sourceHeads, sourceVersion: input.sourceVersion() }
  }
  function schedule(delay = input.debounceMs ?? 350) {
    if (disposed || !input.origin() || input.role() !== "editor") return
    queued = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; void deliver() }, delay)
  }
  function scheduleRetry() {
    retryTimer = scheduleDeliveryRetry(retryTimer, lastAttempts, () => { retryTimer = undefined; schedule(0) })
  }
  async function handleDeliveryFailure(captured: DeliveryCapture | undefined, cause: unknown) {
    if (captured && !sameDeliverySource(input, captured, disposed)) return
    error.value = publicAvailable ? cause instanceof Error ? cause.message : "Could not send changes to the public board." : ""
    lastAttempts++
    status.value = input.role() === "editor" && !(cause instanceof PublicDeliveryAccessError) ? "retry" : "blocked"
    if (captured) await persistDeliveryMarker(captured, deliveryMarker(captured, status.value, lastAttempts)).catch(() => {})
    if (status.value === "retry") scheduleRetry()
  }
  async function deliver() {
    if (!input.origin() || !canStartDelivery(running, disposed, input.role())) { queued = true; return }
    queued = false
    running = true
    status.value = "checking"
    error.value = ""
    let captured: ReturnType<typeof capture> | undefined
    try {
      captured = capture()
      const key = markerKey(captured.workspaceId, captured.boardId, captured.profile.identity.personId, captured.profile.device.deviceId, captured.origin)
      const { readLocal } = await import("../localDb")
      const previous = parseMarker(await readLocal(key))
      lastAttempts = previous?.status === "retry" ? previous.attempts : 0
      const marker = deliveryMarker(captured, "sending", lastAttempts)
      await persistDeliveryMarker(captured, marker)
      const result = await deliverBoard(input, captured, () => disposed, () => { publicAvailable = true; status.value = "sending" })
      if (!sameDeliverySource(input, captured, disposed)) throw new Error("Editor source changed before delivery was confirmed")
      status.value = result ? "delivered" : "private"
      publicAvailable = Boolean(result)
      deliveredHeads.value = result ? captured.sourceHeads : []
      lastAttempts = 0
      await persistDeliveryMarker(captured, deliveryMarker(captured, status.value, 0))
    } catch (cause) {
      await handleDeliveryFailure(captured, cause)
    } finally {
      running = false
      if (queued && input.origin() && input.role() === "editor") schedule(0)
    }
  }

  watch(() => deliveryAccessKey(input), async () => {
    if (timer) clearTimeout(timer)
    if (retryTimer) clearTimeout(retryTimer)
    queued = false
    publicAvailable = false
    error.value = ""
    deliveredHeads.value = []
    status.value = input.origin() && input.role() === "editor" ? "waiting" : "idle"
    if (input.origin() && input.role() === "editor") {
      try {
        const captured = capture()
        const { readLocal } = await import("../localDb")
        const marker = parseMarker(await readLocal(markerKey(captured.workspaceId, captured.boardId,
          captured.profile.identity.personId, captured.profile.device.deviceId, captured.origin)))
        if (disposed || input.role() !== "editor") return
        if (marker?.status === "retry") { lastAttempts = marker.attempts; scheduleRetry() }
        else schedule(0)
      } catch { status.value = "blocked" }
    }
  }, { immediate: true })
  watch(() => input.sourceVersion(), () => {
    if (input.origin() && input.role() === "editor") { status.value = "waiting"; schedule() }
  })
  watch(() => input.role(), role => {
    if (role !== "editor") {
      if (timer) clearTimeout(timer)
      if (retryTimer) clearTimeout(retryTimer)
      queued = false
      status.value = "idle"
      error.value = ""
    } else schedule(0)
  })
  watch(() => input.authorityVersion?.() ?? 0, () => {
    if (status.value === "blocked" || status.value === "retry") schedule(0)
  })
  watch(() => input.recoveryActive?.() ?? false, (active, wasActive) => {
    if (wasActive && !active && status.value === "blocked") schedule(0)
  })
  onScopeDispose(() => { disposed = true; if (timer) clearTimeout(timer); if (retryTimer) clearTimeout(retryTimer) })
  return { status, busy, error, deliveredHeads, retry: () => schedule(0) }
}
