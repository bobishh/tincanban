import { afterEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, toBase64Url } from "../domain/identity"
import * as local from "../localDb"
import { exportPrivateReplicaState, receivePrivateReplicaState, getPrivateReplicaProgress, getIdentityReplicaConfigurations, privateReplicaStateStorageKey, setReplicaPreference } from "./privateReplicaRepository"
import { RustyManagementRepository, type ManagementBinding, type PortableManagementRecord } from "./rustyManagementRepository"
import type { IdentityReplicaConfig } from "./blindReplication"
import type { RustyManagementCapability } from "./rustyManagementCapability"
import { captureIdentityCatalogAccess, installIdentityCatalogAccess, readIdentityCatalogAccess } from "./identityCatalogAccess"

afterEach(() => { resetIdentityStorageForTest(); vi.restoreAllMocks() })

async function fixture() {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Catalog owner")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const serviceId = await sha256Base64Url(publicKey)
  const config: IdentityReplicaConfig = { purpose: "identity", personId: profile.identity.personId,
    origin: "https://rusty.example", servicePublicKey: toBase64Url(publicKey), scopeId: "identity-catalog",
    keyEpoch: 1, contentKey: "A".repeat(43), readToken: "B".repeat(43), writeToken: "C".repeat(43),
    policyRevision: 1, cursor: 37, lastUploaded: "D".repeat(43) }
  const binding = { origin: config.origin, servicePublicKey: config.servicePublicKey, catalogId: config.scopeId }
  const repository = new RustyManagementRepository(profile.identity.personId)
  const capabilities: PortableManagementRecord[] = []
  for (const resourceKind of ["person", "scope"] as const) {
    const target: ManagementBinding = { origin: config.origin, servicePublicKey: config.servicePublicKey,
      resourceKind, resourceId: resourceKind === "person" ? profile.identity.personId : config.scopeId }
    const payload: RustyManagementCapability = {
      kind: resourceKind === "person" ? "rusty-person-management-capability" : "rusty-scope-management-capability",
      version: 1, serviceId, origin: config.origin, personId: profile.identity.personId, resourceKind,
      resourceId: target.resourceId, revision: 1,
      operations: resourceKind === "person" ? ["management.update", "resource.create"] : ["management.update", "scope.policy"],
      revokedDeviceIds: [], requestId: `catalog-${resourceKind}`, authorizationHash: "E".repeat(43), issuedAt: Date.now(),
    }
    const capability = await signEnvelope(service.privateKey, payload, serviceId, "RUSTY/2")
    await repository.observe(target, capability)
    capabilities.push({ binding: target, capability })
  }
  await setReplicaPreference(profile.identity.personId, config)
  return { profile, config, binding, repository, capabilities }
}

it("Given an owned private catalog, when preparing its access, then include only its portable credentials and confirmed authority", async () => {
  const f = await fixture()
  const bytes = await captureIdentityCatalogAccess(f.profile, f.config)
  const access = await readIdentityCatalogAccess(bytes, f.profile, f.binding)
  expect(access.catalog).toMatchObject({ scopeId: f.config.scopeId, cursor: 0, lastUploaded: "" })
  expect(access.catalog).not.toHaveProperty("preferenceRevision")
  expect(access.capabilities).toHaveLength(2)
  expect(Object.keys(access).sort()).toEqual(["capabilities", "catalog", "connectionState", "kind", "personId", "version"])
})

it("Given a fresh local catalog store, when verified access is installed twice, then atomically retain one connection and both policies", async () => {
  const f = await fixture()
  const bytes = await captureIdentityCatalogAccess(f.profile, f.config)
  await local.deleteLocal(privateReplicaStateStorageKey(f.profile.identity.personId))
  await local.deleteLocal(`tincanban.rusty-management.v1.${f.profile.identity.personId}`)
  const commit = vi.spyOn(local, "compareAndSwapLocal")
  await installIdentityCatalogAccess(bytes, f.profile, f.binding, () => {})
  const preferences = await local.readLocal(privateReplicaStateStorageKey(f.profile.identity.personId))
  await installIdentityCatalogAccess(bytes, f.profile, f.binding, () => {})
  expect(await local.readLocal(privateReplicaStateStorageKey(f.profile.identity.personId))).toBe(preferences)
  expect(await getIdentityReplicaConfigurations(f.profile.identity.personId)).toHaveLength(1)
  expect(await f.repository.export()).toHaveLength(2)
  expect(commit.mock.calls.some(([plan]) => plan.writes.some(write => write.key === privateReplicaStateStorageKey(f.profile.identity.personId)) &&
    plan.writes.some(write => write.key === `tincanban.rusty-management.v1.${f.profile.identity.personId}`))).toBe(true)
})

