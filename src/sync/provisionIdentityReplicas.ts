import type { useTincanban } from "../state"
import type { BlindReplicaConfig } from "./blindReplication"
import { provisionIdentityReplica } from "./provisionIdentityReplica"
import { requiresRustyPermissionMigration } from "./rustyPermissionMigration"

/** Profile setup is network work; load its orchestration only for configured servers. */
export async function provisionIdentityReplicas(app: Pick<ReturnType<typeof useTincanban>, "getCurrentProfile">,
  configurations: BlindReplicaConfig[], identityOrigins: Set<string>, guard: () => void,
  migrationRequired?: (origin: string) => void): Promise<Record<string, string>> {
  const errors: Record<string, string> = {}
  const origins = new Map(configurations.map(config => [config.origin, config]))
  for (const config of origins.values()) {
    guard()
    if (identityOrigins.has(config.origin)) continue
    try {
      const profile = app.getCurrentProfile()
      if (!profile) throw new Error("Identity unavailable during profile setup")
      await provisionIdentityReplica(config, profile, guard)
      guard()
    } catch (cause) {
      guard()
      if (requiresRustyPermissionMigration(cause)) migrationRequired?.(config.origin)
      errors[config.origin] = cause instanceof Error ? cause.message : "Private profile setup unavailable"
    }
  }
  guard()
  return errors
}
