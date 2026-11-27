import { discoverRustyService } from "@meta-uber/mesh-replication/rusty-management"
import { registerRustyResourcePrincipalGrant } from "@meta-uber/mesh-replication/rusty-principal-grant"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import type { StandingAutomationWorkspaceGrant } from "@meta-uber/mesh-workspace"
import type { LocalProfile } from "../domain/identity"
import { canonicalizeJson } from "../domain/identityCrypto"
import { signWithContext } from "../domain/signingContext"
import { ensureRustyIdentityAuthorityPublished, readRustyOwnerWorkspaceScopeAuthority } from "../sync/rustyIdentityTransport"
import { fetchBlind } from "../sync/rustyHttp"
import { workspaceOwnerSigningContext } from "../sync/workspaceOwnerSigning"
import type { BlindReplicaConfig } from "./blindReplication"
import type { AutomationWorkerIdentity } from "./automation"

export async function automationCredentialIssuer(config: BlindReplicaConfig) {
  const service = await discoverRustyService(config.origin, (url, init) => fetchBlind(String(url), init ?? {}))
  const credentials = service.capabilities.automationCredentials as { version?: unknown; scopeIdentityProof?: unknown } | undefined
  if (service.servicePublicKey !== config.servicePublicKey || credentials?.version !== 1 || credentials.scopeIdentityProof !== true) {
    throw new Error("This board’s Rusty connection does not support service access")
  }
  return service.serviceId
}

export async function readServiceScopeAuthority(profile: LocalProfile, config: BlindReplicaConfig,
  ensureCurrent: () => Promise<void>) {
  return (await readRustyOwnerWorkspaceScopeAuthority(profile, config, ensureCurrent)).snapshot
}

/** Register the exact signed workspace approval using the current owner device. */
export async function registerAutomationServiceAccess(profile: LocalProfile, config: BlindReplicaConfig,
  worker: AutomationWorkerIdentity, grant: StandingAutomationWorkspaceGrant, scopeSnapshot: unknown, ensureCurrent: () => Promise<void>) {
  await ensureCurrent()
  if (canonicalizeJson(await readServiceScopeAuthority(profile, config, ensureCurrent)) !== canonicalizeJson(scopeSnapshot)) {
    throw new Error("Rusty scope approval changed before activating service access")
  }
  const authorityView = await ensureRustyIdentityAuthorityPublished({ profile, access: config, ensureCurrent })
  const context = await workspaceOwnerSigningContext(profile, config.workspaceId, "rusty-resource-principal-grant", {
    origin: config.origin, scopeId: config.scopeId, resourceId: config.scopeId, ownerPersonId: profile.identity.personId,
    subjectPersonId: worker.personId, grantId: grant.payload.grantId, policyEpoch: grant.payload.accessEpoch,
  })
  await registerRustyResourcePrincipalGrant({
    origin: config.origin, servicePublicKey: config.servicePublicKey, storageScopeId: config.scopeId,
    workspaceId: config.workspaceId, expectedScopeAuthoritySnapshot: scopeSnapshot,
    identity: profile.identity, authorityView, deviceId: profile.device.deviceId, devicePublicKey: profile.device.publicKey,
    subjectIdentity: { personId: worker.personId, publicKey: worker.identityPublicKey, displayName: "" },
    workspaceGrant: grant, fetcher: (url, init) => fetchBlind(String(url), init ?? {}), ensureCurrent,
    validateSnapshot: snapshot => {
      const checked = meshRustRuntime().state.validateScopeAuthority(snapshot, Date.now()) as {
        scopeId: string; controller: { personId: string; publicKey: string }; controlEpoch: number
      }
      return { workspaceId: checked.scopeId, controllerPersonId: checked.controller.personId,
        controllerPublicKey: checked.controller.publicKey, controlEpoch: checked.controlEpoch, snapshot }
    },
    signAuthorization: payload => signWithContext(context, payload),
  })
}
