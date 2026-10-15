import { ref, shallowRef } from "vue"
import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import { hasEntityKind, type WorkspaceDocumentV2 } from "../domain/model"
import { parseAutomationDefinition, type AutomationDefinition } from "../domain/automationContract"
import { automationEntityId, automationLifecycle } from "../domain/automationLifecycle"
import { createApplicationBinding, type ApplicationBindingProof } from "../domain/applicationBinding"
import type { ApplicationReviewOption, ApplicationReviewResponse } from "../domain/applicationReviewData"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { localWorkspaceAdmissionAuthority, workspaceRole } from "../sync/changeAuthorization"
import { discoverApplicationReview, readApplicationReview, retryApplicationBinding, saveApplicationBinding } from "./applicationReviewClient"
import { validateApplicationReviewSelection } from "./applicationReviewSelection"

export type ApplicationReviewHost = {
  getActiveDoc(): WorkspaceDocumentV2 | undefined | null
  getCurrentProfile(): LocalProfile | undefined | null
  owner(): boolean
  syncNow(): Promise<void>
  changed(): Promise<void>
}
export type ApplicationReviewRecord = { definition: AutomationDefinition; entity: { executor: { origin: string; personId: string } } }

/** Loaded on explicit review; signed selection and execution remain separate actions. */
export function createApplicationReviewManagement(host: ApplicationReviewHost) {
  const review = shallowRef<ApplicationReviewResponse | null>(null)
  const busy = ref(false)
  const failure = ref("")
  const saved = ref(false)
  let closed = false
  let generation = 0
  let session: { profile: LocalProfile; workspaceId: string; definition: AutomationDefinition; origin: string;
    executor: string; integrationId: string; eventId: string } | undefined
  let selected: ApplicationReviewOption | undefined
  let pendingProof: ApplicationBindingProof | undefined

  function current() {
    const profile = host.getCurrentProfile()
    const doc = host.getActiveDoc()
    if (closed || !session || !host.owner() || !profile || !doc || doc.id !== session.workspaceId ||
      profile.identity.personId !== session.profile.identity.personId || profile.device.deviceId !== session.profile.device.deviceId ||
      profile.certificate.signature !== session.profile.certificate.signature) throw new Error("Owner, device or workspace changed; reopen application review")
    const entity = doc.entities[automationEntityId(session.definition.id)]
    if (!hasEntityKind(entity, "automation") || entity.executor.origin !== session.origin || entity.executor.personId !== session.executor ||
      canonicalizeJson(parseAutomationDefinition(JSON.parse(entity.definition))) !== canonicalizeJson(session.definition)) {
      throw new Error("Automation approval changed; reopen application review")
    }
    return { profile, doc, entity }
  }

  const guards = {
    ensureCurrent: () => { current() },
    currentAuthority: async () => {
      const state = current()
      const revision = await reviewAuthorityRevision(state, review.value, selected, session!.definition)
      current()
      return revision
    },
  }

  async function run(action: () => Promise<void>) {
    if (busy.value || closed) return
    const token = generation
    busy.value = true; failure.value = ""
    try { await action() }
    catch (error) {
      if (!closed && generation === token) failure.value = error instanceof Error ? error.message : "Application review failed"
    } finally { if (!closed && generation === token) busy.value = false }
  }
  async function page(offset: number) {
    await run(async () => {
      const active = session!
      selected = undefined; pendingProof = undefined
      current()
      const response = await readApplicationReview(active.profile, { origin: active.origin, workspaceId: active.workspaceId,
        definitionId: active.definition.id, integrationId: active.integrationId, eventId: active.eventId, offset }, guards)
      current()
      review.value = response; selected = undefined; pendingProof = undefined; saved.value = Boolean(response.binding)
    })
  }

  async function open(record: ApplicationReviewRecord, eventId: string) {
    if (busy.value || closed) return
    const profile = host.getCurrentProfile()
    const workspaceId = host.getActiveDoc()?.id
    if (!profile || !workspaceId || !host.owner()) { failure.value = "Current workspace owner is required"; return }
    session = { profile: structuredClone(profile), workspaceId, definition: structuredClone(record.definition),
      origin: record.entity.executor.origin, executor: record.entity.executor.personId, integrationId: "", eventId }
    await run(async () => {
      await host.syncNow(); current()
      const active = session!
      const route = await discoverApplicationReview(active.profile, { origin: active.origin, workspaceId,
        definitionId: active.definition.id, personId: active.executor }, guards)
      current(); active.integrationId = route.integrationId
      const response = await readApplicationReview(active.profile, { origin: active.origin, workspaceId,
        definitionId: active.definition.id, integrationId: route.integrationId, eventId }, guards)
      current(); review.value = response; saved.value = Boolean(response.binding)
    })
  }
  function select(option: ApplicationReviewOption) {
    if (busy.value || closed) return
    selected = structuredClone(option); pendingProof = undefined; saved.value = false
  }
  async function save() {
    await run(async () => {
      const response = review.value
      const active = session!
      if (!response || !selected || !response.decisionHash) throw new Error("Choose an application with retained evidence and a classified message")
      await host.syncNow()
      const { doc } = current()
      await validateApplicationReviewSelection(response, selected, doc, active.definition)
      if (!pendingProof) {
        const context = await resolveLocalSigningContext(active.profile, "automation-application-binding", {
          origin: active.origin, integrationId: active.integrationId, definitionId: active.definition.id,
          workspaceId: active.workspaceId, cardId: selected.cardId, grantId: response.grantId,
          sourceRecordId: selected.sourceRecordId!, sourceHash: selected.sourceHash!, accessEpoch: response.accessEpoch,
          eventId: active.eventId, eventHash: response.eventHash, decisionHash: response.decisionHash,
        }, guards)
        pendingProof = await createApplicationBinding(context, { bindingId: crypto.randomUUID(),
          previousBindingId: response.binding?.signed.payload.bindingId ?? null, origin: active.origin,
          integrationId: active.integrationId, definitionId: active.definition.id, workspaceId: active.workspaceId,
          cardId: selected.cardId, grantId: response.grantId, eventId: active.eventId, eventHash: response.eventHash,
          decisionHash: response.decisionHash, sourceRecordId: selected.sourceRecordId!, sourceHash: selected.sourceHash!,
          accessEpoch: response.accessEpoch, workflow: selected.workflow! })
      }
      await saveApplicationBinding(active.profile, { origin: active.origin, workspaceId: active.workspaceId,
        definitionId: active.definition.id, integrationId: active.integrationId, proof: pendingProof }, guards)
      current(); review.value = { ...response, binding: pendingProof }; saved.value = true
      await host.changed()
    })
  }
  async function retry() {
    await run(async () => {
      const active = session!
      const proof = review.value?.binding
      if (!proof) throw new Error("Save an owner binding before retrying this message")
      await host.syncNow(); current()
      await retryApplicationBinding(active.profile, { origin: active.origin, workspaceId: active.workspaceId,
        definitionId: active.definition.id, integrationId: active.integrationId, proof }, guards)
      current(); review.value = { ...review.value!, status: "pending" }; await host.changed()
    })
  }
  function close() { closed = true; generation += 1; session = undefined; selected = undefined; pendingProof = undefined }
  return { review, busy, failure, saved, open, select, page, save, retry, close }
}

async function reviewAuthorityRevision(state: { profile: LocalProfile; doc: WorkspaceDocumentV2;
  entity: Extract<WorkspaceDocumentV2["entities"][string], { kind: "automation" }> },
  review: ApplicationReviewResponse | null, selected: ApplicationReviewOption | undefined, definition: AutomationDefinition) {
  const { profile, doc, entity } = state
  if (await workspaceRole(doc, profile) !== "owner") throw new Error("Current owner-device authority is required")
  const authority = await localWorkspaceAdmissionAuthority(doc, profile)
  if (review && (authority.authority.currentEpoch !== review.accessEpoch ||
    authority.authority.currentOwner.personId !== profile.identity.personId)) throw new Error("Workspace authority changed; reload application review")
  if (selected && review) await validateApplicationReviewSelection(review, selected, doc, definition)
  const item = selected ? doc.entities[selected.cardId] : undefined
  return canonicalizeJson([authority.fingerprint, entity.definition, automationLifecycle(entity),
    selected ? doc.entities[`application-source:${selected.sourceRecordId}`] : null,
    item && "workflow" in item ? item.workflow : null])
}
