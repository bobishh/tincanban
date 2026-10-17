import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue"
import type { LocalProfile } from "../domain/identity"
import type { useTincanban } from "../state"
import type { BlindReplicationController } from "./blindReplication"
import type { AutomationConfiguration, AutomationWorkerIdentity } from "./automation"
import type { InspectedAutomationInstance } from "./automationInstanceManagement"
import { automationLifecycle, type AutomationDesiredState } from "../domain/automationLifecycle"
import { parseAutomationDefinition } from "../domain/automationContract"
import { hasEntityKind } from "../domain/model"
import type { AutomationMailboxSetup } from "./automationMailbox"
import type { ApplicationReviewRecord } from "./applicationReviewManagement"
import type { AutomationObservation } from "../domain/automationProtocol"

export function useAutomations(workspace: ReturnType<typeof useTincanban>, blind: BlindReplicationController, owner: () => boolean) {
  const types = computed(() => workspace.activeBoard.value?.automation?.types ?? [])
  const busy = ref(false)
  const failure = ref("")
  const observations = ref<Record<string, AutomationObservation>>({})
  const email = ref<Record<string, AutomationMailboxSetup>>({})
  const observationErrors = ref<Record<string, string>>({})
  const now = ref(Date.now())
  const emailChecked = new Map<string, number>()
  let disposed = false
  const instanceStatus = createInstanceStatus(now, (record, profile, id) => inspectInstanceForScope(workspace, record, profile, id, owner, () => disposed))
  let checking = false
  let pendingInstance: { workspaceId: string; origin: string; id: string; identity?: AutomationWorkerIdentity } | undefined
  const records = computed(() => {
    void workspace.docVersion.value
    return readAutomationRecords(workspace)
  })
  const storage = computed(() => blind.configs.value.filter(value => value.workspaceId === workspace.getActiveDoc()?.id && !value.removalPending))
  const confirmation = (record: typeof records.value[number]) => confirmsAutomation(record, observations.value[record.entity.id], now.value)
  async function refreshEmail(record: typeof records.value[number], profile: LocalProfile, workspaceId: string) {
    if (confirmation(record) && now.value - (emailChecked.get(record.entity.id) ?? 0) <= 30_000) return observations.value[record.entity.id]!
    try {
      const mailbox = await readMailboxForScope(workspace, record, profile, workspaceId, owner, () => disposed)
      email.value[record.entity.id] = mailbox.setup
      return mailbox.observation
    } catch (error) { delete email.value[record.entity.id]; throw error }
    finally { emailChecked.set(record.entity.id, now.value) }
  }
  async function observeAll(): Promise<void> {
    if (disposed || checking || !owner()) return
    const profile = workspace.getCurrentProfile()
    const workspaceId = workspace.getActiveDoc()?.id
    if (!profile || !workspaceId) return
    checking = true
    try {
      for (const record of records.value) {
        try {
          const receipt = await refreshEmail(record, profile, workspaceId)
          if (disposed || workspace.getActiveDoc()?.id !== workspaceId || workspace.getCurrentProfile()?.identity.personId !== profile.identity.personId) return
          observations.value[record.entity.id] = receipt
          delete observationErrors.value[record.entity.id]
        } catch (error) {
          delete observations.value[record.entity.id]
          observationErrors.value[record.entity.id] = error instanceof Error ? error.message : "Worker is unavailable"
          await instanceStatus.unavailable(record, profile, workspaceId)
        }
      }
    } finally { checking = false }
  }
  const run = automationActionRunner(busy, failure, owner)
  async function add(address: string, configuration: AutomationConfiguration, consent: boolean): Promise<void> {
    await run(async () => {
      if (!consent) throw new Error("Review workspace reading access before connecting")
      const profile = workspace.getCurrentProfile()
      const workspaceId = workspace.getActiveDoc()?.id
      const config = storage.value[0]
      if (!profile || !workspaceId || !config) throw new Error("Connect Rusty storage before adding an automation")
      const { activateAutomation, automationOrigin, enrollAutomation } = await import("./automationClient")
      const origin = automationOrigin(address)
      if (!pendingInstance || pendingInstance.origin !== origin || pendingInstance.workspaceId !== workspaceId) {
        pendingInstance = { workspaceId, origin, id: crypto.randomUUID() }
      }
      const instance = pendingInstance
      instance.identity ??= await enrollAutomation(profile, origin, workspaceId, instance.id, configuration)
      const text = await blind.exportAutomationAccess(config, JSON.stringify(instance.identity), configuration)
      if (workspace.getCurrentProfile()?.identity.personId !== profile.identity.personId || workspace.getActiveDoc()?.id !== workspaceId) {
        throw new Error("Identity or workspace changed during approval")
      }
      await activateAutomation(profile, instance.identity, workspaceId, JSON.parse(text))
      await blind.syncNow()
      pendingInstance = undefined
      await observeAll()
    })
  }
  async function retry(record: typeof records.value[number], configuration?: AutomationConfiguration): Promise<void> {
    await run(async () => {
      const profile = workspace.getCurrentProfile()
      const config = storage.value[0]
      if (!profile || !config) throw new Error("Connect Rusty storage before retrying activation")
      if (record.control.state === "deleted") throw new Error("Removed automations cannot be activated")
      const inspected = await inspectInstanceForScope(workspace, record, profile, config.workspaceId, owner, () => disposed)
      instanceStatus.requireApproval(record, inspected, Boolean(configuration))
      await reactivateInstanceForScope(workspace, blind, config, profile, record, inspected, owner, () => disposed, configuration)
      instanceStatus.clear(record)
      emailChecked.delete(record.entity.id)
      await blind.syncNow()
      await observeAll()
    })
  }
  async function setState(record: typeof records.value[number], state: AutomationDesiredState): Promise<void> {
    await run(async () => {
      await workspace.executeCommandAsync({ kind: "setAutomationState", automationId: record.entity.id, state })
      delete observations.value[record.entity.id]
      await blind.syncNow()
      await observeAll()
    })
  }
  const stop = watch(() => { void workspace.docVersion.value; return workspace.getActiveDoc()?.id }, () => { void observeAll() }, { immediate: true })
  const interval = setInterval(() => { now.value = Date.now(); void observeAll() }, 3_000)
  onBeforeUnmount(() => { disposed = true; stop(); clearInterval(interval) })
  return { types, records, storage, email, busy, failure, observationErrors, confirmation, instanceDescription: instanceStatus.description, add, retry, setState }
}
export type AutomationWorkspace = ReturnType<typeof useTincanban>
export type AutomationManagement = ReturnType<typeof useAutomations>

