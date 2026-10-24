import { beforeEach, expect, it } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, toBase64Url } from "../domain/identity"
import { createPersonalRoot, registerDeviceInRoot, registerWorkspaceInRoot } from "../domain/personalRoot"
import { certHashDefault, createDelegatedCertificate } from "../domain/proofs"
import { encodeIdentityDeviceState } from "./identityDeviceStateCodec"
import { recordReplicaPreference } from "./identityDevicePreferences"
import { RustyManagementRepository } from "./rustyManagementRepository"
import { createIdentityDeviceTransfer, readIdentityDeviceTransfer } from "./identityDeviceTransfer"
import type { BlindReplicaConfig } from "./blindReplication"
import { createIdentityAuthorityView } from "@meta-uber/mesh-identity"
import { rootIdentityProfileState } from "../domain/identityProfileRoot"
import { mergeIdentityAuthorityView } from "./identityAuthorityStore"
import { projectRedundantDeviceCertificates } from "./identityDeviceTransferCertificateProjection"

beforeEach(() => resetIdentityStorageForTest())

async function exportTransfer(root: ReturnType<typeof createPersonalRoot>, certificates: Parameters<typeof createIdentityDeviceTransfer>[1]) {
  root = structuredClone(root)
  const projected = await projectRedundantDeviceCertificates(root, certificates)
  root = projected.root
  const state = await rootIdentityProfileState(root)
  const view = await createIdentityAuthorityView(root.identity, { certificates: projected.certificates, revocations: [] }, state)
  await mergeIdentityAuthorityView(view)
  return createIdentityDeviceTransfer(root, certificates)
}

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
  const manifest = await exportTransfer(root, [owner.certificate])
  const parsed = await readIdentityDeviceTransfer(manifest, owner.identity.personId)
  expect(Object.keys(manifest.components)).toHaveLength(7)
  expect(parsed.personalRoot.pendingKeeperWithdrawals).toEqual(root.pendingKeeperWithdrawals)
  expect(parsed.capabilities[0].capability).toEqual(capability)
  expect(parsed.recoveryEvidence.envelopes).toEqual([])
  expect(parsed.replicas.entries[0].operations[0].config).toMatchObject({ cursor: 0, lastUploaded: "" })
})

it("Given complete catalog state mutated during an async source read, when export finishes, then retain the original snapshot", async () => {
  const owner = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  const pending = exportTransfer(root, [owner.certificate])
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

  const first = await exportTransfer(root, [delegated, owner.certificate, delegated])
  const reordered = await exportTransfer(root, [owner.certificate, delegated])
  const catalog = first.components.identityCatalog.value as { certificates: typeof owner.certificate[] }

  expect(catalog.certificates).toHaveLength(2)
  expect(catalog.certificates).toEqual(expect.arrayContaining([owner.certificate, delegated]))
  expect(encodeIdentityDeviceState(first)).toEqual(encodeIdentityDeviceState(reordered))
})

it("projects only a fully signed same-key repeated-device leaf to its verified ancestor", async () => {
  const owner = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  resetIdentityStorageForTest()
  const phone = await bootstrapIdentity("Phone")
  const oldPhoneCertificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey!, owner.device.deviceId,
    owner.identity.personId, phone.device.deviceId, phone.device.publicKey, await certHashDefault(owner.certificate))
  const reissuedPhoneCertificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey!, owner.device.deviceId,
    owner.identity.personId, phone.device.deviceId, phone.device.publicKey, await certHashDefault(owner.certificate))

  await expect(exportTransfer(root, [owner.certificate, oldPhoneCertificate, reissuedPhoneCertificate])).resolves.toBeDefined()

  const selfIssuedCertificate = await createDelegatedCertificate(phone.privateKeys.devicePrivateKey!, phone.device.deviceId,
    owner.identity.personId, phone.device.deviceId, phone.device.publicKey, await certHashDefault(oldPhoneCertificate))
  const input = [owner.certificate, oldPhoneCertificate, selfIssuedCertificate]
  const before = structuredClone(input)
  registerDeviceInRoot(root, { deviceId: phone.device.deviceId, publicKey: phone.device.publicKey, displayName: "Phone",
    certificateHash: await certHashDefault(selfIssuedCertificate), addedAt: new Date().toISOString() })

  const exported = await exportTransfer(root, input)
  const catalog = exported.components.identityCatalog.value as {
    personalRoot: { devices: Record<string, { certificateHash: string }> }
    certificates: Array<{ signature: string }>
  }
  expect(catalog.certificates.map(certificate => certificate.signature)).not.toContain(selfIssuedCertificate.signature)
  expect(catalog.certificates.map(certificate => certificate.signature)).toContain(oldPhoneCertificate.signature)
  expect(catalog.personalRoot.devices[phone.device.deviceId]?.certificateHash).toBe(await certHashDefault(oldPhoneCertificate))
  expect(input).toEqual(before)
  await expect(readIdentityDeviceTransfer(exported, owner.identity.personId)).resolves.toBeDefined()

  const changedCapabilityCertificate = await signEnvelope(phone.privateKeys.devicePrivateKey!,
    { ...selfIssuedCertificate.payload, canEnrollDevices: false }, phone.device.deviceId)
  const changedCapabilityRoot = structuredClone(root)
  registerDeviceInRoot(changedCapabilityRoot, { deviceId: phone.device.deviceId, publicKey: phone.device.publicKey,
    displayName: "Phone", certificateHash: await certHashDefault(changedCapabilityCertificate), addedAt: new Date().toISOString() })
  await expect(exportTransfer(changedCapabilityRoot,
    [owner.certificate, oldPhoneCertificate, changedCapabilityCertificate])).rejects.toThrow(/registered device|redundant/i)

  const invalid = structuredClone(exported)
  const invalidCatalog = invalid.components.identityCatalog.value as typeof catalog
  invalidCatalog.certificates.push(selfIssuedCertificate)
  await expect(readIdentityDeviceTransfer(invalid, owner.identity.personId)).rejects.toThrow(/certificate/)
})

