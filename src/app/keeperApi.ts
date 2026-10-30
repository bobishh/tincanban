import { discoverKeeper, type KeeperDiscovery, type KeeperWorkspace } from "../sync/keeperDiscovery"
import { beginKeeperPairing, decideKeeperPairing, getEligibleKeeperWorkspaces, getKeeperIntegrationStatus, newKeeperOperationId, rememberActiveKeeperIntegration, type KeeperPairing } from "../sync/keeperPairing"
import { completeKeeperPairingWithdrawal, getKeeperPairingStatusInfo, requestKeeperPairingWithdrawal } from "../sync/keeperPairingWithdrawalApi"
import { restoreKeeperPairing } from "./keeperWithdrawalUi"
import { bootstrapIdentity } from "../domain/identity"
import { keeperIntegrationReferences, ownerKeepers, pendingKeeperWithdrawals, type KeeperDetails, type PendingKeeperWithdrawal } from "../sync/ownerKeeper"
import { canonicalKeeperIntegrationId, selectCanonicalServiceIntegration, selectKeeperReference } from "../sync/keeperIntegrationSelection"

export type { KeeperWorkspace } from "../sync/keeperDiscovery"
export type { KeeperPairing, KeeperPairingStatus } from "../sync/keeperPairing"
export type { KeeperDetails } from "../sync/ownerKeeper"
export type KeeperServiceDiscovery = KeeperDiscovery

function withdrawalTargets(entry: PendingKeeperWithdrawal, discovery: KeeperDiscovery, integrationId?: string) {
  if (entry.orphanResolution) return false
  const saved = entry.pairing as { integrationId?: unknown; discovery?: Partial<KeeperDiscovery> } | undefined
  const target = saved?.discovery
  return target?.origin === discovery.origin && target.personId === discovery.personId
    && target.deviceId === discovery.deviceId && (!integrationId || saved?.integrationId === integrationId)
}

async function reconcileTargetWithdrawals(discovery: KeeperDiscovery, integrationId: string | undefined,
  cancel: (pairing: KeeperPairing, operationId: string) => Promise<"cancel_pending" | "cancelled" | "orphan_resolved">,
  shouldContinue: () => boolean) {
  for (const entry of await pendingKeeperWithdrawals()) {
    if (!shouldContinue()) return
    if (!withdrawalTargets(entry, discovery, integrationId)) continue
    const pairing = restoreKeeperPairing(entry)
    if (!pairing) throw new Error("A previous request for this Rusty integration needs cleanup. No new access request was sent.")
    let result: "cancel_pending" | "cancelled" | "orphan_resolved"
    try {
      result = await cancel(pairing, entry.operationId)
    } catch (cause) {
      throw new Error("A previous request for this Rusty integration still needs cleanup. No new access request was sent.", { cause })
    }
    if (!shouldContinue()) return
    if (result === "cancel_pending") {
      throw new Error("A previous request for this Rusty integration still needs cleanup. No new access request was sent.")
    }
  }
}