type MailboxRecord = ApplicationReviewRecord & { entity: { id: string; definition: string } }
function createInstanceStatus(now: Ref<number>, inspect: (record: MailboxRecord, profile: LocalProfile, workspaceId: string) => Promise<InspectedAutomationInstance>) {
  const instances = ref<Record<string, InspectedAutomationInstance>>({})
  const checked = new Map<string, number>()
  return {
    async unavailable(record: MailboxRecord, profile: LocalProfile, workspaceId: string) {
      if (now.value - (checked.get(record.entity.id) ?? 0) <= 30_000) return
      try { instances.value[record.entity.id] = await inspect(record, profile, workspaceId) }
      catch { delete instances.value[record.entity.id] }
      finally { checked.set(record.entity.id, now.value) }
    },
    requireApproval(record: MailboxRecord, inspected: InspectedAutomationInstance, explicit: boolean) {
      if (explicit || !inspected.description.adoptionRequired && inspected.description.expiresAt > Date.now()) return
      instances.value[record.entity.id] = inspected; checked.set(record.entity.id, Date.now())
      throw new Error("Review and confirm a new approval before adopting or renewing this Worker")
    },
    description(record: MailboxRecord) {
      return now.value - (checked.get(record.entity.id) ?? 0) < 60_000 ? instances.value[record.entity.id]?.description : undefined
    },
    clear(record: MailboxRecord) { delete instances.value[record.entity.id]; checked.delete(record.entity.id) },
  }
}
function automationActionRunner(busy: Ref<boolean>, failure: Ref<string>, owner: () => boolean) {
  return async (action: () => Promise<void>) => {
    if (busy.value) return
    busy.value = true; failure.value = ""
    try { if (!owner()) throw new Error("Only the workspace owner can manage automations"); await action() }
    catch (error) { failure.value = error instanceof Error ? error.message : "Automation request failed"; throw error }
    finally { busy.value = false }
  }
}
async function inspectInstanceForScope(workspace: AutomationWorkspace, record: MailboxRecord, profile: LocalProfile,
  workspaceId: string, owner: () => boolean, disposed: () => boolean) {
  const guards = mailboxScopeGuards(workspace, record, profile, workspaceId, owner, disposed)
  guards.ensureCurrent()
  const { inspectExistingAutomation } = await import("./automationInstanceManagement")
  const inspected = await inspectExistingAutomation(profile, { origin: record.entity.executor.origin, workspaceId,
    definitionId: record.definition.id, executorPersonId: record.entity.executor.personId }, guards)
  guards.ensureCurrent()
  return inspected
}
async function reactivateInstanceForScope(workspace: AutomationWorkspace, blind: BlindReplicationController,
  config: BlindReplicationController["configs"]["value"][number], profile: LocalProfile, record: MailboxRecord,
  inspected: InspectedAutomationInstance, owner: () => boolean, disposed: () => boolean, configuration?: AutomationConfiguration) {
  const text = await blind.exportAutomationAccess(config, JSON.stringify(inspected.identity), configuration)
  const current = readAutomationRecords(workspace).find(value => value.entity.id === record.entity.id)
  if (!current) throw new Error("Automation changed during approval")
  const guards = mailboxScopeGuards(workspace, current, profile, config.workspaceId, owner, disposed)
  const { reactivateExistingAutomation } = await import("./automationInstanceManagement")
  await reactivateExistingAutomation(profile, inspected, { workspaceId: config.workspaceId,
    packet: JSON.parse(text), explicitApproval: Boolean(configuration) }, guards)
}
async function readMailboxForScope(workspace: AutomationWorkspace, record: MailboxRecord, profile: LocalProfile,
  workspaceId: string, owner: () => boolean, disposed: () => boolean) {
  const guards = mailboxScopeGuards(workspace, record, profile, workspaceId, owner, disposed)
  const { readAutomationMailbox } = await import("./automationMailbox")
  guards.ensureCurrent()
  const mailbox = await readAutomationMailbox(profile, { origin: record.entity.executor.origin, definitionId: record.definition.id,
    workspaceId, personId: record.entity.executor.personId, grantId: record.definition.scope.grantId }, guards)
  guards.ensureCurrent()
  return mailbox
}
function confirmsAutomation(record: { definition: { scope: { grantId: string } }; control: { state: string; heads: string[] } },
  receipt: AutomationObservation | undefined, now: number): boolean {
  return !!receipt && receipt.grantId === record.definition.scope.grantId && now - receipt.issuedAt < 60_000 && receipt.state === record.control.state &&
    JSON.stringify([...receipt.heads].sort()) === JSON.stringify([...record.control.heads].sort())
}
function readAutomationRecords(workspace: AutomationWorkspace) {
  return Object.values(workspace.getActiveDoc()?.entities ?? {}).filter(entity => hasEntityKind(entity, "automation"))
    .map(entity => ({ entity, definition: parseAutomationDefinition(JSON.parse(entity.definition)), control: automationLifecycle(entity) }))
}

