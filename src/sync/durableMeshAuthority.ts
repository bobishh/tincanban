import { type LocalProfile } from "../domain/identity"
import { WorkspaceAuthorityClassification } from "./workspaceAuthorityClassification"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import { defaultProofStore, createWorkspaceGrant } from "../domain/proofs"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { createWorkspaceDeparture, type WorkspaceDeparture, createWorkspaceDeviceRevocation, type WorkspaceDeviceRevocation,
  createWorkspaceRevocation, verifyWorkspaceMemberBundle, createWorkspaceSuccessionPolicy, createWorkspaceSuccessionVote, createWorkspaceSuccessionClaim,
  type WorkspaceMemberBundle, type WorkspaceOwnershipTransfer, type WorkspaceSuccessionPolicy,
  type WorkspaceSuccessionVote, type WorkspaceSuccessionClaim } from "./meshRecords"
import { type WorkspaceMeshCredential, type WorkspacePeerRecord } from "./peerStore"
import { defaultStorage, isWorkspaceAuthorityMutation, type WorkspaceAuthorityMutationContext } from "../storage"
import { deviceRevocations, uniqueCertificates, meshCatalog, revocations, ownershipTransfers, successionPolicy, successionVotes, ownerAuthorities, type MeshExport, type ScopeAuthoritySnapshot } from "./durableMeshBase"
import { DurableMeshCredentials } from "./durableMeshCredentials"
import { workspaceSet } from "./workspaceSet"
import { meshTrace } from "./meshTrace"
import { assertKeeperGrantGeneration, emptyRevocationGeneration, reconcilePriorPersonRevocation } from "./revocationGeneration"
import { runKeeperRevocationActions } from "./keeperRevocationActions"
import { nextKeeperRevocationEpoch } from "./keeperGrantEpoch"
import { canonicalizeJson } from "../domain/identity"
import { workspaceOwnerSigningContext } from "./workspaceOwnerSigning"
import { meshRecordSigning } from "./meshRecordSigning"
import { persistVerifiedPeerBundle } from "./durableMeshPeerAdmission"
import { awaitOwnerDelivery, confirmedOwnershipSnapshot, createOwnershipProposal, mergeSuccessionState as mergeSuccessionStateInScope,
  ownershipTransfersWithPending, persistScopeAuthoritySnapshot, planOwnershipMerge, preflightScopeAuthoritySnapshot, publishConfirmedToSessions,
  type OwnershipMergePlan, type OwnershipTransferState } from "./durableMeshOwnershipScope"
