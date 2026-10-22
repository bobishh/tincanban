import type { SignedEnvelope } from "../domain/identity"
import type { ManagementBinding, PortableManagementRecord } from "./rustyManagementRepository"
import type { RustyManagementCapability } from "./rustyManagementCapability"
import { verifyRustyManagementStatus, type ManagementStatusAuthorization, type RustyManagementStatusResponse } from "./rustyManagementStatus"

type ManagementStatusObservation = {
  deviceId: string
  authorization: SignedEnvelope<ManagementStatusAuthorization>
  response: RustyManagementStatusResponse
}
export type ManagementConflictResolver = (binding: ManagementBinding) => Promise<ManagementStatusObservation>

/** Explicit enrollment may reconcile equal revisions only against a fresh, pinned server response. */
export async function reconcileManagementConflict(owner: string, previous: SignedEnvelope<RustyManagementCapability>,
  incoming: PortableManagementRecord, resolve: ManagementConflictResolver): Promise<SignedEnvelope<RustyManagementCapability>> {
  const binding = structuredClone(incoming.binding)
  const observation = structuredClone(await resolve(binding))
  const verified = await verifyRustyManagementStatus(observation.response, binding, { personId: owner,
    deviceId: observation.deviceId, resourceKind: binding.resourceKind, resourceId: binding.resourceId,
    operation: "management.update", minimumRevision: Math.max(previous.payload.revision, incoming.capability.payload.revision) },
  observation.authorization)
  if (!verified.capability || verified.migrationPending || !observation.response.capability) {
    throw new Error("Rusty permissions are not ready for device enrollment")
  }
  return observation.response.capability
}
