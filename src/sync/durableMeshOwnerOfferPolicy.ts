import type { LocalProfile } from "../domain/identity"
import type { KeeperIntegrationReference } from "../domain/model"
import { keeperIntegrationReferences, ownerKeepers, type OwnerKeeper } from "./ownerKeeper"
import { z } from "zod"

export const ownerWorkspaceOfferSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string().min(1),
  envelope: z.unknown(),
  workspace: z.unknown(),
}).passthrough()

function selectOwnerKeeperOfferReference(references: KeeperIntegrationReference[]) {
  const live = references.filter(item => item.state !== "removed")
  if (live.length === 1) return live[0]
  return live.length === 0 && references.length === 0 ? undefined : null
}

/** Returns a real signed grant only when this identity still verifies for it. */
export async function ownerKeeperOfferPolicy(profile: LocalProfile, remotePersonId: string): Promise<{ allowed: boolean; keeper?: OwnerKeeper }> {
  if (remotePersonId === profile.identity.personId) return { allowed: true }
  let keeper = (await ownerKeepers(profile.identity.personId)).find(item => item.personId === remotePersonId)
  let references
  try {
    const { integrations } = await keeperIntegrationReferences()
    references = Object.values(integrations).filter(item => item.servicePersonId === remotePersonId)
  } catch {
    return { allowed: false }
  }
  // Integration revisions are scoped to integrationId. Never use one service's
  // revision values to choose between distinct legacy/canonical records.
  const reference = selectOwnerKeeperOfferReference(references)
  if (reference === null) return { allowed: false }
  // A durable ref with no live integration still outranks the legacy cache.
  if (reference && reference.state !== "active") return { allowed: false }
  // Do not mint owner grants against committed policy while a settings CAS is unresolved.
  if (reference?.pendingSettings || reference?.pendingRemoval) return { allowed: false }
  if (reference) keeper = { personId: remotePersonId, role: "editor", details: {
    boardIds: reference.workspaceIds,
    futureBoards: reference.futureBoards,
    futureBoardBaselineIds: reference.futureBoardBaselineIds,
    integrationId: reference.integrationId,
    removalPending: Boolean(reference.pendingRemoval),
  } }
  if (!keeper || keeper.details?.removalPending) return { allowed: false }
  return { allowed: true, keeper }
}
