import type { KeeperPairing } from "./keeperPairing"
import { canonicalKeeperIntegrationId, selectCanonicalServiceIntegration, selectKeeperReference } from "./keeperIntegrationSelection"
import { bootstrapIdentity } from "../domain/identity"

export async function beginKeeperPolicyUpdate(personId: string, baselineWorkspaceIds: string[]): Promise<KeeperPairing> {
  const profile = await bootstrapIdentity()
  const [{ keeperIntegrationReferences }, { discoverKeeper }, pairingApi] = await Promise.all([
    import("./ownerKeeper"), import("./keeperDiscovery"), import("./keeperPairing"),
  ])
  const { integrations } = await keeperIntegrationReferences()
  const reference = selectKeeperReference(integrations, personId)
  if (!reference) throw new Error("Saved Rusty integration could not be verified.")
  if (reference.state !== "active") throw new Error("Saved Rusty integration is not active.")
  const discovery = await discoverKeeper(reference.serviceOrigin)
  const current = await pairingApi.getKeeperIntegrationStatus(discovery)
  const canonicalId = await canonicalKeeperIntegrationId(profile.identity.personId, discovery.personId)
  const integration = selectCanonicalServiceIntegration(current.integrations, canonicalId)
  if (!integration || integration.pendingOperation || integration.futureBoards) {
    throw new Error("Rusty integration changed or has cleanup pending. Reload settings and retry.")
  }
  if (integration.integrationId !== reference.integrationId) {
    throw new Error("Saved Rusty integration differs from its canonical signed service record.")
  }
  const completeBaseline = [...new Set([...baselineWorkspaceIds,
    ...integration.scopes.map(scope => scope.workspaceId), ...integration.tombstones.map(scope => scope.workspaceId)])].sort()
  return pairingApi.beginKeeperPairing(discovery, [], {
    futureBoards: true, futureBoardBaselineIds: completeBaseline, policyOnly: true,
  })
}