it("Given a person or service mismatch, when catalog access is checked, then reject it before changing local state", async () => {
  const f = await fixture()
  const bytes = await captureIdentityCatalogAccess(f.profile, f.config)
  const before = await local.readLocal(privateReplicaStateStorageKey(f.profile.identity.personId))
  await expect(installIdentityCatalogAccess(bytes, f.profile, { ...f.binding, origin: "https://another-rusty.example" }, () => {})).rejects.toThrow()
  await expect(readIdentityCatalogAccess(bytes, { ...f.profile, identity: { ...f.profile.identity, personId: "another-person" } }, f.binding)).rejects.toThrow()
  expect(await local.readLocal(privateReplicaStateStorageKey(f.profile.identity.personId))).toBe(before)
})

it("Given private keys, local progress, or a workspace config hidden in catalog access, when decoded, then reject the payload", async () => {
  const f = await fixture()
  const bytes = await captureIdentityCatalogAccess(f.profile, f.config)
  for (const mutate of [
    (value: Record<string, unknown>) => { value.recoveryEvidence = {} },
    (value: Record<string, unknown>) => { (value.catalog as Record<string, unknown>).devicePrivateKey = "forbidden" },
    (value: Record<string, unknown>) => { (value.catalog as Record<string, unknown>).cursor = 1 },
    (value: Record<string, unknown>) => { (value.catalog as Record<string, unknown>).purpose = "workspace" },
  ]) {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
    mutate(value)
    await expect(readIdentityCatalogAccess(new TextEncoder().encode(JSON.stringify(value)), f.profile, f.binding)).rejects.toThrow()
  }
})

it("Given locally retained credentials differ, when catalog access returns, then preserve the existing connection", async () => {
  const f = await fixture()
  const bytes = await captureIdentityCatalogAccess(f.profile, f.config)
  await setReplicaPreference(f.profile.identity.personId, { ...f.config, readToken: "E".repeat(43) })
  await expect(installIdentityCatalogAccess(bytes, f.profile, f.binding, () => {})).rejects.toThrow(/credentials/i)
  expect((await getIdentityReplicaConfigurations(f.profile.identity.personId))[0]?.readToken).toBe("E".repeat(43))
})

it("Given this catalog was explicitly removed, when an older bootstrap returns, then do not reconnect it", async () => {
  const f = await fixture()
  const bytes = await captureIdentityCatalogAccess(f.profile, f.config)
  await setReplicaPreference(f.profile.identity.personId, f.config, true)
  await expect(installIdentityCatalogAccess(bytes, f.profile, f.binding, () => {})).rejects.toThrow(/removed|conflict/i)
  expect(await getIdentityReplicaConfigurations(f.profile.identity.personId)).toHaveLength(0)
})

it("Given an atomic local write loses a race, when catalog access retries, then install credentials and authority together", async () => {
  const f = await fixture()
  const bytes = await captureIdentityCatalogAccess(f.profile, f.config)
  await local.deleteLocal(privateReplicaStateStorageKey(f.profile.identity.personId))
  await local.deleteLocal(`tincanban.rusty-management.v1.${f.profile.identity.personId}`)
  const commit = vi.spyOn(local, "compareAndSwapLocal").mockResolvedValueOnce(false)
  await installIdentityCatalogAccess(bytes, f.profile, f.binding, () => {})
  expect(commit.mock.calls.length).toBeGreaterThanOrEqual(2)
  expect(await getIdentityReplicaConfigurations(f.profile.identity.personId)).toHaveLength(1)
  expect(await f.repository.export()).toHaveLength(2)
})

it("Given distinct publishers advertise the same catalog, when reading authenticated deliveries, then bind credentials to their physical scope without equating delivery IDs", async () => {
  const f = await fixture()
  const bytes = await captureIdentityCatalogAccess(f.profile, f.config)
  for (const catalogId of ["desktop-delivery", "phone-delivery"]) {
    const access = await readIdentityCatalogAccess(bytes, f.profile, { ...f.binding, catalogId })
    expect(access.catalog.scopeId).toBe(f.config.scopeId)
  }
})

it("Given bootstrap access and its original catalog preferences, when the first catalog pull merges them, then the active replica binding stays valid", async () => {
  const f = await fixture()
  const bytes = await captureIdentityCatalogAccess(f.profile, f.config)
  const source = await exportPrivateReplicaState(f.profile.identity.personId)
  await local.deleteLocal(privateReplicaStateStorageKey(f.profile.identity.personId))
  await local.deleteLocal(`tincanban.rusty-management.v1.${f.profile.identity.personId}`)
  await installIdentityCatalogAccess(bytes, f.profile, f.binding, () => {})
  const installed = (await getIdentityReplicaConfigurations(f.profile.identity.personId))[0]!
  await receivePrivateReplicaState(f.profile.identity.personId, source)
  await expect(getPrivateReplicaProgress(f.profile.identity.personId, installed)).resolves.toBeDefined()
  expect((await getIdentityReplicaConfigurations(f.profile.identity.personId))[0]?.preferenceRevision).toBe(installed.preferenceRevision)
})
