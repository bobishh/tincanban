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
