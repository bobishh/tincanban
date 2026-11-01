import type { LocalProfile } from "../domain/identity"
import { fromBase64Url, toBase64Url } from "../domain/identity"
import type { WorkspaceGrant } from "../domain/model"
import { defaultProofStore } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { listPendingWorkspaceDepartures, readPendingWorkspaceDeparture, savePendingWorkspaceDeparture,
  updatePendingWorkspaceDeparture, type PendingWorkspaceDeparture } from "../storageWorkspaceDeparture"
import { hasLeftWorkspace, uniqueCertificates, type SessionEntry } from "./durableMeshBase"
import type { PeerStore, WorkspaceMeshCredential } from "./peerStore"
import { createWorkspaceDeparture, type WorkspaceDeparture } from "./meshRecords"
import { meshRecordSigning } from "./meshRecordSigning"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { workspaceSet, type WorkspaceSetStore } from "./workspaceSet"
import { publishConfirmedToSessions } from "./durableMeshOwnershipScope"
import { prepareDepartureSnapshot, departureDeliveryTimeout } from "./workspaceDepartureSnapshot"

type Ports = {
  profile(): Promise<LocalProfile>
  store: PeerStore
  workspaceStore: WorkspaceSetStore
  heads(workspaceId: string): Promise<string[]>
  sessions(): SessionEntry[]
  notify(): Promise<void>
  commit(credential: WorkspaceMeshCredential, departure: WorkspaceDeparture): Promise<void>
  publish(): Promise<void>
  close(workspaceId: string): Promise<void>
  pending(workspaceId: string, error: unknown): void
}

/** UI removal commits intent; this operation retains the final data until an authenticated durable receipt. */
export class WorkspaceDepartureDelivery {
  private readonly inFlight = new Set<string>()
  private nextScanAt = 0
  constructor(private readonly ports: Ports) {}

  async leave(workspaceId: string): Promise<void> {
    const profile = await this.ports.profile()
    const credential = await this.ports.store.getWorkspaceCredential(workspaceId)
    if (!credential) throw new Error("No workspace membership")
    if (credential.ownerPersonId === profile.identity.personId) throw new Error("Transfer ownership before leaving this workspace")
    if (await readPendingWorkspaceDeparture(workspaceId, profile.identity.personId) ||
      hasLeftWorkspace(credential, profile.identity.personId, credential.localGrant as WorkspaceGrant | undefined)) return
    await defaultStorage.withWorkspaceAuthorityMutation(workspaceId, async () => {
      const departure = await createWorkspaceDeparture(profile, workspaceId,
        (credential.localGrant as WorkspaceGrant | undefined)?.payload.accessEpoch ?? 1, await this.ports.heads(workspaceId),
        uniqueCertificates(profile, await defaultProofStore.listCertificates()),
        await meshRecordSigning(profile, credential, { kind: "departure" }, this.ports.store))
      const snapshot = await workspaceSet({ ...this.ports.workspaceStore, readHistoryBaseline: undefined }, [workspaceId]).snapshot()
      const progress = await defaultStorage.historyProgressForRead(workspaceId)
      await savePendingWorkspaceDeparture({ workspaceId, personId: profile.identity.personId, departure,
        snapshot: toBase64Url(snapshot), baselineId: progress.baselineId ?? undefined, delivered: false, removeCopy: false })
    })
    await this.ports.notify()
    this.nextScanAt = 0
    await this.flush()
  }

  async flush(): Promise<void> {
    if (Date.now() < this.nextScanAt) return
    this.nextScanAt = Date.now() + 1_000
    const profile = await this.ports.profile()
    for (const summary of await listPendingWorkspaceDepartures()) {
      if (summary.personId !== profile.identity.personId || this.inFlight.has(summary.workspaceId)) continue
      const sessions = this.ports.sessions().filter(entry => entry.workspaceId === summary.workspaceId && entry.remotePersonId !== summary.personId)
      if (!summary.delivered && sessions.length === 0) continue
      const pending = await readPendingWorkspaceDeparture(summary.workspaceId, summary.personId)
      if (!pending) throw new Error("Indexed workspace departure is unavailable")
      this.inFlight.add(pending.workspaceId)
      void this.finish(pending, sessions).catch(error => this.ports.pending(pending.workspaceId, error))
        .finally(() => this.inFlight.delete(pending.workspaceId))
    }
  }

  private async finish(pending: PendingWorkspaceDeparture, sessions: SessionEntry[]): Promise<void> {
    const credential = await this.ports.store.getWorkspaceCredential(pending.workspaceId)
    if (!credential || (await this.ports.profile()).identity.personId !== pending.personId) return
    if (!pending.delivered) {
      const entries = meshRustRuntime().state.decodeWorkspaceSet(fromBase64Url(pending.snapshot), [pending.workspaceId])
      if (pending.baselineId) {
        const baseline = await this.ports.workspaceStore.readHistoryBaseline?.(pending.workspaceId, pending.baselineId)
        if (!baseline) throw new Error("Retained departure history is unavailable")
        entries[0]!.historyBaseline = baseline
      }
      const snapshot = await prepareDepartureSnapshot(meshRustRuntime().state.encodeWorkspaceSet(entries), pending.departure,
        this.ports.workspaceStore.blob)
      if (!await publishConfirmedToSessions(sessions, credential.transportSecret, snapshot, "departure delivery unconfirmed",
        departureDeliveryTimeout(snapshot, pending.workspaceId))) return
      await updatePendingWorkspaceDeparture(pending.workspaceId, pending.personId, { delivered: true })
    }
    const current = await this.ports.store.getWorkspaceCredential(pending.workspaceId)
    if (!current || (await this.ports.profile()).identity.personId !== pending.personId) return
    await this.ports.commit(current, pending.departure)
    await this.ports.publish()
    await this.ports.close(pending.workspaceId)
    await defaultStorage.completeWorkspaceDepartureDelivery(pending.workspaceId, pending.personId)
    await this.ports.notify()
  }
}
