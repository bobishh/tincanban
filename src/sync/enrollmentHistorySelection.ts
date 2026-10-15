import { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import { toBase64Url } from "../domain/identity"
import { capturePeerHistoryBaselineDescriptor, type PeerHistoryBaselineDescriptor } from "./workspaceSetHistory"
import type { WorkspaceSetStore } from "./workspaceSet"

function same(left: PeerHistoryBaselineDescriptor, right: PeerHistoryBaselineDescriptor) {
  return left.baselineId === right.baselineId && left.signedJson === right.signedJson &&
    left.documentDigest === right.documentDigest && left.documentLength === right.documentLength
}

/** Local enrollment may expand its reading scope only through an opaque Native-verified signed parent edge. */
export class EnrollmentHistorySelection {
  private readonly roots = new Map<string, PeerHistoryBaselineDescriptor>()
  private readonly permitted = new Map<string, Set<string>>()
  constructor(private readonly store: Pick<WorkspaceSetStore, "readHistoryBaseline">, private readonly selected: Set<string>,
    private readonly ensureCurrent: () => void | Promise<void>) {}

  private async current(workspaceId: string) {
    if (!this.selected.has(workspaceId)) throw new Error("Enrollment history workspace is not selected")
    await this.ensureCurrent()
    if (!this.store.readHistoryBaseline) throw new Error("Local enrollment history source is unavailable")
    const raw = await this.store.readHistoryBaseline(workspaceId)
    await this.ensureCurrent()
    const descriptor = raw === undefined ? undefined : capturePeerHistoryBaselineDescriptor(raw)
    const root = this.roots.get(workspaceId)
    if (root && (!descriptor || !same(root, descriptor))) throw new Error("Local enrollment history baseline changed")
    if (descriptor && !root) this.roots.set(workspaceId, descriptor)
    return descriptor
  }

  async read(workspaceId: string, baselineId?: string): Promise<PeerHistoryBaselineDescriptor | undefined> {
    const current = await this.current(workspaceId)
    if (!baselineId || current?.baselineId === baselineId) return current
    if (!this.permitted.get(workspaceId)?.has(baselineId)) throw new Error("Enrollment history descriptor changed or ancestor is not Native-verified")
    const raw = await this.store.readHistoryBaseline!(workspaceId, baselineId)
    await this.ensureCurrent()
    const descriptor = raw === undefined ? undefined : capturePeerHistoryBaselineDescriptor(raw)
    if (descriptor && descriptor.baselineId !== baselineId) throw new Error("Local enrollment history ancestor changed")
    await this.current(workspaceId)
    return descriptor
  }

  async assertDescriptor(expected: PeerHistoryBaselineDescriptor, workspaceId: string) {
    const current = await this.read(workspaceId, expected.baselineId)
    if (!current || !same(current, expected)) throw new Error("Local enrollment history baseline changed")
  }

  async authorizeAncestor(basis: WasmVerifiedReceivedHistoryBaseline) {
    if (!(basis instanceof WasmVerifiedReceivedHistoryBaseline)) throw new Error("Enrollment ancestor requires a Native-verified child")
    const payload = (basis.envelope() as { payload: { workspaceId: string; baselineId: string; previousBaselineId?: unknown } }).payload
    const descriptor = await this.read(payload.workspaceId, payload.baselineId)
    if (!descriptor || descriptor.signedJson !== toBase64Url(basis.originalJson())) throw new Error("Verified enrollment child differs from its local source")
    const id = payload.previousBaselineId
    if (id === undefined || id === null) return
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(id) || id === payload.baselineId) throw new Error("Verified enrollment ancestor is malformed")
    const allowed = this.permitted.get(payload.workspaceId) ?? new Set<string>()
    if (allowed.size >= 256 && !allowed.has(id)) throw new Error("Enrollment history lineage exceeds its bound")
    allowed.add(id); this.permitted.set(payload.workspaceId, allowed)
  }
}
