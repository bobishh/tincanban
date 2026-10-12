import { computed, onBeforeUnmount, ref, watch } from "vue"
import type { LocalProfile } from "../domain/identity"
import type { useTincanban } from "../state"
import type { BlindReplicationController } from "./blindReplication"
import type { AutomationConfiguration, AutomationWorkerIdentity } from "./automation"
import { activateAutomation, automationOrigin, enrollAutomation, observeAutomation, readAutomationEmail, type AutomationEmailSetup } from "./automationClient"
import { automationLifecycle, type AutomationDesiredState } from "../domain/automationLifecycle"
import { parseAutomationDefinition } from "../domain/automationContract"
import { hasEntityKind } from "../domain/model"
import type { AutomationObservation } from "../domain/automationProtocol"

export function useAutomations(workspace: ReturnType<typeof useTincanban>, blind: BlindReplicationController, owner: () => boolean) {
  const busy = ref(false)
  const failure = ref("")
  const observations = ref<Record<string, AutomationObservation>>({})
  const email = ref<Record<string, AutomationEmailSetup>>({})
  const observationErrors = ref<Record<string, string>>({})
  const now = ref(Date.now())
  const emailChecked = new Map<string, number>()
  let disposed = false
  let checking = false
  let pendingInstance: { workspaceId: string; origin: string; id: string; identity?: AutomationWorkerIdentity } | undefined
  const records = computed(() => {
    void workspace.docVersion.value
    return Object.values(workspace.getActiveDoc()?.entities ?? {}).filter(entity => hasEntityKind(entity, "automation"))
      .map(entity => ({ entity, definition: parseAutomationDefinition(JSON.parse(entity.definition)), control: automationLifecycle(entity) }))
  })
  const storage = computed(() => blind.configs.value.filter(value => value.workspaceId === workspace.getActiveDoc()?.id && !value.removalPending))
  function confirmation(record: typeof records.value[number]): boolean {
    const receipt = observations.value[record.entity.id]
    return !!receipt && receipt.grantId === record.definition.scope.grantId && now.value - receipt.issuedAt < 60_000 && receipt.state === record.control.state &&
      JSON.stringify([...receipt.heads].sort()) === JSON.stringify([...record.control.heads].sort())
  }
  async function refreshEmail(record: typeof records.value[number], profile: LocalProfile, workspaceId: string) {
    if (now.value - (emailChecked.get(record.entity.id) ?? 0) <= 30_000) return
    try {
      const setup = await readAutomationEmail(profile, { origin: record.entity.executor.origin, integrationId: record.definition.id, workspaceId })
      if (!disposed && workspace.getActiveDoc()?.id === workspaceId && workspace.getCurrentProfile()?.identity.personId === profile.identity.personId) {
        email.value[record.entity.id] = setup
      }
    } catch { delete email.value[record.entity.id] }
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
          const receipt = await observeAutomation(profile, { origin: record.entity.executor.origin, personId: record.entity.executor.personId,
            integrationId: record.definition.id, workspaceId, grantId: record.definition.scope.grantId })
          if (disposed || workspace.getActiveDoc()?.id !== workspaceId || workspace.getCurrentProfile()?.identity.personId !== profile.identity.personId) return
          observations.value[record.entity.id] = receipt
          await refreshEmail(record, profile, workspaceId)
          delete observationErrors.value[record.entity.id]
        } catch (error) {
          delete observations.value[record.entity.id]
          observationErrors.value[record.entity.id] = error instanceof Error ? error.message : "Worker is unavailable"
        }
      }
    } finally { checking = false }
  }
  async function run(action: () => Promise<void>) {
    if (busy.value) return
    busy.value = true; failure.value = ""
    try { if (!owner()) throw new Error("Only the workspace owner can manage automations"); await action() }
    catch (error) { failure.value = error instanceof Error ? error.message : "Automation request failed"; throw error }
    finally { busy.value = false }
  }
  async function add(address: string, configuration: AutomationConfiguration, consent: boolean): Promise<void> {
    await run(async () => {
      if (!consent) throw new Error("Review workspace reading access before connecting")
      const profile = workspace.getCurrentProfile()
      const workspaceId = workspace.getActiveDoc()?.id
      const config = storage.value[0]
      if (!profile || !workspaceId || !config) throw new Error("Connect Rusty storage before adding an automation")
      const origin = automationOrigin(address)
      if (!pendingInstance || pendingInstance.origin !== origin || pendingInstance.workspaceId !== workspaceId) {
        pendingInstance = { workspaceId, origin, id: crypto.randomUUID() }
      }
      const instance = pendingInstance
      instance.identity ??= await enrollAutomation(profile, origin, workspaceId, instance.id)
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
      const identity = await enrollAutomation(profile, record.entity.executor.origin, config.workspaceId, record.definition.id)
      const text = await blind.exportAutomationAccess(config, JSON.stringify(identity), configuration)
      await activateAutomation(profile, identity, config.workspaceId, JSON.parse(text))
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
  return { records, storage, email, busy, failure, observationErrors, confirmation, add, retry, setState }
}
export type AutomationWorkspace = ReturnType<typeof useTincanban>
export type AutomationManagement = ReturnType<typeof useAutomations>
