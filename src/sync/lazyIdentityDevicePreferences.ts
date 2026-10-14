import type { LocalProfile } from "../domain/identity"
import type { WorkspaceSetStore } from "./workspaceSet"

/** Private preferences load only after negotiating a same-identity session. */
export function lazyIdentityDevicePreferences(store: WorkspaceSetStore, profile: LocalProfile, remotePersonId: string, remoteDeviceId: string, isCurrent: () => boolean) {
  if (remotePersonId !== profile.identity.personId) return store
  let wrapped: Promise<WorkspaceSetStore> | undefined
  const load = () => wrapped ??= import("./identityDevicePreferences").then(module => module.withIdentityDevicePreferences(store, profile, remotePersonId, remoteDeviceId, isCurrent))
  return { ...store, readMesh: async (id: string) => (await load()).readMesh!(id),
    mergeMesh: async (id: string, value: unknown) => (await load()).mergeMesh!(id, value) }
}
