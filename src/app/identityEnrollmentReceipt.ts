import type { LocalProfile } from "../domain/identity"
import { certHashDefault } from "../domain/proofValidation"
import { readLocal } from "../localDb"

export const identityEnrollmentPrefix = "tincanban.identity.enrollment.v1."

export async function identityEnrollmentConfirmed(profile: LocalProfile): Promise<boolean> {
  const raw = await readLocal(`${identityEnrollmentPrefix}${profile.identity.personId}`)
  if (!raw) return false
  try {
    const record = JSON.parse(raw) as { personId?: unknown; deviceId?: unknown; certificateHash?: unknown; completedAt?: unknown }
    return record.personId === profile.identity.personId && record.deviceId === profile.device.deviceId &&
      record.certificateHash === await certHashDefault(profile.certificate) && typeof record.completedAt === "string"
  } catch { return false }
}