function mailboxScopeGuards(workspace: AutomationWorkspace, record: MailboxRecord, profile: LocalProfile,
  workspaceId: string, owner: () => boolean, disposed: () => boolean) {
  const ensureCurrent = () => {
    const current = workspace.getCurrentProfile(), live = workspace.getActiveDoc()?.entities[record.entity.id]
    if (disposed() || !owner() || workspace.getActiveDoc()?.id !== workspaceId || !current ||
      current.identity.personId !== profile.identity.personId || current.device.deviceId !== profile.device.deviceId ||
      current.certificate.signature !== profile.certificate.signature || !hasEntityKind(live, "automation") ||
      live.definition !== record.entity.definition || live.executor.personId !== record.entity.executor.personId ||
      live.executor.origin !== record.entity.executor.origin) throw new Error("Owner or automation changed during mailbox request")
  }
  return { ensureCurrent, currentAuthority: async () => {
    ensureCurrent()
    const { workspaceRole, localWorkspaceAdmissionAuthority } = await import("../sync/changeAuthorization")
    const doc = workspace.getActiveDoc()!
    if (await workspaceRole(doc, profile) !== "owner") throw new Error("Current workspace owner authority is required")
    const authority = await localWorkspaceAdmissionAuthority(doc, profile)
    ensureCurrent()
    return authority.fingerprint
  } }
}
