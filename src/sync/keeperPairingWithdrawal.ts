import type { KeeperPairing } from "./keeperPairing"
import type { DurableMesh } from "./durableMesh"
import type { KeeperIntegrationStatus } from "./keeperIntegrationStatus"
import { clearPendingKeeperWithdrawalProofs, pendingKeeperWithdrawal, savePendingKeeperWithdrawal,
  savePendingKeeperWithdrawalProofs } from "./ownerKeeper"
import { getKeeperPairingStatusInfo } from "./keeperPairingWithdrawalApi"
import { completeKeeperPairingWithdrawal, requestKeeperPairingWithdrawal } from "./keeperPairingWithdrawalApi"

async function disconnectSelectedScopes(pairing: KeeperPairing, operationId: string,
  status: { integrations: KeeperIntegrationStatus[]; revision: number },
  issuedScopes: Array<{ workspaceId: string; grantEpoch?: number }>): Promise<boolean> {
  const pairingApi = await import("./keeperPairing")
  const integration = status.integrations.find(item => item.integrationId === pairing.integrationId)
  if (!integration) return true
  const pendingOperation = integration.pendingOperation
  if (pendingOperation && pendingOperation.operationId !== operationId) {
    throw new Error("Rusty has another board cleanup pending. Finish it before cancelling this request.")
  }
  const selectedIds = new Set(pairing.workspaces.map(workspace => workspace.id))
  const issuedEpochs = new Map(issuedScopes.filter(scope => scope.grantEpoch !== undefined)
    .map(scope => [scope.workspaceId, scope.grantEpoch!]))
  const scopes = pendingOperation?.scopes ?? integration.scopes
    .filter(scope => selectedIds.has(scope.workspaceId) && issuedEpochs.has(scope.workspaceId))
    .map(scope => ({ workspaceId: scope.workspaceId, expectedGrantEpoch: scope.grantEpoch }))
  if (scopes.some(scope => !selectedIds.has(scope.workspaceId))) {
    throw new Error("Rusty cleanup refers to a board outside this approved request.")
  }
  if (scopes.some(scope => issuedEpochs.get(scope.workspaceId) !== scope.expectedGrantEpoch)) {
    throw new Error("Rusty has a newer board grant than this pairing. Keep cancellation pending and retry from the current request.")
  }
  if (!scopes.length) return true
  const receipt = await pairingApi.disconnectKeeperIntegration(pairing.discovery, pairing.integrationId,
    pendingOperation?.expectedRevision ?? integration.revision, operationId, scopes, pendingOperation?.requestHash)
  return receipt.status === "removed"
}

function confirmedIssuedScopes(pairing: KeeperPairing,
  scopes: Array<{ workspaceId: string; status: "pending" | "active"; grantEpoch?: number }> | undefined) {
  if (!scopes || scopes.length !== pairing.workspaces.length) return undefined
  const selected = new Set(pairing.workspaces.map(workspace => workspace.id))
  if (scopes.some(scope => !selected.has(scope.workspaceId))) {
    throw new Error("Keeper provisioning status contains a board outside this approved request.")
  }
  if (scopes.some(scope => (scope.status === "active" || scope.status === "pending")
    && !Number.isSafeInteger(scope.grantEpoch))) return undefined
  return scopes.filter(scope => scope.grantEpoch !== undefined)
}

async function resolvePrunedPairing(pairing: KeeperPairing, operationId: string,
  ensureMesh: () => Promise<DurableMesh | undefined>, cause: unknown): Promise<"cancel_pending" | "orphan_resolved"> {
  const expectedPath = `/v1/pairings/${encodeURIComponent(pairing.pairingId)}/withdraw`
  const httpFailure = cause as { status?: unknown; url?: unknown }
  if (httpFailure?.status !== 404 || typeof httpFailure.url !== "string") throw cause
  const failedUrl = new URL(httpFailure.url)
  if (failedUrl.origin !== pairing.discovery.origin || failedUrl.pathname !== expectedPath) throw cause
  const saved = await pendingKeeperWithdrawal(pairing.pairingId, operationId)
  if (!saved) return "cancel_pending"
  const { resolveMissingKeeperPairing } = await import("./keeperOrphanResolution")
  return await resolveMissingKeeperPairing(pairing, saved, ensureMesh) ? "orphan_resolved" : "cancel_pending"
}

/** Withdraw a keeper request, revoke the exact approved scopes, and prove cleanup. */
export async function cancelKeeperPairing(pairing: KeeperPairing, operationId: string,
  ensureMesh: () => Promise<DurableMesh | undefined>): Promise<"cancel_pending" | "cancelled" | "orphan_resolved"> {
  const pairingApi = await import("./keeperPairing")
  const previous = await pendingKeeperWithdrawal(pairing.pairingId, operationId)
  let mesh: DurableMesh | undefined
  let grantScopes = previous?.grantScopes
  if (!previous) {
    // Persist cancellation intent before any mesh/proof work. If capture fails
    // or the page closes, reload can still retry this exact operation.
    await savePendingKeeperWithdrawal(pairing.pairingId, operationId,
      JSON.parse(JSON.stringify(pairing)) as Record<string, unknown>)
  }
  if (!grantScopes) {
    mesh = await ensureMesh()
    if (!mesh) throw new Error("Workspace mesh is unavailable; keeper cancellation remains pending.")
    grantScopes = await mesh.captureKeeperGrantScopeProofs(pairing.workspaces.map(workspace => workspace.id), pairing.discovery.personId)
    const saved = await savePendingKeeperWithdrawalProofs(pairing.pairingId, operationId, grantScopes)
    grantScopes = saved.grantScopes
  }
  let withdrawal
  try {
    withdrawal = await requestKeeperPairingWithdrawal(pairing, operationId, grantScopes)
  } catch (cause) {
    return await resolvePrunedPairing(pairing, operationId, ensureMesh, cause)
  }
  if (withdrawal.status === "cancelled") {
    await clearPendingKeeperWithdrawalProofs(pairing.pairingId, operationId)
    return "cancelled"
  }

  const pairingStatus = await getKeeperPairingStatusInfo(pairing, operationId)
  if (pairingStatus.status === "cancelled") {
    await clearPendingKeeperWithdrawalProofs(pairing.pairingId, operationId)
    return "cancelled"
  }
  const issuedScopes = confirmedIssuedScopes(pairing, pairingStatus.provisioningScopes)
  if (!issuedScopes) return "cancel_pending"
  // Missing generation means Rusty has not proved whether it issued a grant.
  // Keep cancellation pending; never revoke a same-person grant by workspace alone.
  if (issuedScopes.some(scope => (scope.grantEpoch ?? 0) < 1)) return "cancel_pending"

  mesh ??= await ensureMesh()
  if (!mesh) throw new Error("Workspace mesh is unavailable; keeper cancellation remains pending.")
  const workspaceIds = issuedScopes.map(scope => scope.workspaceId)
  for (const scope of issuedScopes) {
    await mesh.revokePerson(scope.workspaceId, pairing.discovery.personId, scope.grantEpoch)
  }

  const status = await pairingApi.getKeeperIntegrationStatus(pairing.discovery)
  if (!await disconnectSelectedScopes(pairing, operationId, status, issuedScopes)) return "cancel_pending"

  const scopes = await mesh.captureRevocationCompletionScopes(workspaceIds, pairing.discovery.personId)
  const completed = await completeKeeperPairingWithdrawal(pairing, operationId, scopes, withdrawal.requestHash)
  if (completed.status === "cancelled") await clearPendingKeeperWithdrawalProofs(pairing.pairingId, operationId)
  return completed.status
}