it("Given incomplete or malformed certificate evidence, when exporting, then fail closed instead of emitting an unverifiable catalog", async () => {
  const owner = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  resetIdentityStorageForTest()
  const second = await bootstrapIdentity("Second device")
  const delegated = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey!, owner.device.deviceId,
    owner.identity.personId, second.device.deviceId, second.device.publicKey, await certHashDefault(owner.certificate))

  await expect(exportTransfer(root, [delegated])).rejects.toThrow(/ancestor|certificate/i)
  const malformed = structuredClone(owner.certificate)
  malformed.signature = "forged-signature"
  await expect(exportTransfer(root, [malformed])).rejects.toThrow(/signature|certificate/i)
})

it("Given a malformed policy or omitted required component, when preflighting the manifest, then reject without installing any state", async () => {
  const owner = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  const manifest = await exportTransfer(root, [owner.certificate])
  manifest.components.ownerCapabilities.value.capabilities = [{ binding: { origin: "https://rusty.example" }, capability: "forged" }]
  await expect(readIdentityDeviceTransfer(manifest, owner.identity.personId)).rejects.toThrow()
  delete manifest.components.ownerCapabilities
  await expect(readIdentityDeviceTransfer(manifest, owner.identity.personId)).rejects.toThrow(/required|component/i)
})

it("Given a mismatched root key or forged catalog certificate, when preflighting, then reject the entire private bundle", async () => {
  const owner = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  const manifest = await exportTransfer(root, [owner.certificate])
  const forged = structuredClone(manifest)
  const catalog = forged.components.identityCatalog.value as { certificates: typeof owner.certificate[] }
  catalog.certificates[0].signature = "A".repeat(86)
  await expect(readIdentityDeviceTransfer(forged, owner.identity.personId)).rejects.toThrow(/certificate|signature/i)
  const mismatched = structuredClone(manifest)
  const identity = (mismatched.components.identityCatalog.value.personalRoot as typeof root).identity
  identity.publicKey = "A".repeat(43)
  await expect(readIdentityDeviceTransfer(mismatched, owner.identity.personId)).rejects.toThrow(/identity|key/i)
})

it("Given a released catalog containing enrollment request metadata, when exporting, then project only the certified device fields and retain the durable original", async () => {
  const owner = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  const device = root.devices[owner.device.deviceId]!
  Object.assign(device, { kind: "device-enrollment-request", version: 2, invitationId: "previous-enrollment" })
  const original = JSON.stringify(root)
  const parsed = await readIdentityDeviceTransfer(await exportTransfer(root, [owner.certificate]), owner.identity.personId)
  expect(parsed.personalRoot.devices[owner.device.deviceId]).toEqual({ deviceId: device.deviceId, publicKey: device.publicKey,
    displayName: device.displayName, certificateHash: device.certificateHash, addedAt: device.addedAt })
  expect(JSON.stringify(root)).toBe(original)
})

it.each(["certificateHash", "publicKey", "deviceId"] as const)("Given legacy enrollment metadata with mismatched %s, when exporting, then reject instead of laundering device evidence", async field => {
  const owner = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  const device = root.devices[owner.device.deviceId]!
  Object.assign(device, { kind: "device-enrollment-request", version: 2, invitationId: "previous-enrollment", [field]: "A".repeat(43) })
  await expect(exportTransfer(root, [owner.certificate])).rejects.toThrow(/certificate|device/i)
})

it("Given unknown legacy catalog fields, when exporting, then reject without silently stripping them", async () => {
  const owner = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  Object.assign(root.devices[owner.device.deviceId]!, { kind: "device-enrollment-request", version: 2,
    invitationId: "previous-enrollment", revoked: true })
  await expect(exportTransfer(root, [owner.certificate])).rejects.toThrow()
})
