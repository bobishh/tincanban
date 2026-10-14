const listeners = new Set<(owner: string) => void>()
export function subscribeIdentityDevicePreferences(listener: (owner: string) => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function identityDevicePreferencesChanged(owner: string) {
  for (const listener of listeners) listener(owner)
}
