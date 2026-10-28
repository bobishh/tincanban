import type * as IdentityModule from "../domain/identity"
import type * as MeshIdentityModule from "@meta-uber/mesh-identity"
import { afterEach, expect, it, vi } from "vitest"

const events = vi.hoisted(() => ({ order: [] as string[] }))

vi.mock("./blindClient", () => ({ discoverBlindKeeper: vi.fn(async () => ({
  origin: "https://rusty.example", servicePublicKey: "service-key", serviceId: "service-key-id", personManagement: 1,
})) }))
vi.mock("./privateReplicaRepository", () => ({ getReplicaConfigurations: vi.fn(async () => []) }))
vi.mock("./localWorkspaceOwnerRegistration", () => ({ registerLocalWorkspaceOwners: vi.fn(async () => { events.order.push("previous-owner-authority") }) }))
vi.mock("./rustyEnrollment", () => ({ approveRustyScope: vi.fn() }))
vi.mock("./identityDevicePreferences", () => ({ recordReplicaPreference: vi.fn() }))
vi.mock("./rustyManagementClient", () => ({ ensureRustyPersonPolicy: vi.fn(async () => { events.order.push("person-policy-status") }) }))
vi.mock("./workspaceReplicaConnection", () => ({ ensureWorkspaceReplicaConnection: vi.fn(async (_service, _workspaceId, _profile, _guard, options) => {
  events.order.push("workspace-setup")
  await options?.beforeSetup?.()
  return { workspaceId: _workspaceId, origin: _service.origin }
}) }))
vi.mock("./replicaCredentialFreeze", () => ({ assertReplicaCredentialsUnfrozen: vi.fn() }))
vi.mock("./identityAuthorityStore", () => ({ requireIdentityAuthorityView: vi.fn(async () => ({ personId: "person-1" })) }))
vi.mock("./identityRustyServiceCatalog", () => ({ readIdentityRustyServicePin: vi.fn(async () => ({
  origin: "https://rusty.example", servicePublicKey: "service-key", serviceId: "service-key-id",
})) }))
vi.mock("../storage", () => ({ defaultStorage: { loadPersonalRoot: vi.fn(async () => ({ identity: { personId: "person-1" } })) } }))
vi.mock("../domain/identityProfileRoot", () => ({ rootIdentityProfileState: vi.fn(async () => ({ signed: true })) }))
vi.mock("@meta-uber/mesh-identity", async importOriginal => ({ ...await importOriginal<typeof MeshIdentityModule>(), identityProfileRustyServicePins: vi.fn(() => [{
  origin: "https://rusty.example", servicePublicKey: "service-key", serviceId: "service-key-id",
}]) }))
vi.mock("../domain/identity", async importOriginal => ({ ...await importOriginal<typeof IdentityModule>(), publicKeyId: vi.fn(async () => "service-key-id") }))
vi.mock("./identityReplicaConnection", () => ({ ensureIdentityReplicaConnection: vi.fn(async () => {
  events.order.push("identity-authority-ready")
}) }))

vi.mock("./historyBaselineStartup", () => ({ retainHistoryForReplicaDisconnect: vi.fn(async () => { events.order.push("retain-history-key") }) }))
import { connectWorkspaceReplica, revokeWorkspaceReplicaConnection } from "./replicaConnections"
import { retainHistoryForReplicaDisconnect } from "./historyBaselineStartup"
import { approveRustyScope } from "./rustyEnrollment"
import { recordReplicaPreference } from "./identityDevicePreferences"
import type { BlindReplicaConfig } from "./blindReplication"

afterEach(() => { events.order.length = 0; vi.clearAllMocks() })

it("publishes Identity authority before Add Rusty reads protected person status", async () => {
  const profile = { identity: { personId: "person-1" }, device: { deviceId: "device-1" } }
  const app = {
    getCurrentProfile: () => profile,
    getWorkspaceRole: async () => "owner",
  }

  await connectWorkspaceReplica(app as never, "https://rusty.example", "workspace-1", () => {})

  expect(events.order).toEqual(["identity-authority-ready", "workspace-setup", "person-policy-status", "previous-owner-authority"])
})

it("uses current signed workspace ownership after ownership transfer", async () => {
  const profile = { identity: { personId: "successor-person" }, device: { deviceId: "successor-device" } }
  const app = {
    getCurrentProfile: () => profile,
    getWorkspaceRole: vi.fn(async () => "owner"),
    readWorkspaceDoc: vi.fn(async () => ({ ownerPersonId: "former-owner" })),
  }

  await connectWorkspaceReplica(app as never, "https://rusty.example", "transferred-workspace", () => {})

  expect(app.getWorkspaceRole).toHaveBeenCalledWith("transferred-workspace")
  expect(app.readWorkspaceDoc).not.toHaveBeenCalled()
  expect(events.order).toContain("workspace-setup")
})

it("does not let the original genesis owner configure Rusty after ownership transfer", async () => {
  const profile = { identity: { personId: "former-owner" }, device: { deviceId: "former-device" } }
  const app = {
    getCurrentProfile: () => profile,
    getWorkspaceRole: vi.fn(async () => "editor"),
    readWorkspaceDoc: vi.fn(async () => ({ ownerPersonId: "former-owner" })),
  }

  await expect(connectWorkspaceReplica(app as never, "https://rusty.example", "transferred-workspace", () => {}))
    .rejects.toThrow(/Only the workspace owner/u)

  expect(app.getWorkspaceRole).toHaveBeenCalledWith("transferred-workspace")
  expect(events.order).toEqual([])
})

const disconnectConfig = { workspaceId: "workspace-1" } as BlindReplicaConfig
const disconnectProfile = { identity: { personId: "person-1" } } as Parameters<typeof revokeWorkspaceReplicaConnection>[1]

it("Given a compact local board, when disconnecting Rusty, then retain its offline reading key before remote revocation and delivery-token removal", async () => {
  vi.mocked(approveRustyScope).mockImplementationOnce(async () => { events.order.push("revoke-scope"); return 2 })
  vi.mocked(recordReplicaPreference).mockImplementationOnce(async () => { events.order.push("remove-delivery-tokens") })
  await revokeWorkspaceReplicaConnection(disconnectConfig, disconnectProfile, () => {})
  expect(events.order).toEqual(["retain-history-key", "revoke-scope", "remove-delivery-tokens"])
})

it("Given offline-key retention fails, when disconnect is retried, then keep delivery access until durable retention succeeds", async () => {
  vi.mocked(retainHistoryForReplicaDisconnect).mockRejectedValueOnce(new Error("local disk blocked"))
  await expect(revokeWorkspaceReplicaConnection(disconnectConfig, disconnectProfile, () => {})).rejects.toThrow("local disk blocked")
  expect(approveRustyScope).not.toHaveBeenCalled()
  expect(recordReplicaPreference).not.toHaveBeenCalled()
  vi.mocked(approveRustyScope).mockImplementationOnce(async () => { events.order.push("revoke-scope"); return 2 })
  vi.mocked(recordReplicaPreference).mockImplementationOnce(async () => { events.order.push("remove-delivery-tokens") })
  await revokeWorkspaceReplicaConnection(disconnectConfig, disconnectProfile, () => {})
  expect(events.order).toEqual(["retain-history-key", "revoke-scope", "remove-delivery-tokens"])
})
