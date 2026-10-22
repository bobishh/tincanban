import { identityEnrollmentConfirmed } from "./identityEnrollmentReceipt"
import type { LocalProfile } from "../domain/identity"

export type IdentityRegistrationCommand<Intent, Result> = {
  capture(): Promise<Intent>
  skipRegistration?(profile: LocalProfile, intent: Intent): Promise<boolean> | boolean
  assertCurrent?(profile: LocalProfile, intent: Intent): Promise<void> | void
  recheckAuthority(profile: LocalProfile, intent: Intent): Promise<void> | void
  execute(profile: LocalProfile, intent: Intent): Promise<Result>
}

/** Preserve the exact owner command while Identity enrollment runs. */
export function createIdentityRegistrationGate(options: {
  configured: boolean
  getProfile(): LocalProfile | null | undefined
  refreshIdentity(): Promise<void>
  requestRegistration(): Promise<boolean>
}) {
  return {
    async run<Intent, Result>(command: IdentityRegistrationCommand<Intent, Result>): Promise<Result | undefined> {
      const profile = options.getProfile()
      if (!profile) throw new Error("Local Identity is not ready")
      const intent = await command.capture()
      if (!options.configured || await command.skipRegistration?.(profile, intent) ||
          await identityEnrollmentConfirmed(profile)) {
        await command.recheckAuthority(profile, intent)
        return await command.execute(profile, intent)
      }
      if (!await options.requestRegistration()) return undefined
      await options.refreshIdentity()
      const current = options.getProfile()
      if (!current || current.identity.personId !== profile.identity.personId || current.device.deviceId !== profile.device.deviceId) {
        throw new Error("Identity changed while enrollment was in progress")
      }
      await command.assertCurrent?.(profile, intent)
      await command.recheckAuthority(profile, intent)
      return await command.execute(current, intent)
    },
  }
}
