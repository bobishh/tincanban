import * as Automerge from "@automerge/automerge/slim"
import { computed, effectScope, onScopeDispose, ref, shallowRef, watch, type Ref } from "vue"
import type { LocalProfile } from "../domain/identity"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { hasEntityKind } from "../domain/model"
import type { WorkspaceRole } from "../domain/permissions"
import { subscribeChat, type ChatChange } from "../chat/service"
import { workspaceRole } from "../sync/changeAuthorization"
import { usePublicBoardAccess, type PublicBoardAccessInput } from "./usePublicBoardAccess"
import { usePublicBoardDelivery, type PublicBoardDeliveryInput } from "./usePublicBoardDelivery"
import { createPublicDeliveryQueue } from "./publicDeliveryQueue"

type DeliveryRole = "owner" | "editor"
type ScopedDelivery = {
  workspaceId: string; boardId: string; role: DeliveryRole; verifiedRole: Ref<WorkspaceRole | null>
  scope: ReturnType<typeof effectScope>; document: Ref<WorkspaceDocumentV2 | null>
  sourceVersion: Ref<number>; sourceHeads: Ref<string[]>
  access?: ReturnType<typeof usePublicBoardAccess>; editor?: ReturnType<typeof usePublicBoardDelivery>
}
export type PublicBoardDeliveryCoordinatorInput = {
  origin: string; ready: () => boolean; workspaceIds: () => string[]
  profile: () => LocalProfile | null | undefined
  readWorkspaceDoc: (workspaceId: string) => Promise<WorkspaceDocumentV2>
  subscribeLocalChanges: (listener: (workspaceId?: string) => void) => () => void
  subscribeChat?: (listener: (event: ChatChange) => void) => () => void
  activeBoard?: () => { workspaceId: string; boardId: string } | null | undefined
  debounceMs?: number
}

const retryDelays = [2_000, 5_000, 15_000, 30_000, 60_000]

/** Keeps publication delivery running for admitted boards outside the selected UI workspace. */
export function usePublicBoardDeliveryCoordinator(input: PublicBoardDeliveryCoordinatorInput) {
  const coordinator = new PublicDeliveryCoordinator(input)
  return coordinator.start()
}

class PublicDeliveryCoordinator {
  readonly errors = ref<Record<string, string>>({})
  readonly deliveries = shallowRef<ScopedDelivery[]>([])
  private eligible = new Set<string>()
  private scoped = new Map<string, ScopedDelivery>()
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private retryAttempts = new Map<string, number>()
  private stopped = false
  private lastProfileKey = ""
  private queue: ReturnType<typeof createPublicDeliveryQueue>
  private stopWorkspace?: () => void
  private stopChat?: () => void

  constructor(private input: PublicBoardDeliveryCoordinatorInput) {
    this.queue = createPublicDeliveryQueue(id => this.processWorkspace(id), input.debounceMs ?? 200,
      (id, error) => this.handleWorkspaceError(id, error))
  }

  start() {
    this.stopWorkspace = this.input.subscribeLocalChanges(id => {
      if (!id) return
      this.invalidateRole(id)
      this.queue.enqueue(id)
    })
    this.stopChat = (this.input.subscribeChat ?? subscribeChat)(event => {
      this.invalidateRole(event.workspaceId)
      this.queue.enqueue(event.workspaceId)
    })
    watch(() => `${this.input.ready()}:${[...this.input.workspaceIds()].sort().join("|")}:${this.profileKey()}`,
      () => this.reconcileCatalog(), { immediate: true })
    watch(() => this.activeBoardKey(), (next, previous) => this.activeBoardChanged(next, previous))
    onScopeDispose(() => this.dispose())
    return { status: computed(() => this.status()), errors: this.errors }
  }

  private profileKey() {
    const profile = this.input.profile()
    return `${profile?.identity.personId ?? ""}:${profile?.device.deviceId ?? ""}`
  }

  private activeBoardKey() {
    const active = this.input.activeBoard?.()
    return active ? `${active.workspaceId}\u0000${active.boardId}` : ""
  }

