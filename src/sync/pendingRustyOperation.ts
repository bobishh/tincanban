import type { LocalProfile } from "../domain/identity"
import type { useTincanban } from "../state"
import { readReplicaCredentialFreeze } from "./replicaCredentialFreeze"
import { readCredentialTransitionJournal, type CredentialTransitionJournal } from "./replicaCredentialTransitionJournal"
import { readPendingRustyCredentialConflict } from "./replicaCredentialConflictWorkflow"

export type RustyRemovalProgress = {
  phase: "checking-automations" | "pausing-automations" | "revoking-device" | "updating-storage" | "updating-automations" | "activating" | "confirming-snapshots"
  scopeCount: number; confirmedScopes: number; workerCount: number; frozenWorkers: number; rotatedWorkers: number; personConfirmed: boolean
}
export type PendingRustyOperation = { origin: string; signerDeviceId: string; progress?: RustyRemovalProgress } & (
  { kind: "conflict"; scopeId: string; workspaceId: string } |
  { kind: "device-revocation"; deviceId: string }
)
/** Describe retained intent without exposing keys or changing its freeze. */
export async function readPendingRustyOperation(profile: LocalProfile, origin: string): Promise<PendingRustyOperation | undefined> {
  const freeze = await readReplicaCredentialFreeze(profile.identity.personId, origin)
  if (freeze && "kind" in freeze) return { origin, kind: "conflict", signerDeviceId: freeze.signerDeviceId,
    scopeId: freeze.scopeId, workspaceId: freeze.proposal.next.purpose === "identity" ? "" : freeze.proposal.next.workspaceId }
  if (freeze) {
    const journal = freeze.signerDeviceId === profile.device.deviceId ? await readCredentialTransitionJournal(profile, origin) : undefined
    return { origin, kind: "device-revocation", signerDeviceId: freeze.signerDeviceId, deviceId: freeze.revokedDeviceId,
      ...(journal ? { progress: removalProgress(journal) } : {}) }
  }
  const conflict = await readPendingRustyCredentialConflict(profile, origin)
  if (conflict) return { origin, kind: "conflict", signerDeviceId: conflict.signerDeviceId,
    scopeId: conflict.scopeId, workspaceId: conflict.workspaceIds[0] ?? "" }
  const journal = await readCredentialTransitionJournal(profile, origin)
  if (journal) return { origin, kind: "device-revocation", signerDeviceId: journal.freeze.signerDeviceId,
    deviceId: journal.freeze.revokedDeviceId, progress: removalProgress(journal) }
  return undefined
}
function removalProgress(journal: CredentialTransitionJournal): RustyRemovalProgress {
  const resources = journal.freeze.resources
  const phase = journal.activated ? "confirming-snapshots"
    : resources.some(item => item.previous.purpose !== "identity" && !journal.cohorts.includes(item.previous.scopeId)) ? "checking-automations"
    : journal.workers.some(worker => !worker.frozen) ? "pausing-automations"
    : !journal.person ? "revoking-device"
    : journal.scopes.length < resources.length ? "updating-storage"
    : journal.workers.some(worker => !worker.rotated) ? "updating-automations" : "activating"
  return { phase, scopeCount: resources.length, confirmedScopes: journal.scopes.length, workerCount: journal.workers.length,
    frozenWorkers: journal.workers.filter(worker => worker.frozen).length, rotatedWorkers: journal.workers.filter(worker => worker.rotated).length,
    personConfirmed: Boolean(journal.person) }
}

export async function resumePendingRustyOperation(app: ReturnType<typeof useTincanban>, origin: string, guard: () => void): Promise<void> {
  guard()
  const profile = app.getCurrentProfile()
  if (!profile) throw new Error("Identity unavailable")
  const pending = await readPendingRustyOperation(profile, origin)
  guard()
  if (!pending) return
  if (pending.signerDeviceId !== profile.device.deviceId) throw new Error("Resume Rusty recovery on the device that started it")
  if (pending.kind === "device-revocation") {
    const { revokeRustyIdentityDevice } = await import("./rustyCredentialTransition")
    await revokeRustyIdentityDevice(app, origin, pending.deviceId, guard)
  } else {
    const { recoverRustyCredentialConflict } = await import("./replicaCredentialConflictWorkflow")
    await recoverRustyCredentialConflict(app, origin, pending.scopeId, pending.workspaceId || app.activeWorkspace.id, guard)
  }
}
