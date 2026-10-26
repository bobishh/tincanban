import { afterEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { verifyRetainedDeviceAuthorizationApproval } from "@meta-uber/mesh-identity"
import { clearIdentityCatalogPublicationTestState, publishCurrentIdentityCatalogAccess,
  retainIdentityCatalogPublisherAuthorization } from "./identityCatalogPublisher"
import { getIdentityReplicaConfigurations } from "./privateReplicaRepository"
import { requireIdentityAuthorityView } from "./identityAuthorityStore"
import { readIdentityRustyServicePin } from "./identityRustyServiceCatalog"
import { captureIdentityCatalogAccess } from "./identityCatalogAccess"
import { publishRustyIdentityCatalogAccess } from "@meta-uber/mesh-replication"
import { readLocal } from "../localDb"
import { defaultStorage } from "../storage"

vi.mock("./identityAuthorityStore", () => ({ requireIdentityAuthorityView: vi.fn() }))
vi.mock("./identityRustyServiceCatalog", () => ({ readIdentityRustyServicePin: vi.fn() }))
vi.mock("./identityCatalogAccess", () => ({ captureIdentityCatalogAccess: vi.fn() }))
vi.mock("./privateReplicaRepository", () => ({ getIdentityReplicaConfigurations: vi.fn() }))
vi.mock("../domain/identityProfileRoot", () => ({ rootIdentityProfileState: vi.fn(async () => ({})) }))
vi.mock("../storage", () => ({ defaultStorage: { loadPersonalRoot: vi.fn() } }))
vi.mock("@meta-uber/mesh-replication", () => ({ publishRustyIdentityCatalogAccess: vi.fn() }))
vi.mock("@meta-uber/mesh-identity", async importOriginal => {
  const original = await importOriginal()
  return { ...(original as Record<string, unknown>),
    identityProfileRustyServicePins: vi.fn(() => [{ origin: "https://rusty.example", serviceId: "service-id", servicePublicKey: "service-key" }]),
    verifyRetainedDeviceAuthorizationApproval: vi.fn(async approval => approval),
  }
})

afterEach(() => { resetIdentityStorageForTest(); clearIdentityCatalogPublicationTestState(); vi.restoreAllMocks() })

it("Given retained v5 approval and a confirmed pushed catalog, when publication is requested twice concurrently, then one stable SDK publication uses current authority and pin", async () => {
  const profile = await bootstrapIdentity("Publisher")
  vi.stubGlobal("window", { location: { origin: "https://boards.example" } })
  vi.mocked(defaultStorage.loadPersonalRoot).mockResolvedValue({ identity: profile.identity } as never)
  const request = { payload: { version: 3, includeIdentityCatalogAccess: true, personId: null,
    deviceId: profile.device.deviceId, devicePublicKey: profile.device.publicKey } }
  const approval = { identity: profile.identity, certificate: profile.certificate,
    proof: { payload: { version: 5, request } } }
  vi.mocked(verifyRetainedDeviceAuthorizationApproval).mockResolvedValue(approval as never)
  const authority = { personId: profile.identity.personId, identityPublicKey: profile.identity.publicKey }
  const config = { purpose: "identity", personId: profile.identity.personId, origin: "https://rusty.example",
    servicePublicKey: "service-key", scopeId: "source-scope", keyEpoch: 1, contentKey: "content", readToken: "read",
    writeToken: "write", policyRevision: 1, cursor: 1, lastUploaded: "present" }
  const otherConfig = { ...config, origin: "https://other-rusty.example", servicePublicKey: "other-service-key",
    scopeId: "other-scope" }
  vi.mocked(requireIdentityAuthorityView).mockResolvedValue(authority as never)
  vi.mocked(readIdentityRustyServicePin).mockResolvedValue({ origin: config.origin, serviceId: "service-id",
    servicePublicKey: config.servicePublicKey })
  vi.mocked(captureIdentityCatalogAccess).mockResolvedValue(new Uint8Array([1, 2, 3]))
  vi.mocked(publishRustyIdentityCatalogAccess).mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
    return []
  })
  await retainIdentityCatalogPublisherAuthorization(profile, approval as never)
  const configs = vi.mocked(getIdentityReplicaConfigurations)
  configs.mockResolvedValue([config as never, otherConfig as never])
  const [left, right] = await Promise.all([publishCurrentIdentityCatalogAccess(profile, config as never),
    publishCurrentIdentityCatalogAccess(profile, config as never)])
  expect(left).toEqual([])
  expect(right).toEqual([])
  expect(publishRustyIdentityCatalogAccess).toHaveBeenCalledTimes(1)
  const options = vi.mocked(publishRustyIdentityCatalogAccess).mock.calls[0]![0]
  expect(options.currentAuthorityView).toBe(authority)
  expect(options.retainedAuthorization).toEqual(approval)
  expect(options.access).toEqual(new Uint8Array([1, 2, 3]))
  expect(options.origin).toBe(config.origin)
  expect(captureIdentityCatalogAccess).toHaveBeenCalledTimes(1)
  expect(options.catalogId).not.toBe(config.scopeId)
  expect(options.catalogId).toMatch(/^tincanban-catalog-[A-Za-z0-9_-]+$/u)
  const journalKey = `adapter-proof-${crypto.randomUUID()}`
  const entry = { version: 1, sourceRevision: 1, contentHash: "content-hash", state: "published" as const,
    receipt: {} as never }
  expect(await options.journal.read(journalKey)).toBeNull()
  expect(await options.journal.compareAndSet(journalKey, null, entry)).toBe(true)
  expect(await options.journal.read(journalKey)).toEqual(entry)
  expect(await options.journal.compareAndSet(journalKey, null, entry)).toBe(false)
  expect(await readLocal(`tincanban.identity-catalog-publisher-authorization.v1.${profile.identity.personId}.${profile.device.deviceId}`)).toContain('"version":1')
})

