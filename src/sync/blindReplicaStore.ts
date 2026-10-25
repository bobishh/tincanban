import { load, getHeads, free } from "@automerge/automerge/slim"
import type { useTincanban } from "../state"
import { exportAuthorizationBundle } from "./changeAuthorization"
import { exportChat, receiveChat } from "../chat/service"
import { meshTrace } from "./meshTrace"
import { traceDiagnosticOperation } from "./telemetry"
import { BlindReplica, type BlindReplicaConfig } from "./blindReplication"
import { checkpointHooks } from "./blindCheckpointAdmission"
import { createBlindSnapshotRevision } from "./blindSnapshotRevision"
import { getPrivateReplicaProgress, persistPrivateReplicaState, privateReplicaBinding } from "./privateReplicaRepository"
import { createBlindHistoryStoreHooks } from "./blindReplicaHistoryStore"
import { assertWorkspaceReplicaPurpose } from "./replicaPurpose"
import type { createWorkspaceAttachmentIndex } from "./attachmentIndexScope"
import type { AttachmentCoverageStatus } from "./attachmentReplicationTypes"
import type { WorkspaceAttachmentReplication } from "./workspaceAttachmentReplication"
import { withPrivateReplicaOperation } from "./privateReplicaOperation"
import { createRustyIdentityProfileScopeFetcher, principalForBoardStorageAccess } from "./rustyIdentityTransport"
import { inventoryBlindObjects, downloadBlindObject, uploadBlindObject, type BlindAccess } from "./blindClient"
import { submitBlindCheckpoint } from "./blindCheckpoint"
import { peerStore } from "./peerStore"
import { ensureOwnedRustyWorkspaceAuthority } from "./rustyWorkspaceAuthority"

export function createBlindReplica(config: BlindReplicaConfig, tincanban: ReturnType<typeof useTincanban>, ensureIdentity: () => void,
  persist: (config: BlindReplicaConfig, configurations?: BlindReplicaConfig[]) => Promise<void>,
  reportAttachments: (states: AttachmentCoverageStatus[]) => void = () => {}) {
  assertWorkspaceReplicaPurpose(config)
  ensureIdentity()
  const owner = tincanban.getCurrentProfile()?.identity.personId
  if (!owner) throw new Error("Identity unavailable during Rusty replication")
  const profile = tincanban.getCurrentProfile()
  if (!profile || profile.identity.personId !== owner) throw new Error("Identity unavailable during Rusty replication")
  const guardIdentity = () => {
    ensureIdentity()
    if (tincanban.getCurrentProfile()?.identity.personId !== owner) throw new Error("Identity changed during Rusty replication")
  }
  const ensureScopeCurrent = () => ensureRustyScopeAccess(tincanban, config, guardIdentity)
  const { scopeFetch, transport } = createBlindReplicaTransport(config, profile, ensureScopeCurrent)
  const readReplicaProgress = async () => {
    guardIdentity()
    if (config.boardAccess) await (await import("./workspaceRustyGuard")).assertParticipantStorageAccess(tincanban, config)
    const progress = await getPrivateReplicaProgress(owner, config)
    guardIdentity()
    return progress
  }
  let attachmentIndex: Promise<ReturnType<typeof createWorkspaceAttachmentIndex>> | undefined
  const loadAttachmentIndex = () => attachmentIndex ??= import("./attachmentIndexScope")
    .then(module => module.createWorkspaceAttachmentIndex(owner, config, guardIdentity))
  const guardAttachmentScope = async (workspaceId: string) => {
    guardIdentity()
    if (workspaceId !== config.workspaceId) throw new Error("Attachment index workspace changed during Rusty replication")
    await readReplicaProgress()
    guardIdentity()
  }
  const readSnapshotRevision = createBlindSnapshotRevision(tincanban)
  let attachments: Promise<WorkspaceAttachmentReplication> | undefined
  let attachmentWork: Promise<void> | undefined
  const replica: BlindReplica = new BlindReplica({ ...config }, {
    replicaBinding: privateReplicaBinding(owner, config),
    runExclusive: operation => withPrivateReplicaOperation(owner, config, async () => { guardIdentity(); return operation() }),
    ensureIdentity: guardIdentity,
    readReplicaProgress,
    ensureCurrent: async () => { await readReplicaProgress() },
    prepareAttachments: async () => {
      guardIdentity()
      if (attachmentWork) return
      attachmentWork = (async () => {
        const runtime = await (attachments ??= import("./workspaceAttachmentReplicaStore").then(module => {
          guardIdentity()
          return module.createWorkspaceAttachmentReplication(tincanban, config, guardIdentity,
            () => replica.flushCurrentSnapshot(), reportAttachments, scopeFetch)
        }).catch(cause => { attachments = undefined; throw cause }))
        guardIdentity()
        await runtime.run()
      })().catch(cause => {
        try { guardIdentity() } catch { return }
        meshTrace("mesh.rusty.attachments.failed", { workspaceId: config.workspaceId, entityType: "scope", entityId: config.scopeId,
          errorCode: "attachment_replication_failed", error: cause }, "warn")
      }).finally(() => { attachmentWork = undefined })
    },
    readAttachments: async workspaceId => {
      await guardAttachmentScope(workspaceId)
      const locators = await (await loadAttachmentIndex()).read()
      await guardAttachmentScope(workspaceId)
      return locators
    },
    mergeAttachments: async (workspaceId, locators) => {
      await guardAttachmentScope(workspaceId)
      await (await loadAttachmentIndex()).merge(locators)
      await guardAttachmentScope(workspaceId)
    },
    readAttachmentRevision: async workspaceId => {
      await guardAttachmentScope(workspaceId)
      const revision = await (await loadAttachmentIndex()).revision()
      await guardAttachmentScope(workspaceId)
      return revision
    },
    readHistoryBaseline: async workspaceId => {
      guardIdentity()
      if (workspaceId !== config.workspaceId) throw new Error("History baseline workspace changed during Rusty replication")
      const repository = await import("./historyBaselinePublicationRepository")
      guardIdentity()
      await readReplicaProgress()
      const publication = await repository.readPublishedHistoryBaseline(workspaceId, config, guardIdentity)
      guardIdentity()
      return publication?.wire
    },
    readHistoryRevision: async workspaceId => {
      guardIdentity()
      if (workspaceId !== config.workspaceId) throw new Error("History baseline workspace changed during Rusty replication")
      const repository = await import("./historyBaselinePublicationRepository")
      guardIdentity()
      await readReplicaProgress()
      const publication = await repository.readPublishedHistoryBaseline(workspaceId, config, guardIdentity)
      guardIdentity()
      return publication?.baselineId
    },
    persistReplicaProgress: async (expected, next) => {
      guardIdentity()
      const configurations = await persistPrivateReplicaState(owner, config, expected, next, guardIdentity)
      guardIdentity()
      await persist({ ...config, cursor: next.cursor, lastUploaded: next.lastUploaded }, configurations)
      guardIdentity()
    },
    read: async id => { guardIdentity(); return tincanban.readWorkspaceBytes(id) },
    readSnapshotRevision: async id => { guardIdentity(); return readSnapshotRevision(id) },
    authorization: bytes => exportAuthorizationBundle(bytes),
    ...createBlindHistoryStoreHooks({ config, tincanban, owner, guardIdentity, readReplicaProgress, readSnapshotRevision, scopeFetch }),
    readChat: async id => { guardIdentity(); const chat = await exportChat(id); return { ...chat, typing: [] } },
    mergeChat: async (id, chat) => { guardIdentity(); await receiveChat(id, chat, true) },
    documentRevision: async bytes => {
      const doc = load(bytes)
      try { return getHeads(doc).sort().join(",") } finally { free(doc) }
    },
    ...checkpointHooks(tincanban, config, guardIdentity),
    diagnostic: (event, detail) => meshTrace(event, detail, event.endsWith("failed") ? "warn" : "info"),
    operation: (name, operation) => traceDiagnosticOperation(name, { "workspace.id": config.workspaceId, "sync.scope.id": config.scopeId }, () => operation()),
    persist,
  }, transport)
  return replica
}

