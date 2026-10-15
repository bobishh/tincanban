import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import { StorageDeltaAccess } from "./storageDeltaAccess"
import { openWorkspaceJournal, readWorkspaceBasisSnapshot, requestResult, transactionDone, type StoredWorkspaceSnapshot } from "./storageJournal"

type VerifiedHistory = { baselineId: string; candidate: WasmVerifiedReceivedHistoryBaseline; personId?: string; deviceId?: string }
type CapturedHistory = { candidate: WasmVerifiedReceivedHistoryBaseline; workspaceId: string; baselineId: string;
  signedJson: Uint8Array; bytes: Uint8Array }
type StoredBaseline = { state?: string; baselineId?: string; signedJson?: Uint8Array; document?: Uint8Array }

function sameBytes(left: Uint8Array | undefined, right: Uint8Array) {
  return left?.length === right.length && right.every((byte, index) => byte === left?.[index])
}

async function captureNativeHistory(value: unknown): Promise<CapturedHistory> {
  const { WasmVerifiedReceivedHistoryBaseline } = await import("@meta-uber/mesh-transport/wasm")
  if (!(value instanceof WasmVerifiedReceivedHistoryBaseline)) throw new Error("Received history requires a Native-verified baseline")
  const signedJson = value.originalJson(), bytes = value.document()
  const envelope = value.envelope() as { payload?: { workspaceId?: unknown; baselineId?: unknown } }
  const workspaceId = envelope.payload?.workspaceId, baselineId = envelope.payload?.baselineId
  if (typeof workspaceId !== "string" || typeof baselineId !== "string" || !baselineId ||
      !(signedJson instanceof Uint8Array) || !(bytes instanceof Uint8Array)) throw new Error("Native received history result is malformed")
  return { candidate: value, workspaceId, baselineId, signedJson: signedJson.slice(), bytes: bytes.slice() }
}

async function assertActiveHistory(captured: CapturedHistory, ensureCurrent: () => void) {
  const database = await openWorkspaceJournal()
  ensureCurrent()
  const transaction = database.transaction(["snapshots", "receivedBaselines"], "readonly")
  const completion = transactionDone(transaction)
  const [snapshot, baseline] = await Promise.all([
    requestResult(transaction.objectStore("snapshots").get(captured.workspaceId)) as Promise<StoredWorkspaceSnapshot | undefined>,
    requestResult(transaction.objectStore("receivedBaselines").get(`${captured.workspaceId}:baseline:${captured.baselineId}`)) as Promise<StoredBaseline | undefined>,
  ])
  await completion
  ensureCurrent()
  if (!snapshot?.receivedHistory || snapshot.receivedHistory.baselineId !== captured.baselineId ||
      baseline?.state !== "active" || baseline.baselineId !== captured.baselineId ||
      !sameBytes(baseline.signedJson, captured.signedJson) || !sameBytes(baseline.document, captured.bytes))
    throw new Error("Native verification does not match the active received history")
}

export abstract class StorageHistoryAccess extends StorageDeltaAccess {
  private verifiedReceivedHistory = new Map<string, VerifiedHistory>()

  protected forgetReceivedHistory(workspaceId: string) {
    // Readers borrow this wrapper across awaits. Drop only the cache reference;
    // wasm-bindgen finalization owns release once every borrower is unreachable.
    this.verifiedReceivedHistory.delete(workspaceId)
  }

  /** Marker reads never assemble or serialize the active delta document. */
  protected async ensureReceivedHistory(workspaceId: string): Promise<void> {
    const snapshot = await readWorkspaceBasisSnapshot(workspaceId)
    if (!snapshot?.receivedHistory) return
    const verified = await this.currentIdentityHistory(workspaceId)
    if (verified?.baselineId !== snapshot.receivedHistory.baselineId) await this.reverifyReceivedHistory(workspaceId)
    if (this.verifiedReceivedHistory.get(workspaceId)?.baselineId !== snapshot.receivedHistory.baselineId)
      throw new Error("Received workspace history could not be reverified")
  }

  private async currentIdentityHistory(workspaceId: string) {
    const cached = this.verifiedReceivedHistory.get(workspaceId)
    const { stateRuntime } = await import("./stateContext")
    const current = stateRuntime.currentProfile
    if (cached?.personId && cached.personId !== current?.identity.personId ||
        cached?.deviceId && cached.deviceId !== current?.device.deviceId) {
      this.forgetReceivedHistory(workspaceId)
      return undefined
    }
    return cached
  }

  private async reverifyReceivedHistory(workspaceId: string) {
    const [{ bootstrapIdentity }, { stateRuntime }, { reverifyActiveHistoryForWorkspace }] = await Promise.all([
      import("./domain/identity"), import("./stateContext"), import("./sync/historyBaselineStartup"),
    ])
    const profile = await bootstrapIdentity()
    const ensureCurrent = () => {
      const current = stateRuntime.currentProfile
      if (current && (current.identity.personId !== profile.identity.personId || current.device.deviceId !== profile.device.deviceId ||
          current.identity.publicKey !== profile.identity.publicKey || current.device.publicKey !== profile.device.publicKey))
        throw new Error("Identity changed during received history verification")
    }
    const candidate = await reverifyActiveHistoryForWorkspace(workspaceId, profile.identity.personId, ensureCurrent)
    if (!candidate) throw new Error("Received workspace history basis is missing")
    await this.acceptVerifiedReceivedHistoryBaseline(candidate, ensureCurrent)
  }

  /** Cache only an opaque Native result after its exact durable source is reverified. */
  async acceptVerifiedReceivedHistoryBaseline(candidate: unknown, ensureCurrent: () => void): Promise<void> {
    ensureCurrent()
    const { stateRuntime } = await import("./stateContext")
    const personId = stateRuntime.currentProfile?.identity.personId, deviceId = stateRuntime.currentProfile?.device.deviceId
    const captured = await captureNativeHistory(candidate)
    await assertActiveHistory(captured, ensureCurrent)
    this.verifiedReceivedHistory.delete(captured.workspaceId)
    this.verifiedReceivedHistory.set(captured.workspaceId, { baselineId: captured.baselineId, candidate: captured.candidate, personId, deviceId })
    while (this.verifiedReceivedHistory.size > 8) this.forgetReceivedHistory(this.verifiedReceivedHistory.keys().next().value!)
  }

  /** Return a cached Native handle only while its exact baseline and device remain active. */
  async getVerifiedReceivedHistoryBaseline(workspaceId: string, ensureCurrent: () => void = () => {}): Promise<WasmVerifiedReceivedHistoryBaseline | undefined> {
    ensureCurrent()
    const progress = await this.ensureHistoryProgress(workspaceId)
    ensureCurrent()
    const cached = this.verifiedReceivedHistory.get(workspaceId)
    if (!progress.baselineId || !cached || cached.baselineId !== progress.baselineId) {
      if (cached && cached.baselineId !== progress.baselineId) this.forgetReceivedHistory(workspaceId)
      return undefined
    }
    const current = await this.currentIdentityHistory(workspaceId)
    ensureCurrent()
    return current?.candidate
  }
}