  private activeBoardChanged(next: string, previous: string) {
    if (next) {
      const [workspaceId, boardId] = next.split("\u0000")
      const delivery = this.scoped.get(this.markerKey(workspaceId!, boardId!))
      delivery?.scope.stop()
      if (delivery) this.scoped.delete(this.markerKey(workspaceId!, boardId!))
    }
    this.syncList()
    for (const value of [next, previous]) {
      const workspaceId = value.split("\u0000", 1)[0]
      if (workspaceId) this.queue.enqueue(workspaceId)
    }
  }

  private status() {
    return this.deliveries.value.map(delivery => ({
      workspaceId: delivery.workspaceId, boardId: delivery.boardId, role: delivery.role,
      busy: delivery.access?.busy.value ?? delivery.editor?.busy.value ?? false,
      published: delivery.access?.published.value ?? delivery.editor?.status.value === "delivered",
      error: delivery.access?.error.value ?? delivery.editor?.error.value ?? "",
    }))
  }

  private syncList() { this.deliveries.value = [...this.scoped.values()] }
  private markerKey(workspaceId: string, boardId: string) { return `${workspaceId}\u0000${boardId}` }

  private createDelivery(workspaceId: string, boardId: string, role: DeliveryRole, doc: WorkspaceDocumentV2) {
    const document = shallowRef<WorkspaceDocumentV2 | null>(doc)
    const sourceVersion = ref(1)
    const sourceHeads = ref(Automerge.getHeads(doc))
    const verifiedRole = ref<WorkspaceRole | null>(role)
    const scope = effectScope()
    const delivery: ScopedDelivery = { workspaceId, boardId, role, verifiedRole, scope, document, sourceVersion, sourceHeads }
    scope.run(() => this.installBoardHook(delivery))
    this.scoped.set(this.markerKey(workspaceId, boardId), delivery)
    return delivery
  }

  private installBoardHook(delivery: ScopedDelivery) {
    const shared = {
      origin: this.input.origin, workspaceId: () => delivery.workspaceId, boardId: () => delivery.boardId,
      document: () => delivery.document.value, sourceVersion: () => delivery.sourceVersion.value,
      sourceHeads: () => delivery.sourceHeads.value, profile: this.input.profile, debounceMs: this.input.debounceMs,
    }
    if (delivery.role === "owner") {
      const accessInput: PublicBoardAccessInput = { ...shared,
        boardTitle: () => delivery.document.value?.entities[delivery.boardId]?.title ?? "",
        owner: () => delivery.verifiedRole.value === "owner" }
      delivery.access = usePublicBoardAccess(accessInput)
    } else {
      const editorInput: PublicBoardDeliveryInput = { ...shared, role: () => delivery.verifiedRole.value }
      delivery.editor = usePublicBoardDelivery(editorInput)
    }
  }

  private updateDelivery(delivery: ScopedDelivery, doc: WorkspaceDocumentV2, role: DeliveryRole) {
    delivery.document.value = doc
    delivery.sourceHeads.value = Automerge.getHeads(doc)
    delivery.sourceVersion.value++
    delivery.verifiedRole.value = role
  }

  private upsertBoard(workspaceId: string, boardId: string, role: DeliveryRole, doc: WorkspaceDocumentV2, seen: Set<string>) {
    const id = this.markerKey(workspaceId, boardId)
    seen.add(id)
    const previous = this.scoped.get(id)
    if (previous?.role === role) { this.updateDelivery(previous, doc, role); return }
    previous?.scope.stop()
    if (previous) this.scoped.delete(id)
    this.createDelivery(workspaceId, boardId, role, doc)
  }

  private async loadCandidate(workspaceId: string) {
    if (this.stopped || !this.eligible.has(workspaceId) || !this.input.ready()) return null
    const profile = this.input.profile()
    if (!profile) return null
    const doc = await this.input.readWorkspaceDoc(workspaceId)
    if (!this.isCurrent(workspaceId, profile)) return null
    if (doc.id !== workspaceId) throw new Error("Loaded workspace does not match its catalog identity")
    return { profile, doc }
  }

  private isCurrent(workspaceId: string, profile: LocalProfile) {
    const current = this.input.profile()
    return !this.stopped && this.eligible.has(workspaceId) && this.input.ready() &&
      current?.identity.personId === profile.identity.personId && current?.device.deviceId === profile.device.deviceId
  }