export abstract class DurableMeshAuthority extends DurableMeshCredentials {
  private readonly authorityClassifications = new WorkspaceAuthorityClassification()
  async mergeWorkspace(workspaceId: string, raw: unknown): Promise<void> {
    const value = await this.traceSlowPhase("catalog.validate", workspaceId, {},
      () => meshRustRuntime().state.validateMeshCatalog(raw, Date.now()) as MeshExport)
    let credential = await this.traceSlowPhase("credential.read", workspaceId, {},
      () => this.store.getWorkspaceCredential(workspaceId))
    if (!credential) return
    const incomingTransfers = await this.traceSlowPhase("ownership.pending-transfers", workspaceId,
      { transfers: value.ownershipTransfers?.length ?? 0 },
      () => ownershipTransfersWithPending(this.store, workspaceId, value.ownershipTransfers ?? []))
    const localPersonId = value.scopeAuthoritySnapshot ? (await this.options.getProfile()).identity.personId : ""
    const scopeImport = await this.traceSlowPhase("authority-snapshot.preflight", workspaceId, {},
      () => preflightScopeAuthoritySnapshot(this.store, workspaceId, credential!, incomingTransfers, value.scopeAuthoritySnapshot,
        value, localPersonId))
    const effects: Record<string, () => Promise<void>> = {
      ownership: async () => { credential = await this.mergeOwnershipTransfers(credential!, value.ownershipTransfers ?? [], scopeImport.ownershipPlan,
        scopeImport.ownershipSnapshot) },
      revocations: async () => {
        try {
          await this.mergeDeviceRevocations(credential!, value.deviceRevocations ?? [])
          credential = await this.store.getWorkspaceCredential(workspaceId) ?? credential
          await this.mergeDepartures(credential!, value.departures ?? [])
          credential = await this.store.getWorkspaceCredential(workspaceId) ?? credential
          await this.mergeRevocations(credential!, value.revocations ?? [])
        } catch (error) {
          if (error instanceof Error && error.message === "Workspace access revoked") {
            await this.reclassifyWorkspaceAuthority(workspaceId)
            await this.notify()
          }
          throw error
        }
      },
      refreshCredential: async () => { credential = await this.store.getWorkspaceCredential(workspaceId) ?? credential },
      succession: async () => { credential = await this.mergeSuccessionState(credential!, value.successionPolicy,
        value.successionVotes ?? [], value.successionClaims ?? [], scopeImport.snapshot) },
      peers: () => this.mergePeerBundles(credential!, value.peers),
      notify: () => this.notify(),
    }
    const actions = await this.traceSlowPhase("catalog.plan", workspaceId, {},
      () => meshRustRuntime().state.planCatalogMerge())
    for (const action of actions) {
      // Publish derived UI authority only after the imported ledger is durable.
      if (action === "notify") continue
      const effect = effects[action]
      if (!effect) throw new Error(`Unexpected mesh catalog action: ${action}`)
      await this.traceSlowPhase(`effect.${action}`, workspaceId,
        action === "peers" ? { peerCount: value.peers.length } : {}, effect)
    }
    await this.traceSlowPhase("authority-snapshot.persist", workspaceId, {},
      () => defaultStorage.withWorkspaceAuthorityMutation(workspaceId, context =>
        persistScopeAuthoritySnapshot(this.store, workspaceId, scopeImport.snapshot, context.write)))
    await this.reclassifyWorkspaceAuthority(workspaceId)
    if (actions.includes("notify"))
      await this.traceSlowPhase("effect.notify", workspaceId, {}, effects.notify!)
  }
  protected async reclassifyWorkspaceAuthority(workspaceId: string): Promise<void> {
    return this.authorityClassifications.classifyStored(workspaceId, this.store, this.options.workspaceStore,
      () => this.trace("workspace.reclassify.reused", { workspaceId }))
  }
  protected async mergePeerBundles(credential: WorkspaceMeshCredential, bundles: WorkspaceMemberBundle[]) {
    for (const [index, bundle] of bundles.entries()) {
      try {
        await this.traceSlowPhase("peer.bundle", credential.workspaceId,
          { bundleIndex: index, bundleCount: bundles.length },
          () => this.putVerifiedBundle(credential, bundle, { index, total: bundles.length }))
      } catch {
        // Peer catalogs are gossip. Reject one invalid member without letting it
        // tear down an authenticated session between other valid members.
      }
    }
  }
  protected async putVerifiedBundle(credential: WorkspaceMeshCredential, raw: WorkspaceMemberBundle,
    batch?: { index: number; total: number }) {
    return defaultStorage.withWorkspaceAuthorityMutation(credential.workspaceId,
      context => this.putVerifiedBundleLocked(credential, raw, batch, context))
  }
  private async putVerifiedBundleLocked(credential: WorkspaceMeshCredential, raw: WorkspaceMemberBundle,
    batch: { index: number; total: number } | undefined, authorityContext: WorkspaceAuthorityMutationContext) {
    return persistVerifiedPeerBundle({ credential, raw, batch, context: {
      store: this.store,
      getProfile: () => this.options.getProfile(),
      authorityContext,
      trace: (phase, detail, operation) => this.traceSlowPhase(phase, credential.workspaceId, detail, operation),
    } })
  }
  protected async mergeOwnershipTransfers(
    initialCredential: WorkspaceMeshCredential,
    raw: WorkspaceOwnershipTransfer[],
    plan?: OwnershipMergePlan,
    scopeAuthoritySnapshot?: ScopeAuthoritySnapshot,
  ): Promise<WorkspaceMeshCredential> {
    const incoming = await ownershipTransfersWithPending(this.store, initialCredential.workspaceId, raw)
    plan ??= planOwnershipMerge(initialCredential, incoming)
    let credential = initialCredential
    let peers = await this.store.listPeers(credential.workspaceId)
    for (const step of plan.steps) {
      const profile = await this.options.getProfile()
      const adoption = meshRustRuntime().state.planOwnershipAdoption({ credential,
        peers, localPersonId: profile.identity.personId,
        verifiedCurrentOwnerEpoch: step.previousOwnerEpoch,
        transition: { kind: "transfer", record: step.record, accepted: step.accepted } })
      credential = adoption.credential as WorkspaceMeshCredential
      peers = adoption.peers as WorkspacePeerRecord[]
    }
    if (plan.steps.length || plan.persistCatalog) await defaultStorage.withWorkspaceAuthorityMutation(credential.workspaceId, async context => {
      if (plan!.steps.length) {
        await context.write(() => this.store.transferWorkspaceCredential(initialCredential.ownerPersonId, credential, scopeAuthoritySnapshot))
        for (const peer of peers) await context.write(() => this.store.upsertPeer(peer))
      }
      if (plan!.persistCatalog) {
        credential = { ...credential, catalog: { ...meshCatalog(credential), ownershipTransfers: plan!.accepted } }
        await context.write(() => this.store.putWorkspaceCredential(credential))
      }
    })
    return credential
  }
  protected async mergeSuccessionState(initialCredential: WorkspaceMeshCredential, rawPolicy: WorkspaceSuccessionPolicy | undefined,
    rawVotes: WorkspaceSuccessionVote[], rawClaims: WorkspaceSuccessionClaim[], importedSnapshot?: ScopeAuthoritySnapshot): Promise<WorkspaceMeshCredential> {
    return defaultStorage.withWorkspaceAuthorityMutation(initialCredential.workspaceId, context =>
      mergeSuccessionStateInScope(this.store, initialCredential, () => this.options.getProfile(), rawPolicy,
        rawVotes, rawClaims, this.sessions.size > 0, () => this.publishAll(), importedSnapshot, context.write))
  }
  async setSuccessor(workspaceId: string, personId: string | null): Promise<void> {
    const [profile, credential] = await Promise.all([this.options.getProfile(), this.store.getWorkspaceCredential(workspaceId)])
    const eligible = credential?.ownerPersonId === profile.identity.personId
      ? meshRustRuntime().state.eligibleEditorPersonIds(await this.store.listPeers(workspaceId)) : []
    const actions = meshRustRuntime().state.planAuthorityCommand({ kind: "setSuccessor",
      localPersonId: profile.identity.personId, ownerPersonId: credential?.ownerPersonId ?? null,
      successorPersonId: personId, eligibleEditorPersonIds: eligible })
    let policy!: WorkspaceSuccessionPolicy
    for (const action of actions) {
      if (action === "createPolicy") policy = await createWorkspaceSuccessionPolicy(profile, workspaceId, personId, eligible, credential!.epoch,
        new Date().toISOString(), await meshRecordSigning(profile, credential!, { kind: "owner" }, this.store))
      if (action === "setPolicy") await defaultStorage.withWorkspaceAuthorityMutation(workspaceId,
        context => context.write(() => this.store.putWorkspaceCredential({ ...credential!, updatedAt: new Date().toISOString(),
            catalog: { ...meshCatalog(credential!), successionPolicy: policy, successionVotes: [] } })
        )
      )
      if (action === "notify") await this.notify()
      if (action === "publish") await this.publishAll()
    }
  }
  protected async refreshSuccessionPolicy(workspaceId: string, authorityContext?: WorkspaceAuthorityMutationContext): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    const current = credential && successionPolicy(credential)
    if (!credential || !current || credential.ownerPersonId !== profile.identity.personId) return
    const eligible = meshRustRuntime().state.eligibleEditorPersonIds(await this.store.listPeers(workspaceId))
    const refresh = meshRustRuntime().state.planSuccessionPolicyRefresh(current, eligible, credential.epoch)
    if (!refresh.changed) return
    const policy = await createWorkspaceSuccessionPolicy(profile, workspaceId, refresh.successorPersonId, eligible, credential.epoch,
      new Date().toISOString(), await meshRecordSigning(profile, credential, { kind: "owner" }, this.store))
    const persist = () => this.store.putWorkspaceCredential({ ...credential, updatedAt: new Date().toISOString(),
      catalog: { ...meshCatalog(credential), successionPolicy: policy, successionVotes: [] } })
    if (authorityContext) {
      if (!isWorkspaceAuthorityMutation(authorityContext, workspaceId, defaultStorage)) throw new Error("Workspace authority mutation context is stale or belongs to another workspace")
      await authorityContext.write(persist)
    }
    else await defaultStorage.withWorkspaceAuthorityMutation(workspaceId, context => context.write(persist))
  }
  async voteForSuccessor(workspaceId: string, candidatePersonId: string): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    const policy = credential && successionPolicy(credential)
    const grant = credential?.localGrant as WorkspaceGrant | undefined
    const votes = credential ? successionVotes(credential) : []
    const existing = votes.find(vote => vote.signed.payload.voterPersonId === profile.identity.personId)
    const actions = meshRustRuntime().state.planAuthorityCommand({ kind: "vote", localPersonId: profile.identity.personId,
      hasCredential: Boolean(credential), hasPolicy: Boolean(policy), grantRole: grant?.payload.role ?? null,
      eligibleEditorPersonIds: policy?.payload.eligibleEditorPersonIds ?? [], successorPersonId: policy?.payload.successorPersonId ?? null,
      candidatePersonId, existingVoteFor: existing?.signed.payload.candidatePersonId ?? null })
    let vote!: WorkspaceSuccessionVote
    for (const action of actions) {
      vote = await this.applySuccessionVoteAction(action, { profile, credential: credential!, policy: policy!, grant: grant!,
        candidatePersonId, vote })
    }
  }

  private async applySuccessionVoteAction(action: string, input: { profile: LocalProfile; credential: WorkspaceMeshCredential;
    policy: WorkspaceSuccessionPolicy; grant: WorkspaceGrant; candidatePersonId: string; vote?: WorkspaceSuccessionVote }) {
    if (action === "createVote") return createWorkspaceSuccessionVote(input.profile, input.policy, input.candidatePersonId, input.grant,
      new Date().toISOString(), uniqueCertificates(input.profile, await defaultProofStore.listCertificates()),
      await meshRecordSigning(input.profile, input.credential, { kind: "vote", candidatePersonId: input.candidatePersonId }, this.store))
    if (action === "mergeVote") await this.mergeSuccessionState(input.credential, input.policy, [input.vote!], [])
    if (action === "notify") await this.notify()
    if (action === "publish") await this.publishAll()
    return input.vote!
  }

  async claimSuccession(workspaceId: string): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    const policy = credential && successionPolicy(credential)
    const grant = credential?.localGrant as WorkspaceGrant | undefined
    const votes = credential ? successionVotes(credential) : []
    const actions = meshRustRuntime().state.planAuthorityCommand({ kind: "claim", localPersonId: profile.identity.personId,
      hasCredential: Boolean(credential), hasPolicy: Boolean(policy), grantRole: grant?.payload.role ?? null,
      grantPersonId: grant?.payload.personId ?? null })
    let claim!: WorkspaceSuccessionClaim
    for (const action of actions) {
      if (action === "createClaim") {
        claim = await createWorkspaceSuccessionClaim(profile, policy!, votes, grant!,
          await this.readAuthorityHeads(credential!.workspaceId), credential!.epoch + 1,
          uniqueCertificates(profile, await defaultProofStore.listCertificates()), new Date().toISOString(),
          await meshRecordSigning(profile, credential!, { kind: "claim" }, this.store))
      }
      if (action === "mergeClaim") await this.mergeSuccessionState(credential!, policy!, votes, [claim])
      if (action === "notify") await this.notify()
      if (action === "publish") await this.publishAll()
    }
    await this.reclassifyWorkspaceAuthority(workspaceId)
  }

  protected async mergeRevocations(credential: WorkspaceMeshCredential, raw: unknown[], disconnect = true,
    authorityContext?: WorkspaceAuthorityMutationContext) {
    if (!raw.length && revocations(credential).length === 0) return
    const profile = await this.options.getProfile()
    const previousPeers = await this.store.listPeers(credential.workspaceId)
    const plan = meshRustRuntime().state.planAuthorityMerge({ credential,
      peers: previousPeers, localPersonId: profile.identity.personId,
      localDeviceId: profile.device.deviceId, nowMs: Date.now(), records: { kind: "revocations", records: raw } })
    const changed = canonicalizeJson(plan.credential) !== canonicalizeJson(credential) ||
      canonicalizeJson(plan.peers) !== canonicalizeJson(previousPeers)
    const persist = async () => {
      await this.store.putWorkspaceCredential(plan.credential as WorkspaceMeshCredential)
      for (const peer of plan.peers) await this.store.upsertPeer(peer as WorkspacePeerRecord)
    }
    if (changed) {
      if (authorityContext) {
        if (!isWorkspaceAuthorityMutation(authorityContext, credential.workspaceId, defaultStorage)) throw new Error("Workspace authority mutation context is stale or belongs to another workspace")
        await authorityContext.write(persist)
      }
      else await defaultStorage.withWorkspaceAuthorityMutation(credential.workspaceId, context => context.write(persist))
    }
    if (disconnect) for (const session of [...this.sessions.values()]) {
      if (session.workspaceId === credential.workspaceId && plan.evictDeviceIds.includes(session.deviceId)) await session.evict("peer revoked")
    }
    if (plan.localAccessRevoked) throw new Error("Workspace access revoked")
  }

  protected async mergeDepartures(credential: WorkspaceMeshCredential, records: WorkspaceDeparture[], disconnect = true): Promise<void> {
    if (!records.length) return
    const profile = await this.options.getProfile()
    const plan = meshRustRuntime().state.planAuthorityMerge({ credential,
      peers: await this.store.listPeers(credential.workspaceId), localPersonId: profile.identity.personId,
      localDeviceId: profile.device.deviceId, nowMs: Date.now(), records: { kind: "departures", records } })
    if (canonicalizeJson(plan.credential) === canonicalizeJson(credential) &&
        (!disconnect || canonicalizeJson(plan.peers) === canonicalizeJson(await this.store.listPeers(credential.workspaceId)))) return
    await defaultStorage.withWorkspaceAuthorityMutation(credential.workspaceId, async context => {
      await context.write(() => this.store.putWorkspaceCredential(plan.credential as WorkspaceMeshCredential))
      if (disconnect) for (const peer of plan.peers) await context.write(() => this.store.upsertPeer(peer as WorkspacePeerRecord))
    })
    if (!disconnect) return
    for (const session of [...this.sessions.values()]) {
      if (session.workspaceId === credential.workspaceId && plan.evictPersonIds.includes(session.remotePersonId)) await session.evict("member left workspace")
    }
  }

  protected async mergeDeviceRevocations(credential: WorkspaceMeshCredential, records: WorkspaceDeviceRevocation[], disconnect = true): Promise<void> {
    if (!records.length) return
    const profile = await this.options.getProfile()
    const plan = meshRustRuntime().state.planAuthorityMerge({ credential,
      peers: await this.store.listPeers(credential.workspaceId), localPersonId: profile.identity.personId,
      localDeviceId: profile.device.deviceId, nowMs: Date.now(), records: { kind: "deviceRevocations", records } })
    if (canonicalizeJson(plan.credential) === canonicalizeJson(credential) &&
        canonicalizeJson(plan.peers) === canonicalizeJson(await this.store.listPeers(credential.workspaceId))) return
    await defaultStorage.withWorkspaceAuthorityMutation(credential.workspaceId, async context => {
      await context.write(() => this.store.putWorkspaceCredential(plan.credential as WorkspaceMeshCredential))
      for (const peer of plan.peers) await context.write(() => this.store.upsertPeer(peer as WorkspacePeerRecord))
    })
    if (disconnect) for (const session of [...this.sessions.values()]) {
      if (session.workspaceId === credential.workspaceId && plan.evictDeviceIds.includes(session.deviceId)) await session.evict("device revoked")
    }
    if (plan.localAccessRevoked) throw new Error("Workspace access revoked")
  }

  async removableDeviceWorkspaces(personId: string, deviceId: string): Promise<string[]> {
    const profile = await this.options.getProfile()
    const ids: string[] = []
    for (const credential of await this.store.listWorkspaceCredentials()) {
      const peer = await this.store.getPeer(credential.workspaceId, deviceId)
      if (meshRustRuntime().state.canRemoveWorkspaceDevice(credential, profile.identity.personId,
        profile.identity.publicKey, profile.device.deviceId, personId, deviceId, peer?.personId)) ids.push(credential.workspaceId)
    }
    return ids.sort()
  }

  async removeDevice(personId: string, deviceId: string, workspaceIds: string[]): Promise<void> {
    const eligible = await this.removableDeviceWorkspaces(personId, deviceId)
    if (!workspaceIds.length || workspaceIds.some(id => !eligible.includes(id))) throw new Error("Device removal scope is no longer authorized")
    const profile = await this.options.getProfile()
    if (deviceId === profile.device.deviceId) throw new Error("Remove this device from another device")
    const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
    for (const workspaceId of new Set(workspaceIds)) {
      const credential = (await this.store.getWorkspaceCredential(workspaceId))!
      const heads = await this.readAuthorityHeads(workspaceId)
      const record = await createWorkspaceDeviceRevocation(profile, workspaceId, personId, deviceId, heads, certificates,
        await meshRecordSigning(profile, credential, { kind: "device-revocation", personId, deviceId }, this.store))
      await this.mergeDeviceRevocations(credential, [record], false)
    }
    await this.publishAll()
    for (const workspaceId of new Set(workspaceIds)) {
      const credential = (await this.store.getWorkspaceCredential(workspaceId))!
      await this.mergeDeviceRevocations(credential, deviceRevocations(credential))
    }
    await this.notify()
    for (const workspaceId of new Set(workspaceIds)) await this.reclassifyWorkspaceAuthority(workspaceId)
  }

  async promotePerson(workspaceId: string, personId: string): Promise<void> {
    await defaultStorage.withWorkspaceAuthorityMutation(workspaceId,
      context => this.promotePersonLocked(workspaceId, personId, context))
    await this.reclassifyWorkspaceAuthority(workspaceId)
    await this.publishAll()
  }
  private async promotePersonLocked(workspaceId: string, personId: string, authorityContext: WorkspaceAuthorityMutationContext): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    const peers = (await this.peerInstances(workspaceId)).filter(peer => peer.personId === personId && !peer.revokedAt && peer.advertisement)
    const actions = meshRustRuntime().state.planAuthorityCommand({ kind: "promote",
      localPersonId: profile.identity.personId, ownerPersonId: credential?.ownerPersonId ?? null,
      targetPersonId: personId, hasActiveMembership: peers.length > 0 })
    if (!credential) throw new Error("Workspace credential unavailable")
    credential.ownerCertificates = uniqueCertificates(profile, [...credential.ownerCertificates as DeviceCertificate[], ...await defaultProofStore.listCertificates()])
    let grant: WorkspaceGrant | undefined
    for (const action of actions) {
      if (action === "createGrant") {
        const epoch = await this.nextAccessEpoch(workspaceId)
        const context = await workspaceOwnerSigningContext(profile, workspaceId, "workspace-grant",
          { personId, role: "editor", accessEpoch: epoch }, async () =>
            await this.store.getWorkspaceAuthority(workspaceId) ?? await this.store.getWorkspaceCredential(workspaceId))
        grant = await createWorkspaceGrant(profile, workspaceId, personId, "editor", epoch, context)
      }
      if (action === "persistGrant") {
        if (!grant) throw new Error("Promotion grant was not created")
        await authorityContext.write(() => defaultProofStore.putGrant(grant!.payload.grantId, grant!))
        await authorityContext.write(() => this.store.putWorkspaceCredential(credential!))
        for (const peer of peers) {
          const bundle = { ...peer.advertisement as WorkspaceMemberBundle, grant, ownerPublicKey: credential!.ownerPublicKey, ownerCertificates: credential!.ownerCertificates as DeviceCertificate[] }
          await this.putVerifiedBundleLocked(credential!, bundle, undefined, authorityContext)
        }
      }
      if (action === "refreshSuccessionPolicy") await this.refreshSuccessionPolicy(workspaceId, authorityContext)
      if (action === "notify") await this.notify()
      // Publishing can await a concurrent receive that needs this mutation lock.
    }
  }
  async revokePerson(workspaceId: string, personId: string, expectedGrantEpoch?: number): Promise<void> {
    await defaultStorage.withWorkspaceAuthorityMutation(workspaceId, async authorityContext => {
      const profile = await this.options.getProfile(); let current = await this.store.getWorkspaceCredential(workspaceId)
      if (expectedGrantEpoch !== undefined) {
        const { verifiedKeeperGrantEpochs } = await import("./keeperGrantGeneration")
        const verifiedEpochs = current ? await verifiedKeeperGrantEpochs(profile, current, workspaceId, personId) : []
        assertKeeperGrantGeneration(current, await this.store.listPeers(workspaceId),
          profile, personId, expectedGrantEpoch, verifiedEpochs)
      }
      const prior = await reconcilePriorPersonRevocation(current, personId, () => this.store.listPeers(workspaceId),
        async () => { await this.mergeRevocations(current!, [], true, authorityContext) },
        () => this.notify(), generation => meshTrace("authority.revoke.generation-check", generation as Record<string, unknown>))
      if (prior.completed) return
      const generation = prior.generation ?? emptyRevocationGeneration()
      const actions = meshRustRuntime().state.planAuthorityCommand({ kind: "revoke", localPersonId: profile.identity.personId,
        ownerPersonId: current?.ownerPersonId ?? null })
      await runKeeperRevocationActions(actions, {
        create: async () => {
          const revocationEpoch = nextKeeperRevocationEpoch(await this.nextAccessEpoch(workspaceId), expectedGrantEpoch)
          const record = await createWorkspaceRevocation(profile, workspaceId, personId, revocationEpoch, await this.readAuthorityHeads(workspaceId),
            new Date().toISOString(), await meshRecordSigning(profile, current!, { kind: "owner" }, this.store))
          if (expectedGrantEpoch !== undefined && record.payload.epoch <= expectedGrantEpoch) throw new Error("Revocation did not advance beyond the issued keeper grant.")
          meshTrace("authority.revoke.generation-created", { ...generation, newRevocationEpoch: record.payload.epoch }); return record
        },
        merge: (record, disconnect) => this.mergeRevocations(current!, [record], disconnect, authorityContext),
        refresh: () => this.refreshSuccessionPolicy(workspaceId, authorityContext),
        publish: () => queueMicrotask(() => { void this.publishWorkspace(workspaceId).catch(error => this.report("Publish revocation", error)) }),
        reload: async () => { current = await this.store.getWorkspaceCredential(workspaceId) ?? current },
        notify: () => this.notify(),
      })
    })
    await this.reclassifyWorkspaceAuthority(workspaceId)
  }
  private async readAuthorityHeads(workspaceId: string): Promise<string[]> { const read = this.options.workspaceStore.readAuthorityHeads; if (!read) throw new Error("Admitted workspace document unavailable for authority signing"); return read(workspaceId) }
  async transferOwnership(workspaceId: string, personId: string): Promise<void> { return this.transferOwnershipWithReceipt(workspaceId, personId) }

  private async transferOwnershipWithReceipt(workspaceId: string, personId: string): Promise<void> {
    const [profile, credential, allPeers, pendingProposal] = await Promise.all([
      this.options.getProfile(), this.store.getWorkspaceCredential(workspaceId), this.peerInstances(workspaceId),
      this.store.getPendingOwnershipTransfer(workspaceId),
    ])
    if (pendingProposal) planOwnershipMerge(credential!, [pendingProposal.transfer as WorkspaceOwnershipTransfer])
    const advertisements = allPeers.map(peer => peer.advertisement)
    const targetPeers = allPeers.filter(peer => peer.personId === personId && !peer.revokedAt)
    const sessions = [...this.sessions.values()].filter(session => session.workspaceId === workspaceId &&
      session.remotePersonId === personId && session.ownershipReceiptSupported)
    const plan = meshRustRuntime().state.planOwnershipAuthorityFlow({
      localPersonId: profile.identity.personId, ownerPersonId: credential?.ownerPersonId ?? null,
      credentialEpoch: credential?.epoch ?? null, targetPersonId: personId,
      peers: allPeers.map((peer, index) => ({ personId: peer.personId, revoked: Boolean(peer.revokedAt),
        online: targetPeers.some(target => target.deviceId === peer.deviceId && sessions.some(session => session.deviceId === target.deviceId)),
        hasAdvertisement: Boolean(advertisements[index]) })),
      transfers: credential ? [...ownershipTransfers(credential), ...(pendingProposal ? [pendingProposal.transfer as WorkspaceOwnershipTransfer] : [])]
        .map(record => record.payload) : [],
      confirmationSessionCount: sessions.length,
    })
    const targetAdvertisement = plan.selection.advertisementIndex === null ? undefined
      : advertisements[plan.selection.advertisementIndex] as WorkspaceMemberBundle | undefined
    const pending = pendingProposal && plan.selection.pendingIndex === ownershipTransfers(credential!).length
      ? pendingProposal : undefined
    const state: OwnershipTransferState = { profile, credential: credential!, sessions,
      targetAdvertisement, transfer: pending?.transfer as WorkspaceOwnershipTransfer | undefined, current: credential!,
      nextScopeAuthoritySnapshot: pending?.scopeAuthoritySnapshot }
    for (const action of plan.actions) {
      await this.applyOwnershipTransferAction(action, workspaceId, state)
    }
    await this.reclassifyWorkspaceAuthority(workspaceId)
  }

  private async applyOwnershipTransferAction(action: string, workspaceId: string, state: OwnershipTransferState): Promise<void> {
    if (action === "verifyTarget") state.target = await verifyWorkspaceMemberBundle(state.targetAdvertisement!, {
      workspaceId, ownerPersonId: state.credential.ownerPersonId, ownerPublicKey: state.credential.ownerPublicKey,
      ownerCertificates: state.credential.ownerCertificates as DeviceCertificate[], ownerHistory: ownerAuthorities(state.credential).slice(1),
    })
    if (action === "createTransfer") {
      const proposal = await createOwnershipProposal(state.profile, workspaceId, state.target!, state.credential, this.store, this.options.workspaceStore)
      state.transfer = proposal.transfer
      state.nextScopeAuthoritySnapshot = proposal.scopeAuthoritySnapshot
    }
    if (action === "persistProposal") await this.store.putPendingOwnershipTransfer({ version: 1, workspaceId,
      transfer: state.transfer!, scopeAuthoritySnapshot: state.nextScopeAuthoritySnapshot })
    if (action === "confirmDelivery") await this.confirmOwnershipDelivery(workspaceId, state)
    if (action === "mergeTransfer") await this.mergeConfirmedOwnershipTransfer(workspaceId, state)
    if (action === "notify") await this.notify()
    if (action === "publish") await this.publishAll()
  }

  private async confirmOwnershipDelivery(workspaceId: string, state: OwnershipTransferState): Promise<void> {
    const snapshot = await confirmedOwnershipSnapshot(this.options.workspaceStore, workspaceId, state.transfer!,
      state.nextScopeAuthoritySnapshot, id => this.exportWorkspace(id))
    if (!await publishConfirmedToSessions(state.sessions, state.credential.transportSecret, snapshot, "ownership delivery unconfirmed")) {
      throw new Error("Ownership delivery is unconfirmed. Keep both devices open and retry the same recipient.")
    }
  }

  private async mergeConfirmedOwnershipTransfer(workspaceId: string, state: OwnershipTransferState): Promise<void> {
    state.current = await this.store.getWorkspaceCredential(workspaceId) ?? state.current
    await this.mergeOwnershipTransfers(state.current, [state.transfer!], undefined, state.nextScopeAuthoritySnapshot)
  }

  async leaveWorkspace(workspaceId: string): Promise<void> {
    const profile = await this.options.getProfile()
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential) throw new Error("No workspace membership")
    if (credential.ownerPersonId === profile.identity.personId) throw new Error("Transfer ownership before leaving this workspace")
    const deadline = Date.now() + 20_000
    while (![...this.sessions.values()].some(session => session.workspaceId === workspaceId)) {
      if (Date.now() >= deadline) throw new Error("No verified workspace connection. Keep another device online, then retry leaving.")
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const snapshot = await workspaceSet(this.options.workspaceStore, [workspaceId]).snapshot()
    await awaitOwnerDelivery(() => [...this.sessions.values()].filter(session => session.workspaceId === workspaceId &&
      session.remotePersonId === credential.ownerPersonId && session.ownershipReceiptSupported), credential.transportSecret, snapshot, deadline)
    const workspaceHeads = await this.readAuthorityHeads(workspaceId)
    const departure = await createWorkspaceDeparture(profile, workspaceId, (credential.localGrant as WorkspaceGrant | undefined)?.payload.accessEpoch ?? 1,
      workspaceHeads,
      uniqueCertificates(profile, await defaultProofStore.listCertificates()),
      await meshRecordSigning(profile, credential, { kind: "departure" }, this.store))
    await this.mergeDepartures(credential, [departure], false)
    await this.publishAll()
    const current = await this.store.getWorkspaceCredential(workspaceId) ?? credential
    await this.mergeDepartures(current, [departure])
    await this.reclassifyWorkspaceAuthority(workspaceId)
    for (const action of meshRustRuntime().state.planAuthorityCommand({ kind: "leave", workspaceId })) {
      if (action === "leave") await this.leaveWorkspaceHost(workspaceId)
      if (action === "notify") await this.notify()
    }
  }

  private async leaveWorkspaceHost(workspaceId: string): Promise<void> {
    for (const [, entry] of [...this.sessions]) if (entry.workspaceId === workspaceId) await entry.evict("workspace left")
    this.gossip.close(workspaceId)
    await defaultStorage.withWorkspaceAuthorityMutation(workspaceId, async context => {
      await context.write(() => this.store.removeWorkspaceMeshData(workspaceId))
      await context.write(() => defaultProofStore.removeWorkspaceGrants(workspaceId))
    })
    this.lastDiagnostic = ""; this.options.onDiagnostic?.("")
    this.clearRouteReconnects(`${workspaceId}:`)
  }

}
