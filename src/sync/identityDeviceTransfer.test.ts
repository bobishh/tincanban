import { beforeEach, expect, it } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, toBase64Url } from "../domain/identity"
import { createPersonalRoot, registerWorkspaceInRoot } from "../domain/personalRoot"
import { certHashDefault, createDelegatedCertificate } from "../domain/proofs"
import { encodeIdentityDeviceState } from "./identityDeviceStateCodec"
import { recordReplicaPreference } from "./identityDevicePreferences"
import { RustyManagementRepository } from "./rustyManagementRepository"
import { createIdentityDeviceTransfer, readIdentityDeviceTransfer } from "./identityDeviceTransfer"
import type { BlindReplicaConfig } from "./blindReplication"

beforeEach(() => resetIdentityStorageForTest())

it("Given catalog, private connection and signed service policy, when building a portable manifest, then retain every required component without local progress", async () => {
  const owner = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  registerWorkspaceInRoot(root, "board", "board", "genesis")
  root.pendingKeeperWithdrawals = { withdrawal: { pairingId: "pairing", operationId: "operation", pairing: { publicEvidence: "retained" } } }
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const config: BlindReplicaConfig = { origin: "https://rusty.example", workspaceId: "board", scopeId: "scope-1",
    readToken: "A".repeat(43), writeToken: "B".repeat(43), contentKey: "A".repeat(43), servicePublicKey: toBase64Url(raw),
    keyEpoch: 1, policyRevision: 1, cursor: 17, lastUploaded: "A".repeat(43) }
  await recordReplicaPreference(owner.identity.personId, config)
  const serviceId = await sha256Base64Url(raw)
  const capability = await signEnvelope(service.privateKey, { kind: "rusty-scope-management-capability" as const, version: 1 as const,
    serviceId, origin: config.origin, personId: owner.identity.personId, resourceKind: "scope" as const, resourceId: config.scopeId,
    revision: 1, operations: ["management.update", "scope.policy"], revokedDeviceIds: [], requestId: "request",
    authorizationHash: "A".repeat(43), issuedAt: Date.now() }, serviceId, "RUSTY/2")
  await new RustyManagementRepository(owner.identity.personId).observe({ origin: config.origin, servicePublicKey: config.servicePublicKey,
    resourceKind: "scope", resourceId: config.scopeId }, capability)
  const manifest = await createIdentityDeviceTransfer(root, [owner.certificate])
  const parsed = await readIdentityDeviceTransfer(manifest, owner.identity.personId)
  expect(Object.keys(manifest.components)).toHaveLength(6)
  expect(parsed.personalRoot.pendingKeeperWithdrawals).toEqual(root.pendingKeeperWithdrawals)
  expect(parsed.capabilities[0].capability).toEqual(capability)
  expect(parsed.recoveryEvidence.envelopes).toEqual([])
  expect(parsed.replicas.entries[0].operations[0].config).toMatchObject({ cursor: 0, lastUploaded: "" })
})

it("Given complete catalog state mutated during an async source read, when export finishes, then retain the original snapshot", async () => {
  const owner = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  const pending = createIdentityDeviceTransfer(root, [owner.certificate])
  root.identity.displayName = "Mutated"
  const parsed = await readIdentityDeviceTransfer(await pending, owner.identity.personId)
  expect(parsed.personalRoot.identity.displayName).toBe("Owner")
})

it("Given identical multi-device certificate evidence in different orders with duplicate leaves, when exporting, then emit identical sorted evidence and validate full chains", async () => {
  const owner = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  resetIdentityStorageForTest()
  const second = await bootstrapIdentity("Second device")
  const delegated = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey!, owner.device.deviceId,
    owner.identity.personId, second.device.deviceId, second.device.publicKey, await certHashDefault(owner.certificate))

  const first = await createIdentityDeviceTransfer(root, [delegated, owner.certificate, delegated])
  const reordered = await createIdentityDeviceTransfer(root, [owner.certificate, delegated])
  const catalog = first.components.identityCatalog.value as { certificates: typeof owner.certificate[] }

  expect(catalog.certificates).toHaveLength(2)
  expect(catalog.certificates).toEqual(expect.arrayContaining([owner.certificate, delegated]))
  expect(encodeIdentityDeviceState(first)).toEqual(encodeIdentityDeviceState(reordered))
})

it("Given incomplete or malformed certificate evidence, when exporting, then fail closed instead of emitting an unverifiable catalog", async () => {
  const owner = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  resetIdentityStorageForTest()
  const second = await bootstrapIdentity("Second device")
  const delegated = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey!, owner.device.deviceId,
    owner.identity.personId, second.device.deviceId, second.device.publicKey, await certHashDefault(owner.certificate))

  await expect(createIdentityDeviceTransfer(root, [delegated])).rejects.toThrow(/ancestor|certificate/i)
  const malformed = structuredClone(owner.certificate)
  malformed.signature = "forged-signature"
  await expect(createIdentityDeviceTransfer(root, [malformed])).rejects.toThrow(/signature|certificate/i)
})

it("Given a malformed policy or omitted required component, when preflighting the manifest, then reject without installing any state", async () => {
  const owner = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  const manifest = await createIdentityDeviceTransfer(root, [owner.certificate])
  manifest.components.ownerCapabilities.value.capabilities = [{ binding: { origin: "https://rusty.example" }, capability: "forged" }]
  await expect(readIdentityDeviceTransfer(manifest, owner.identity.personId)).rejects.toThrow()
  delete manifest.components.ownerCapabilities
  await expect(readIdentityDeviceTransfer(manifest, owner.identity.personId)).rejects.toThrow(/required|component/i)
})

it("Given a mismatched root key or forged catalog certificate, when preflighting, then reject the entire private bundle", async () => {
  const owner = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  const manifest = await createIdentityDeviceTransfer(root, [owner.certificate])
  const forged = structuredClone(manifest)
  const catalog = forged.components.identityCatalog.value as { certificates: typeof owner.certificate[] }
  catalog.certificates[0].signature = "A".repeat(86)
  await expect(readIdentityDeviceTransfer(forged, owner.identity.personId)).rejects.toThrow(/certificate|signature/i)
  const mismatched = structuredClone(manifest)
  const identity = (mismatched.components.identityCatalog.value.personalRoot as typeof root).identity
  identity.publicKey = "A".repeat(43)
  await expect(readIdentityDeviceTransfer(mismatched, owner.identity.personId)).rejects.toThrow(/identity|key/i)
})