  private async verifyRole(workspaceId: string, profile: LocalProfile, doc: WorkspaceDocumentV2) {
    try { return await workspaceRole(doc, profile) }
    catch (error) { this.dropWorkspace(workspaceId); throw error }
  }

  private async processWorkspace(workspaceId: string) {
    const candidate = await this.loadCandidate(workspaceId)
    if (!candidate) return
    const role = await this.verifyRole(workspaceId, candidate.profile, candidate.doc)
    if (!this.isCurrent(workspaceId, candidate.profile)) return
    if (role !== "owner" && role !== "editor") { this.dropWorkspace(workspaceId); return }
    this.syncWorkspaceBoards(workspaceId, candidate.doc, role)
    delete this.errors.value[workspaceId]
    this.retryAttempts.delete(workspaceId)
    this.clearRetry(workspaceId)
  }

  private syncWorkspaceBoards(workspaceId: string, doc: WorkspaceDocumentV2, role: DeliveryRole) {
    const seen = new Set<string>()
    const active = this.input.activeBoard?.()
    for (const entity of Object.values(doc.entities)) {
      if (!hasEntityKind(entity, "board") || entity.archivedAt ||
          active?.workspaceId === workspaceId && active.boardId === entity.id) continue
      this.upsertBoard(workspaceId, entity.id, role, doc, seen)
    }
    this.removeMissingBoards(workspaceId, seen)
    this.syncList()
  }

  private removeMissingBoards(workspaceId: string, seen: Set<string>) {
    for (const [id, delivery] of this.scoped) {
      if (delivery.workspaceId !== workspaceId || seen.has(id)) continue
      delivery.scope.stop()
      this.scoped.delete(id)
    }
  }

  private invalidateRole(workspaceId: string) {
    for (const delivery of this.scoped.values()) {
      if (delivery.workspaceId === workspaceId) delivery.verifiedRole.value = null
    }
  }

  private async handleWorkspaceError(workspaceId: string, error: unknown) {
    this.errors.value[workspaceId] = error instanceof Error ? error.message : "Could not check public board delivery"
    this.scheduleRetry(workspaceId)
  }

  private scheduleRetry(workspaceId: string) {
    this.clearRetry(workspaceId)
    const attempt = this.retryAttempts.get(workspaceId) ?? 0
    this.retryAttempts.set(workspaceId, attempt + 1)
    this.retryTimers.set(workspaceId, setTimeout(() => {
      this.retryTimers.delete(workspaceId)
      this.queue.enqueue(workspaceId)
    }, retryDelays[Math.min(attempt, retryDelays.length - 1)]!))
  }

  private clearRetry(workspaceId: string) {
    const timer = this.retryTimers.get(workspaceId)
    if (timer) clearTimeout(timer)
    this.retryTimers.delete(workspaceId)
  }

  private dropWorkspace(workspaceId: string) {
    for (const [id, delivery] of this.scoped) {
      if (delivery.workspaceId !== workspaceId) continue
      delivery.scope.stop()
      this.scoped.delete(id)
    }
    this.syncList()
  }

  private reconcileCatalog() {
    if (this.stopped) return
    const identityKey = this.profileKey()
    if (identityKey !== this.lastProfileKey) {
      this.lastProfileKey = identityKey
      for (const workspaceId of this.eligible) this.dropWorkspace(workspaceId)
      this.eligible.clear()
      this.errors.value = {}
    }
    if (!this.input.ready()) {
      for (const workspaceId of this.eligible) this.dropWorkspace(workspaceId)
      this.eligible.clear()
      return
    }
    const next = new Set(this.input.workspaceIds().filter(Boolean))
    for (const workspaceId of this.eligible) {
      if (next.has(workspaceId)) continue
      this.eligible.delete(workspaceId)
      this.clearRetry(workspaceId)
      this.dropWorkspace(workspaceId)
    }
    for (const workspaceId of next) {
      if (this.eligible.has(workspaceId)) continue
      this.eligible.add(workspaceId)
      this.queue.enqueue(workspaceId)
    }
  }

  private dispose() {
    this.stopped = true
    this.queue.stop()
    this.stopWorkspace?.()
    this.stopChat?.()
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    for (const delivery of this.scoped.values()) delivery.scope.stop()
    this.scoped.clear()
  }
}
