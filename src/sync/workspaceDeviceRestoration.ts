import type { LocalProfile } from "../domain/identity"
import type { PeerStore, WorkspaceMeshCredential } from "./peerStore"
import { createWorkspaceDeviceRestoration, type WorkspaceDeviceRevocation } from "./meshRecords"
import { deviceRevocations, isDeviceRevoked } from "./durableMeshBase"
import { meshRecordSigning } from "./meshRecordSigning"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"

export async function removableWorkspaceDevices(profile: LocalProfile, store: PeerStore, personId: string, deviceId: string): Promise<string[]> {
  const ids: string[] = []
  for (const credential of await store.listWorkspaceCredentials()) {
    const peer = await store.getPeer(credential.workspaceId, deviceId)
    if (meshRustRuntime().state.canRemoveWorkspaceDevice(credential, profile.identity.personId,
      profile.identity.publicKey, profile.device.deviceId, personId, deviceId, peer?.personId)) ids.push(credential.workspaceId)
  }
  return ids.sort()
}

type RestorationPorts = {
  store: PeerStore
  heads: (workspaceId: string) => Promise<string[]>
  merge: (credential: WorkspaceMeshCredential, records: WorkspaceDeviceRevocation[]) => Promise<void>
  reclassify: (workspaceId: string) => Promise<void>
}

/** Called only after explicit approval of the authenticated enrollment request. */
export async function restoreEnrolledWorkspaceDevices(profile: LocalProfile, workspaceIds: string[], personId: string,
  deviceId: string, ensureCurrent: () => void, ports: RestorationPorts): Promise<void> {
  ensureCurrent()
  for (const workspaceId of new Set(workspaceIds)) {
    const credential = await ports.store.getWorkspaceCredential(workspaceId)
    ensureCurrent()
    if (!credential || !isDeviceRevoked(credential, personId, deviceId)) continue
    const restores = deviceRevocations(credential).filter(value => !value.record.payload.restores
      && value.record.payload.personId === personId && value.record.payload.deviceId === deviceId)
      .map(value => value.record.signature)
    const record = await createWorkspaceDeviceRestoration(profile, workspaceId, personId, deviceId,
      await ports.heads(workspaceId), restores,
      await meshRecordSigning(profile, credential, { kind: "device-restoration", personId, deviceId }, ports.store))
    ensureCurrent()
    await ports.merge(credential, [record])
    await ports.reclassify(workspaceId)
    ensureCurrent()
  }
}
