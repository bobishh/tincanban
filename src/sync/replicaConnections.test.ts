import type * as IdentityModule from "../domain/identity"
import type * as MeshIdentityModule from "@meta-uber/mesh-identity"
import { afterEach, expect, it, vi } from "vitest"

const events = vi.hoisted(() => ({ order: [] as string[] }))

vi.mock("./blindClient", () => ({ discoverBlindKeeper: vi.fn(async () => ({
  origin: "https://rusty.example", servicePublicKey: "service-key", serviceId: "service-key-id", personManagement: 1,
})) }))
vi.mock("./privateReplicaRepository", () => ({ getReplicaConfigurations: vi.fn(async () => []) }))
vi.mock("./rustyEnrollment", () => ({ approveRustyScope: vi.fn() }))
vi.mock("./identityDevicePreferences", () => ({ recordReplicaPreference: vi.fn() }))
vi.mock("./rustyManagementClient", () => ({ ensureRustyPersonPolicy: vi.fn(async () => { events.order.push("person-policy-status") }) }))
vi.mock("./workspaceReplicaConnection", () => ({ ensureWorkspaceReplicaConnection: vi.fn(async (_service, _workspaceId, _profile, _guard, options) => {
  events.order.push("workspace-setup")
  await options?.beforeSetup?.()
}) }))
vi.mock("./replicaCredentialFreeze", () => ({ assertReplicaCredentialsUnfrozen: vi.fn() }))
vi.mock("./identityAuthorityStore", () => ({ requireIdentityAuthorityView: vi.fn(async () => ({ personId: "person-1" })) }))
vi.mock("../storage", () => ({ defaultStorage: { loadPersonalRoot: vi.fn(async () => ({ identity: { personId: "person-1" } })) } }))
vi.mock("../domain/identityProfileRoot", () => ({ rootIdentityProfileState: vi.fn(async () => ({ signed: true })) }))
vi.mock("@meta-uber/mesh-identity", async importOriginal => ({ ...await importOriginal<typeof MeshIdentityModule>(), identityProfileRustyServicePins: vi.fn(() => [{
  origin: "https://rusty.example", servicePublicKey: "service-key", serviceId: "service-key-id",
}]) }))
vi.mock("../domain/identity", async importOriginal => ({ ...await importOriginal<typeof IdentityModule>(), publicKeyId: vi.fn(async () => "service-key-id") }))
vi.mock("./identityReplicaConnection", () => ({ ensureIdentityReplicaConnection: vi.fn(async () => {
  events.order.push("identity-authority-ready")
}) }))

import { connectWorkspaceReplica } from "./replicaConnections"

afterEach(() => { events.order.length = 0; vi.clearAllMocks() })

it("publishes Identity authority before Add Rusty reads protected person status", async () => {
  const profile = { identity: { personId: "person-1" }, device: { deviceId: "device-1" } }
  const app = {
    getCurrentProfile: () => profile,
    readWorkspaceDoc: async () => ({ ownerPersonId: "person-1" }),
  }

  await connectWorkspaceReplica(app as never, "https://rusty.example", "workspace-1", () => {})

  expect(events.order).toEqual(["identity-authority-ready", "workspace-setup", "person-policy-status"])
})
