import { keeperApi } from "./keeperApi"
import { keeperIntegrationAvailability, type KeeperIntegrationAvailabilityResult,
  type KeeperIntegrationStatusProbe } from "./keeperIntegrationAvailability"
import type { MeshMemberView } from "../ui/deviceInfo"

export async function loadKeeperReferenceViews(
  onAvailability?: (personId: string, integrationId: string, revision: number, result: KeeperIntegrationAvailabilityResult) => void,
  probe?: KeeperIntegrationStatusProbe,
): Promise<{ pending: MeshMemberView[]; saved: MeshMemberView[] }> {
  const [references, activeReferences] = await Promise.all([
    keeperApi.pendingRemovalReferences(), keeperApi.activeIntegrationReferences(),
  ])
  const referencesByPerson = new Map<string, typeof activeReferences>()
  for (const reference of activeReferences) {
    const group = referencesByPerson.get(reference.servicePersonId) ?? []
    group.push(reference)
    referencesByPerson.set(reference.servicePersonId, group)
  }
  const saved = [...referencesByPerson.values()].map((personReferences): MeshMemberView => {
    const reference = personReferences[0]!
    const ambiguous = personReferences.length > 1
    return {
      personId: reference.servicePersonId, name: "Rusty keeper", role: "editor", online: false,
      reconnecting: false, onlineDevices: 0, devices: 0, self: false, deviceList: [],
      ...(ambiguous ? {} : { integrationId: reference.integrationId, integrationRevision: reference.revision }),
      integrationAvailability: ambiguous ? "needs-review" : "unknown",
      ...(ambiguous ? { integrationAvailabilityReason: "Multiple saved Rusty integrations need review." } : {}),
      integrationBoardIds: [...new Set(personReferences.flatMap(item => item.workspaceIds))],
    }
  })
  if (onAvailability) {
    const uniqueReferences = [...referencesByPerson.values()].filter(group => group.length === 1).map(group => group[0]!)
    for (const reference of uniqueReferences) {
      void keeperIntegrationAvailability(reference, probe ?? keeperApi.integrationStatus).then(result => {
        try { onAvailability(reference.servicePersonId, reference.integrationId, reference.revision, result) }
        catch { /* caller may have unloaded */ }
      })
    }
  }
  const pending = references.map((reference): MeshMemberView => {
    const deviceIds = "serviceDeviceIds" in reference ? reference.serviceDeviceIds : [reference.serviceDeviceId]
    const knownDeviceIds = (deviceIds?.length ? deviceIds : [reference.serviceDeviceId])
      .filter((deviceId): deviceId is string => typeof deviceId === "string" && deviceId.length > 0)
    return {
      personId: reference.servicePersonId, name: "Rusty keeper", role: "editor", online: false,
      reconnecting: false, onlineDevices: 0, devices: knownDeviceIds.length || 1, self: false,
      pendingRemoval: true,
      deviceList: knownDeviceIds.map(deviceId => ({ deviceId, name: "Rusty", online: false, reconnecting: false,
        lastSeen: reference.verifiedAt, userAgent: "mesh-keeper/1.0.0", description: "Rusty", tabs: 1 })),
    }
  })
  return { pending, saved }
}
