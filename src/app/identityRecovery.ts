import type { IdentitySecurity } from "../domain/identity"
import type { IdentityRecoveryFile } from "../sync/identityDeviceRecoveryCodec"
export { maximumIdentityRecoveryFileBytes, parseIdentityRecoveryFile,
  type IdentityDeviceRecoveryFile, type IdentityRecoveryFile } from "../sync/identityDeviceRecoveryCodec"

export async function createIdentityDeviceRecovery(security: IdentitySecurity) {
  const recovery = await import("../sync/identityDeviceRecovery")
  return recovery.createIdentityDeviceRecovery(security)
}

export async function restoreIdentityDeviceRecovery(file: IdentityRecoveryFile, words: string, displayName: string,
  replaceExisting: boolean, beforeRestore: () => Promise<void>) {
  const recovery = await import("../sync/identityDeviceRecovery")
  return recovery.restoreIdentityDeviceRecovery(file, words, displayName, replaceExisting, beforeRestore)
}
