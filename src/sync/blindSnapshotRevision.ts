import type { useTincanban } from "../state"
import { defaultStorage } from "../storage"
import { exportChat } from "../chat/service"
import { canonicalizeJson } from "../domain/identity"
import { localWorkspaceAdmissionAuthority } from "./changeAuthorization"
import { admissionPolicy } from "./workspaceAdmissionCheckpoint"

/** Bind unchanged polling to durable raw evidence, current rights and bounded chat export. */
export function createBlindSnapshotRevision(app: Pick<ReturnType<typeof useTincanban>, "readWorkspaceDoc" | "getCurrentProfile">) {
  let cachedRoot: { id: string; ownerPersonId: string; revision: string } | undefined
  return async (id: string): Promise<string | undefined> => {
    const revision = await defaultStorage.readWorkspaceRevision(id)
    if (!revision) return undefined
    if (cachedRoot?.id !== id || cachedRoot.revision !== revision) {
      const doc = await app.readWorkspaceDoc(id)
      cachedRoot = { id, ownerPersonId: doc.ownerPersonId, revision }
    }
    const profile = app.getCurrentProfile() ?? undefined
    const context = await localWorkspaceAdmissionAuthority(cachedRoot, profile)
    const chat = await exportChat(id)
    if (await defaultStorage.readWorkspaceRevision(id) !== revision ||
      (await localWorkspaceAdmissionAuthority(cachedRoot, profile)).fingerprint !== context.fingerprint) return undefined
    return canonicalizeJson([revision, context.fingerprint, admissionPolicy(), { ...chat, typing: [] }])
  }
}