async function ensureRustyScopeAccess(tincanban: ReturnType<typeof useTincanban>, config: BlindReplicaConfig,
  guardIdentity: () => void): Promise<void> {
  guardIdentity()
  if (config.boardAccess) {
    const { assertParticipantStorageAccess } = await import("./workspaceRustyGuard")
    await assertParticipantStorageAccess(tincanban, config)
  }
  guardIdentity()
}

function createBlindReplicaTransport(config: BlindReplicaConfig, profile: NonNullable<ReturnType<ReturnType<typeof useTincanban>["getCurrentProfile"]>>,
  ensureCurrent: () => void) {
  let readOnlyRemoteScopeAuthority = false
  const scopeFetch = createRustyIdentityProfileScopeFetcher({ access: config, profile, ensureCurrent,
    principal: principalForBoardStorageAccess(config.boardAccess),
    workspace: { workspaceId: config.workspaceId, scopeAuthority: async () => {
      ensureCurrent()
      if (config.boardAccess) {
        const snapshot = config.boardAccess.principalGrant?.payload.scopeAuthority
        if (!snapshot) throw new Error("Verified participant scope authority is required before Rusty access")
        return snapshot
      }
      const stored = await peerStore.getWorkspaceAuthority(config.workspaceId) ?? await peerStore.getWorkspaceCredential(config.workspaceId)
      ensureCurrent()
      const snapshot = (stored as { scopeAuthoritySnapshot?: unknown } | null)?.scopeAuthoritySnapshot
      if (snapshot) {
        readOnlyRemoteScopeAuthority = false
        return snapshot
      }
      const remote = await ensureOwnedRustyWorkspaceAuthority(config, profile, ensureCurrent)
      ensureCurrent()
      readOnlyRemoteScopeAuthority = true
      if (!remote?.scopeAuthoritySnapshot) throw new Error("Rusty workspace authority is unavailable")
      return remote.scopeAuthoritySnapshot
    }, authorityIsReadOnly: () => readOnlyRemoteScopeAuthority } })
  const transport = {
    inventory: (access: BlindAccess, after: number) => inventoryBlindObjects(access, after, scopeFetch),
    download: (access: BlindAccess, id: string) => downloadBlindObject(access, id, scopeFetch),
    upload: (access: BlindAccess, object: Parameters<typeof uploadBlindObject>[1], requestId: string, observedSequence = 0) =>
      uploadBlindObject(access, object, requestId, observedSequence, scopeFetch),
    checkpoint: (access: BlindAccess, request: Parameters<typeof submitBlindCheckpoint>[1]) => submitBlindCheckpoint(access, request, scopeFetch),
  }
  return { scopeFetch, transport }
}

