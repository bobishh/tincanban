import type { Ref } from "vue"
import type { BlobDescriptor } from "@meta-uber/mesh-blob"
import type { useTincanban } from "../state"
import { canonicalizeJson } from "../domain/identity"
import { meshTrace } from "./meshTrace"
import type { BlindReplicaConfig, IdentityReplicaConfig, PrivateReplicaConfig, PrivateReplicaConflictSummary } from "./blindReplication"
import { replicaKey, type ReplicaHealth } from "./replicationHealth"
import type { AttachmentCoverageStatus } from "./attachmentReplicationTypes"

type State = { configs: Ref<BlindReplicaConfig[]>; identityConfigs: Ref<IdentityReplicaConfig[]>;
  statuses: Ref<Record<string, ReplicaHealth>>; profileSetupErrors: Ref<Record<string, string>>; profilePermissionUpdates?: Ref<string[]>;
  preferenceConflicts?: Ref<PrivateReplicaConflictSummary[]>;
  attachmentCoverage?: Ref<Record<string, AttachmentCoverageStatus[]>> }
type Session = { identity: () => string; epoch: () => number; disposed: () => boolean }

/** Purpose-specific adapters share scheduling, while credentials and confirmation stay scoped. */
export function createPrivateReplicaRuntime(app: ReturnType<typeof useTincanban>, state: State, session: Session) {
  const replicas = new Map<string, { binding: string; sync: () => Promise<boolean | void> }>()
  const writerMaintenance = new Map<string, BlindReplicaConfig>()
  const personId = () => app.getCurrentProfile()?.identity.personId ?? ""
  const current = (owner: string, epoch: number) => !session.disposed() && session.identity() === owner && personId() === owner && session.epoch() === epoch
  const profileBinding = () => {
    void app.docVersion.value
    const profile = app.ready.value ? app.getCurrentProfile() : undefined
    return profile ? canonicalizeJson([profile.identity.personId, profile.device.deviceId, profile.device.publicKey,
      profile.certificate.signature]) : ""
  }
  function captureSession(workspaceId?: string, owner = session.identity(), epoch = session.epoch()) {
    const profile = profileBinding()
    return () => {
      if (!owner || !current(owner, epoch) || profileBinding() !== profile ||
          (workspaceId !== undefined && app.activeWorkspace.id !== workspaceId)) throw new Error("Identity changed or workspace switched. Retry.")
    }
  }
  async function fetchAttachment(workspaceId: string, descriptor: BlobDescriptor,
    fallback?: (descriptor: BlobDescriptor) => Promise<Uint8Array | undefined>): Promise<Uint8Array | undefined> {
    const requested = structuredClone(descriptor)
    const guard = captureSession(workspaceId)
    return import("./rustyAttachmentDelivery").then(module => module.fetchRustyAttachment(app, workspaceId, requested, guard, fallback))
  }
  async function reload(owner: string, epoch: number) {
    const knownOrigins = new Set([...state.configs.value, ...state.identityConfigs.value, ...(state.preferenceConflicts?.value ?? [])].map(value => value.origin))
    const module = await import("./privateReplicaFactory")
    await module.reloadPrivateReplicas(owner, state, replicas, () => current(owner, epoch))
    if (!current(owner, epoch) || !state.preferenceConflicts) return
    const profile = app.getCurrentProfile()
    if (!profile || profile.identity.personId !== owner) return
    for (const value of [...state.configs.value, ...state.identityConfigs.value, ...state.preferenceConflicts.value]) knownOrigins.add(value.origin)
    const { readPendingRustyCredentialConflict } = await import("./replicaCredentialConflictWorkflow")
    const pending: PrivateReplicaConflictSummary[] = []
    for (const origin of knownOrigins) {
      const summary = await readPendingRustyCredentialConflict(profile, origin)
      if (!current(owner, epoch)) return
      if (summary) pending.push(summary)
    }
    if (!current(owner, epoch)) return
    state.preferenceConflicts.value = [...new Map([...state.preferenceConflicts.value, ...pending]
      .map(value => [`${value.origin}/${value.scopeId}`, value])).values()]
  }
  async function replica(config: PrivateReplicaConfig) {
    const owner = session.identity(), epoch = session.epoch(), guard = captureSession()
    guard()
    return import("./privateReplicaFactory").then(module => module.resolvePrivateReplica(app, config,
      { owner, guard, configs: state.configs, cache: replicas, attachmentCoverage: state.attachmentCoverage,
        reload: () => reload(owner, epoch), queueWriterMaintenance: value => writerMaintenance.set(replicaKey(value), structuredClone(value)) }))
  }
  async function runWriterMaintenance(owner: string, epoch: number) {
    const queued = [...writerMaintenance.values()]
    writerMaintenance.clear()
    for (const config of queued) {
      if (!current(owner, epoch)) return
      const guard = captureSession(undefined, owner, epoch)
      const { maintainWorkspaceReplicaWriter } = await import("./workspaceReplicaWriter")
      try { await maintainWorkspaceReplicaWriter(app, config, guard, () => reload(owner, epoch)) }
      catch (error) {
        meshTrace("workspace.replica.writer-maintenance.failed", { phase: "post-sync-pass", workspaceId: config.workspaceId,
          "server.address": new URL(config.origin).host }, "warn", error)
      }
    }
  }
  async function provision(owner: string, epoch: number) {
    const guard = captureSession(undefined, owner, epoch)
    guard()
    return import("./privateReplicaFactory").then(module => module.provisionPrivateReplicas(app, state, guard, () => reload(owner, epoch)))
  }
  return { personId, profileBinding, captureSession, reload, replica, provision, fetchAttachment, runWriterMaintenance,
    clear: () => { replicas.clear(); writerMaintenance.clear() }, forget: (config: PrivateReplicaConfig, guard: () => void) => import("./privateReplicaFactory")
      .then(module => { guard(); module.forgetPrivateReplica(config, state, replicas) }) }
}
