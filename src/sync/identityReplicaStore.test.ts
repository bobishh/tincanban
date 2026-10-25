import { expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createIdentityReplica } from "./identityReplicaStore"
import { readIdentityDeviceTransfer } from "./identityDeviceTransfer"
import { projectIdentityReplicaCatalogOnly } from "./identityReplicaStore"

vi.mock("./identityDeviceTransfer", () => ({ readIdentityDeviceTransfer: vi.fn(), applyIdentityDeviceTransfer: vi.fn() }))
vi.mock("./blindReplicaConfig", () => ({ parsePrivateReplicaConfig: vi.fn(value => JSON.parse(value)) }))
vi.mock("./privateReplicaRepository", () => ({ privateReplicaBinding: vi.fn(() => "identity-binding"),
  getPrivateReplicaProgress: vi.fn(async () => ({})), persistPrivateReplicaState: vi.fn(),
  getIdentityReplicaConfigurations: vi.fn(async () => []) }))
vi.mock("./identityReplica", () => ({ IdentityReplica: class {
  async push() { return true }
  async sync() { return true }
  async pull() { return true }
} }))
vi.mock("./rustyIdentityTransport", () => ({ createRustyIdentityProfileScopeFetcher: vi.fn(() => ({})) }))
vi.mock("./rustyManagementRepository", () => ({ RustyManagementRepository: class {
  async read(binding: { resourceKind: string }) { return binding.resourceKind === "scope" ? { capability: {} } : null }
} }))
vi.mock("./rustyManagementClient", () => ({ readRustyManagementStatus: vi.fn(async () => ({ migrationPending: false, capability: {} })) }))
vi.mock("./rustyManagementCapability", () => ({ verifyRustyManagementEvidence: vi.fn(async () => ({ revision: 1, revokedDeviceIds: [] })) }))
vi.mock("./blindClient", () => ({ discoverBlindKeeper: vi.fn(async (origin: string) => ({ origin, servicePublicKey: "service-key",
  personManagement: 1 })), inventoryBlindObjects: vi.fn(), downloadBlindObject: vi.fn(), uploadBlindObject: vi.fn() }))

it("Given the caller's current profile, when an Identity replica push publishes its access, then pass the tracked profile rather than its signing snapshot", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Publisher")
  const config = { purpose: "identity" as const, personId: profile.identity.personId, origin: "https://rusty.example",
    servicePublicKey: "service-key", scopeId: "scope", keyEpoch: 1, contentKey: "content", readToken: "read",
    writeToken: "write", policyRevision: 1, cursor: 0, lastUploaded: "" }
  await expect(createIdentityReplica(config, profile, () => {}).push()).resolves.toBe(true)
  resetIdentityStorageForTest()
})

it("Given an authenticated Identity device manifest, when projecting ordinary catalog sync, then omit only recovery evidence and revalidate", async () => {
  const manifest = { components: { recoveryEvidence: { schema: "identity-recovery-evidence@1", required: true,
    value: { personId: "person-1", envelopes: [{ ciphertext: "private-recovery-envelope" }] } },
    identityCatalog: { value: { identity: "kept" } }, identityAuthority: { value: { authorityView: "kept" } } } }
  const transfer = { manifest } as never
  vi.mocked(readIdentityDeviceTransfer).mockResolvedValue({ manifest: {} } as never)
  await projectIdentityReplicaCatalogOnly(transfer, "person-1")
  const projected = vi.mocked(readIdentityDeviceTransfer).mock.calls[0]![0] as typeof manifest
  expect(projected.components.recoveryEvidence.value).toEqual({ personId: "person-1", envelopes: [] })
  expect(projected.components.identityCatalog.value).toEqual({ identity: "kept" })
  expect(projected.components.identityAuthority.value).toEqual({ authorityView: "kept" })
  expect(manifest.components.recoveryEvidence.value.envelopes).toHaveLength(1)
})