it("Given no retained fresh approval, when a source upload completes, then skip access publication", async () => {
  const profile = await bootstrapIdentity("Publisher")
  await expect(publishCurrentIdentityCatalogAccess(profile, { purpose: "identity", personId: profile.identity.personId,
    origin: "https://rusty.example", servicePublicKey: "service-key", scopeId: "scope", keyEpoch: 1,
    contentKey: "content", readToken: "read", writeToken: "write", policyRevision: 1, cursor: 0,
    lastUploaded: "" })).resolves.toEqual([])
  expect(captureIdentityCatalogAccess).not.toHaveBeenCalled()
  expect(publishRustyIdentityCatalogAccess).not.toHaveBeenCalled()
})

it("Given an explicitly foreign requested person, when retaining publisher authorization, then reject it", async () => {
  const profile = await bootstrapIdentity("Publisher")
  const request = { payload: { version: 3, includeIdentityCatalogAccess: true, personId: "another-person",
    deviceId: profile.device.deviceId, devicePublicKey: profile.device.publicKey } }
  const approval = { proof: { payload: { version: 5, request } } }
  await expect(retainIdentityCatalogPublisherAuthorization(profile, approval as never)).rejects.toThrow(/approval/i)
  expect(verifyRetainedDeviceAuthorizationApproval).not.toHaveBeenCalled()
})

it("Given unconfirmed source scope authority, when upload publication is prepared, then stop before SDK transport", async () => {
  const profile = await bootstrapIdentity("Publisher")
  vi.stubGlobal("window", { location: { origin: "https://boards.example" } })
  vi.mocked(defaultStorage.loadPersonalRoot).mockResolvedValue({ identity: profile.identity } as never)
  const request = { payload: { version: 3, includeIdentityCatalogAccess: true, personId: null,
    deviceId: profile.device.deviceId, devicePublicKey: profile.device.publicKey } }
  const approval = { identity: profile.identity, certificate: profile.certificate,
    proof: { payload: { version: 5, request } } }
  vi.mocked(verifyRetainedDeviceAuthorizationApproval).mockResolvedValue(approval as never)
  vi.mocked(requireIdentityAuthorityView).mockResolvedValue({ personId: profile.identity.personId,
    identityPublicKey: profile.identity.publicKey } as never)
  vi.mocked(readIdentityRustyServicePin).mockResolvedValue({ origin: "https://rusty.example", serviceId: "service-id",
    servicePublicKey: "service-key" })
  const config = { purpose: "identity" as const, personId: profile.identity.personId,
    origin: "https://rusty.example", servicePublicKey: "service-key", scopeId: "scope", keyEpoch: 1,
    contentKey: "content", readToken: "read", writeToken: "write", policyRevision: 1, cursor: 1,
    lastUploaded: "uploaded" }
  vi.mocked(getIdentityReplicaConfigurations).mockResolvedValue([config as never])
  vi.mocked(captureIdentityCatalogAccess).mockRejectedValue(new Error("Catalog authority is not confirmed"))
  await retainIdentityCatalogPublisherAuthorization(profile, approval as never)
  await expect(publishCurrentIdentityCatalogAccess(profile, config)).rejects.toThrow(/confirmed/u)
  expect(publishRustyIdentityCatalogAccess).not.toHaveBeenCalled()
})
