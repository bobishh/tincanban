import type { LocalProfile } from "../domain/identity"
import type { WorkspaceSetStore } from "./workspaceSet"

import { withIdentityDevicePreferences } from "./identityDevicePreferences"

type PreferencesModule = { withIdentityDevicePreferences: typeof withIdentityDevicePreferences }

/** Private preferences are exchanged only within a negotiated same-identity session. */
export function lazyIdentityDevicePreferences(store: WorkspaceSetStore, profile: LocalProfile, remotePersonId: string,
  remoteDeviceId: string, isCurrent: () => boolean, importPreferences: () => Promise<PreferencesModule> = async () => ({ withIdentityDevicePreferences })) {
  if (remotePersonId !== profile.identity.personId) return store
  let wrapped: Promise<WorkspaceSetStore> | undefined
  const ensureCurrent = () => { if (!isCurrent()) throw new Error("Device session is no longer authorized") }
  const load = () => {
    ensureCurrent()
    if (!wrapped) {
      const attempt = importPreferences().then(module => {
        ensureCurrent()
        return module.withIdentityDevicePreferences(store, profile, remotePersonId, remoteDeviceId, isCurrent)
      })
      wrapped = attempt
      // A network failure must not poison every later publication in this session.
      void attempt.catch(() => { if (wrapped === attempt) wrapped = undefined })
    }
    return wrapped
  }
  return { ...store,
    readMesh: async (id: string) => { const current = await load(); ensureCurrent(); return current.readMesh!(id) },
    mergeMesh: async (id: string, value: unknown) => { const current = await load(); ensureCurrent(); return current.mergeMesh!(id, value) },
  }
}