/** Application boundary used by keeper discovery and approval controls. */
export const keeperApi = {
  discover: discoverKeeper,
  integrationStatus: getKeeperIntegrationStatus,
  async selectCanonicalIntegration(discovery: KeeperDiscovery,
    integrations: Awaited<ReturnType<typeof getKeeperIntegrationStatus>>["integrations"]) {
    const profile = await bootstrapIdentity()
    const canonicalId = await canonicalKeeperIntegrationId(profile.identity.personId, discovery.personId)
    return selectCanonicalServiceIntegration(integrations, canonicalId)
  },
  eligibleWorkspaces: getEligibleKeeperWorkspaces,
  beginPairing: beginKeeperPairing,
  async beginPairingAfterWithdrawalReconciliation(
    discovery: KeeperDiscovery,
    workspaces: KeeperWorkspace[],
    options: Parameters<typeof beginKeeperPairing>[2],
    cancel: (pairing: KeeperPairing, operationId: string) => Promise<"cancel_pending" | "cancelled" | "orphan_resolved">,
    shouldContinue: () => boolean = () => true,
  ): Promise<KeeperPairing | null> {
    const profile = await bootstrapIdentity()
    const { integrations } = await keeperApi.integrationStatus(discovery)
    if (!shouldContinue()) return null
    const canonicalId = await canonicalKeeperIntegrationId(profile.identity.personId, discovery.personId)
    selectCanonicalServiceIntegration(integrations, canonicalId)
    await reconcileTargetWithdrawals(discovery, undefined, cancel, shouldContinue)
    if (!shouldContinue()) return null
    return keeperApi.beginPairing(discovery, workspaces, options)
  },
  decidePairing: decideKeeperPairing,
  newOperationId: newKeeperOperationId,
  requestWithdrawal: requestKeeperPairingWithdrawal,
  completeWithdrawal: completeKeeperPairingWithdrawal,
  pendingWithdrawals: pendingKeeperWithdrawals,
  async pairingStatus(pairing: KeeperPairing) {
    const result = await getKeeperPairingStatusInfo(pairing)
    if (result.status === "active" && !result.withdrawal) await rememberActiveKeeperIntegration(pairing)
    return result.status
  },
  async pairingStatusInfo(pairing: KeeperPairing, expectedWithdrawalOperationId?: string) {
    const result = await getKeeperPairingStatusInfo(pairing, expectedWithdrawalOperationId)
    if (result.status === "active" && !result.withdrawal) await rememberActiveKeeperIntegration(pairing)
    return result
  },
  async withdrawalStatusAfterError(pairing: KeeperPairing, operationId: string) {
    try { return await getKeeperPairingStatusInfo(pairing, operationId) }
    catch { return null }
  },
  async keeperDetails(personId: string) {
    const profile = await bootstrapIdentity()
    const details = (await ownerKeepers(profile.identity.personId)).find(record => record.personId === personId)?.details
    const { integrations } = await keeperIntegrationReferences()
    const reference = selectKeeperReference(integrations, personId)
    if (!reference) return details ?? null
    let integrationSettingsSupported = reference.integrationSettingsSupported
    if (integrationSettingsSupported !== true) {
      try {
        const discovery = await discoverKeeper(reference.serviceOrigin)
        const status = await getKeeperIntegrationStatus(discovery)
        integrationSettingsSupported = status.integrationSettingsSupported
          && status.integrations.some(integration => integration.integrationId === reference.integrationId)
        await import("../sync/ownerKeeper").then(({ saveKeeperIntegrationReference }) =>
          saveKeeperIntegrationReference({ ...reference, integrationSettingsSupported }))
      } catch {
        // A saved integration remains viewable while its service is unavailable.
      }
    }
    const fromRoot: KeeperDetails = {
      origin: reference.serviceOrigin,
      boardIds: reference.workspaceIds,
      futureBoards: reference.futureBoards,
      futureBoardBaselineIds: reference.futureBoardBaselineIds,
      integrationId: reference.integrationId,
      servicePersonId: reference.servicePersonId,
      serviceDeviceId: reference.serviceDeviceId,
      servicePublicKey: reference.servicePublicKey,
      serviceCertificates: reference.serviceCertificates,
      revision: reference.revision,
      integrationSettingsSupported,
      removalPending: reference.state === "removing" || Boolean(reference.pendingRemoval),
    }
    return { ...details, ...fromRoot }
  },
  async pendingRemovalReferences() {
    const { integrations } = await keeperIntegrationReferences()
    const descriptors = Object.values(integrations).filter(reference =>
      reference.state === "removing" || Boolean(reference.pendingRemoval))
    const descriptorPeople = new Set(descriptors.map(reference => reference.servicePersonId))
    const profile = await bootstrapIdentity()
    const legacy = (await ownerKeepers(profile.identity.personId))
      .filter(record => record.details?.removalPending && !descriptorPeople.has(record.personId))
      .map(record => ({
        servicePersonId: record.personId,
        serviceDeviceId: record.details?.serviceDeviceId,
        serviceDeviceIds: record.details?.serviceDeviceIds ?? (record.details?.serviceDeviceId ? [record.details.serviceDeviceId] : []),
        verifiedAt: new Date().toISOString(),
      }))
    return [...descriptors, ...legacy]
  },
  async activeIntegrationReferences() {
    const { integrations } = await keeperIntegrationReferences()
    return Object.values(integrations).filter(reference => reference.state === "active" && !reference.pendingRemoval)
  },
}
