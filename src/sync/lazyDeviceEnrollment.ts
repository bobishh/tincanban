import { ownedWorkspaceIds } from "./deviceManagementActions"
import { subscribeIdentityDevicePreferences } from "./identityDevicePreferenceEvents"
import { meshTrace } from "./meshTrace"
import type { IdentityPeerRecovery } from "./identityPeerRecovery"
import type { selectDeviceEnrollment } from "./deviceSyncEnrollment"

type Context = Parameters<typeof selectDeviceEnrollment>[0]

/** Enrollment code belongs to an explicit action, with cancellation checked across every load. */
export async function selectDeviceEnrollmentLazily(context: () => Context, initialize: () => Promise<unknown>): Promise<void> {
  const initial = context(), run = initial.currentRun()
  await initialize()
  if (initial.currentRun() !== run) return
  const { selectDeviceEnrollment } = await import("./deviceSyncEnrollment")
  if (initial.currentRun() !== run) return
  await selectDeviceEnrollment(context())
}

export async function requestDeviceEnrollmentLazily(context: () => Context, initialize: () => Promise<unknown>, replaceIdentity: boolean): Promise<void> {
  const initial = context(), state = initial.state, invite = state.parsedInvite.value
  if (!invite || invite.kind !== "device-enrollment" || state.step.value !== "enroll-guest") return
  const run = initial.currentRun()
  const isCurrent = () => initial.currentRun() === run && state.parsedInvite.value === invite && state.step.value === "enroll-guest"
  await initialize()
  if (!isCurrent()) return
  const profile = await initial.getProfile()
  if (!isCurrent()) return
  if (profile.identity.personId !== invite.issuerPersonId && (!replaceIdentity || state.enrollmentConflict.value?.currentPersonId !== profile.identity.personId)) {
    state.error.value = "Identity conflict: confirm the identity replacement first."
    return
  }
  const { requestDeviceEnrollment } = await import("./deviceSyncEnrollment")
  if (!isCurrent()) return
  state.replacementPersonId.value = replaceIdentity ? profile.identity.personId : undefined
  await requestDeviceEnrollment(context(), invite)
}

/** A closed controller cannot start a recovery listener after its optional code finishes loading. */
export function lazyIdentityPeerRecovery(context: () => Context, initialize: () => Promise<unknown>) {
  let recovery: IdentityPeerRecovery | undefined
  let loading: Promise<IdentityPeerRecovery | undefined> | undefined
  let disposed = false
  const load = () => loading ??= (async () => {
    await initialize()
    if (disposed) return
    const current = context(), store = current.meshWorkspaceStore ?? current.workspaceStore, mesh = current.durableMesh
    if (!store || !mesh) return
    const input: ConstructorParameters<typeof IdentityPeerRecovery>[0] = { transport: current.transport, store, mesh,
      getProfile: () => context().getProfile(), changed: async () => { await context().identityChanged?.() },
      ownedWorkspaces: async () => {
        const live = context(), profile = await live.getProfile()
        const ids = new Set(await ownedWorkspaceIds(live.availableWorkspaces, live.workspaceOwner, profile.identity.personId))
        return live.availableWorkspaces.filter(workspace => ids.has(workspace.id))
      } }

    const { IdentityPeerRecovery } = await import("./identityPeerRecovery")
    if (!disposed) recovery = new IdentityPeerRecovery(input)
    return recovery
  })().catch(error => { loading = undefined; throw error })
  const start = async () => {
    if (!disposed) await (await load())?.start().catch(error => {
      meshTrace("identity.peer-recovery.start.failed", { reason: error instanceof Error ? error.message : String(error) }, "warn")
    })
  }
  const unsubscribe = subscribeIdentityDevicePreferences(() => { if (context().state.isEnabled.value) void start() })
  return {
    start,
    recover: async (ids: string[]) => { if (!disposed) await (await load())?.recover(ids) },
    close: async (permanent = false) => {
      if (permanent) { disposed = true; unsubscribe() }
      await (recovery ?? await loading)?.close()
    },
  }
}
