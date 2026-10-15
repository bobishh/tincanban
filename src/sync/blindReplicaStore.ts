import { load, getHeads, free } from "@automerge/automerge/slim"
import type { useTincanban } from "../state"
import { exportAuthorizationBundle } from "./changeAuthorization"
import { exportChat, receiveChat } from "../chat/service"
import { meshTrace } from "./meshTrace"
import { BlindReplica, type BlindReplicaConfig } from "./blindReplication"
import { checkpointHooks } from "./blindCheckpointAdmission"
import { createBlindSnapshotRevision } from "./blindSnapshotRevision"
import { getPrivateReplicaProgress, persistPrivateReplicaState, privateReplicaBinding } from "./privateReplicaRepository"
import { createBlindHistoryStoreHooks } from "./blindReplicaHistoryStore"
import { assertWorkspaceReplicaPurpose } from "./replicaPurpose"
import type { createWorkspaceAttachmentIndex } from "./attachmentIndexScope"
import type { AttachmentCoverageStatus } from "./attachmentReplicationTypes"
import type { WorkspaceAttachmentReplication } from "./workspaceAttachmentReplication"

export function createBlindReplica(config: BlindReplicaConfig, tincanban: ReturnType<typeof useTincanban>, ensureIdentity: () => void,
  persist: (config: BlindReplicaConfig, configurations?: BlindReplicaConfig[]) => Promise<void>,
  reportAttachments: (states: AttachmentCoverageStatus[]) => void = () => {}) {
  assertWorkspaceReplicaPurpose(config)
  ensureIdentity()
  const owner = tincanban.getCurrentProfile()?.identity.personId
  if (!owner) throw new Error("Identity unavailable during Rusty replication")
  const guardIdentity = () => {
    ensureIdentity()
    if (tincanban.getCurrentProfile()?.identity.personId !== owner) throw new Error("Identity changed during Rusty replication")
  }
  const readReplicaProgress = async () => {
    guardIdentity()
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
            () => replica.flushCurrentSnapshot(), reportAttachments)
        }).catch(cause => { attachments = undefined; throw cause }))
        guardIdentity()
        await runtime.run()
      })().catch(() => {
        try { guardIdentity() } catch { return }
        meshTrace("mesh.rusty.attachments.failed", { workspaceId: config.workspaceId, entityType: "scope", entityId: config.scopeId,
          errorCode: "attachment_replication_failed" }, "warn")
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
    ...createBlindHistoryStoreHooks({ config, tincanban, owner, guardIdentity, readReplicaProgress, readSnapshotRevision }),
    readChat: async id => { guardIdentity(); const chat = await exportChat(id); return { ...chat, typing: [] } },
    mergeChat: async (id, chat) => { guardIdentity(); await receiveChat(id, chat, true) },
    documentRevision: async bytes => {
      const doc = load(bytes)
      try { return getHeads(doc).sort().join(",") } finally { free(doc) }
    },
    ...checkpointHooks(tincanban, config, guardIdentity),
    diagnostic: (event, detail) => meshTrace(event, detail, event.endsWith("failed") ? "warn" : "info"),
    persist,
  })
  return replica
}

