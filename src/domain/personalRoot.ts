import type {
  PersonalRootDocumentV1,
  RegisteredDevice,
  WorkspaceId,
  Hash,
} from "./model"
import type { LocalProfile } from "./identity"

export function createPersonalRoot(
  profile: LocalProfile,
  initialCertificateHash: Hash,
  rootId = crypto.randomUUID(),
  nowIso = new Date().toISOString()
): PersonalRootDocumentV1 {
  const initialDevice: RegisteredDevice = {
    deviceId: profile.device.deviceId,
    publicKey: profile.device.publicKey,
    displayName: profile.device.displayName,
    certificateHash: initialCertificateHash,
    addedAt: nowIso,
  }

  return {
    kind: "personal-root",
    formatVersion: 1,
    rootId,
    identity: { ...profile.identity },
    devices: {
      [profile.device.deviceId]: initialDevice,
    },
    workspaces: {},
  }
}

export function registerDeviceInRoot(
  root: PersonalRootDocumentV1,
  device: RegisteredDevice
): void {
  root.devices[device.deviceId] = {
    deviceId: device.deviceId,
    publicKey: device.publicKey,
    displayName: device.displayName,
    certificateHash: device.certificateHash,
    addedAt: device.addedAt,
  }
}

export function registerWorkspaceInRoot(
  root: PersonalRootDocumentV1,
  workspaceId: WorkspaceId,
  documentId: string,
  grantHash: Hash
): void {
  const existing = root.workspaces[workspaceId]
  root.workspaces[workspaceId] = {
    workspaceId,
    documentId,
    grantHash,
    forgotten: existing ? existing.forgotten : false,
  }
}

export function forgetWorkspaceInRoot(
  root: PersonalRootDocumentV1,
  workspaceId: WorkspaceId
): void {
  if (root.workspaces[workspaceId]) {
    root.workspaces[workspaceId].forgotten = true
  }
}

export function reconcilePersonalRootWorkspaces(
  root: PersonalRootDocumentV1,
  storedWorkspaces: { id: string; grantHash?: string }[]
): string[] {
  const newlyRegistered: string[] = []
  for (const stored of storedWorkspaces) {
    if (!root.workspaces[stored.id]) {
      registerWorkspaceInRoot(
        root,
        stored.id,
        stored.id,
        stored.grantHash ?? "genesis"
      )
      newlyRegistered.push(stored.id)
    }
  }
  return newlyRegistered
}

/** Remove old broad-catalog registrations that claimed genesis ownership under another identity. */
export function pruneForeignGenesisWorkspaceRefs(
  root: PersonalRootDocumentV1,
  ownerByWorkspaceId: ReadonlyMap<string, string>,
): string[] {
  const removed: string[] = []
  for (const [workspaceId, reference] of Object.entries(root.workspaces ?? {})) {
    const owner = ownerByWorkspaceId.get(workspaceId)
    if (reference.grantHash === "genesis" && owner && owner !== root.identity.personId) {
      delete root.workspaces[workspaceId]
      removed.push(workspaceId)
    }
  }
  return removed
}
