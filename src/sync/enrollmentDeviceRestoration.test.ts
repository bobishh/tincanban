import { beforeEach, expect, it, vi } from "vitest"
import type { LocalProfile } from "../domain/identity"
import { readLocal, writeLocal } from "../localDb"
import { myDeviceRemovalsKey } from "./myDeviceRemovalState"
import { restoreEnrolledRustyAccess } from "./enrollmentDeviceRestoration"

const ports = vi.hoisted(() => ({ configs: vi.fn(), records: vi.fn(), status: vi.fn(), update: vi.fn(), unfrozen: vi.fn() }))
vi.mock("./privateReplicaRepository", () => ({ getPrivateReplicaConfigurations: ports.configs }))
vi.mock("./rustyManagementRepository", () => ({ RustyManagementRepository: class { export = ports.records } }))
vi.mock("./rustyManagementClient", () => ({ readRustyManagementStatus: ports.status, updateRustyManagementPolicy: ports.update }))
vi.mock("./replicaCredentialFreeze", () => ({ assertReplicaCredentialsUnfrozen: ports.unfrozen }))

const profile = { identity: { personId: "restoration-owner" } } as LocalProfile
const binding = (resourceKind: string, resourceId: string) => ({ origin: "https://rusty.example", servicePublicKey: "pin", resourceKind, resourceId })

beforeEach(() => {
  vi.resetAllMocks()
  ports.configs.mockResolvedValue([{ origin: "https://rusty.example", purpose: "workspace", workspaceId: "board", scopeId: "scope" }])
  ports.records.mockResolvedValue(["scope", "person"].map(kind => ({ binding: binding(kind, kind), capability: { payload: { revokedDeviceIds: [] } } })))
  ports.status.mockResolvedValue({ capability: { payload: { revokedDeviceIds: ["other", "removed"], operations: ["management.update"] } } })
})

it("Given a removed device and stale local policy, when enrollment is approved, then restore from live person and selected scope policy before retiring the prior removal job", async () => {
  await writeLocal(myDeviceRemovalsKey(profile.identity.personId), JSON.stringify([{ deviceId: "removed", origins: { "https://rusty.example": { status: "removed" } } }, { deviceId: "keep" }]))
  await restoreEnrolledRustyAccess(profile, "removed", ["board"], () => {})
  expect(ports.update.mock.calls.map(call => call[0].resourceKind)).toEqual(["person", "scope"])
  expect(ports.update.mock.calls[0]![2]).toEqual({ operations: ["management.update"], revokedDeviceIds: ["other"], restoredDeviceIds: ["removed"] })
  expect(JSON.parse((await readLocal(myDeviceRemovalsKey(profile.identity.personId)))!)).toEqual([{ deviceId: "keep" }])
})

it("Given an in-flight removal transition, when enrollment attempts restoration, then retain the job and do not send a contradictory policy", async () => {
  const saved = JSON.stringify([{ deviceId: "removed", origins: { "https://rusty.example": { status: "pending" } } }])
  await writeLocal(myDeviceRemovalsKey(profile.identity.personId), saved)
  ports.unfrozen.mockRejectedValue(new Error("Transition pending"))
  await expect(restoreEnrolledRustyAccess(profile, "removed", ["board"], () => {})).rejects.toThrow("Transition pending")
  expect(ports.update).not.toHaveBeenCalled()
  expect(await readLocal(myDeviceRemovalsKey(profile.identity.personId))).toBe(saved)
})

it("Given a canceled enrollment, when the continuation resumes, then send no restoration", async () => {
  await writeLocal(myDeviceRemovalsKey(profile.identity.personId), JSON.stringify([{ deviceId: "removed", origins: { "https://rusty.example": { status: "removed" } } }]))
  await expect(restoreEnrolledRustyAccess(profile, "removed", ["board"], () => { throw new Error("Canceled") })).rejects.toThrow("Canceled")
  expect(ports.status).not.toHaveBeenCalled()
  expect(ports.update).not.toHaveBeenCalled()
})

it("Given a new device without removal evidence, when enrollment is approved offline, then do not require a Rusty connection", async () => {
  await writeLocal(myDeviceRemovalsKey(profile.identity.personId), "[]")
  await restoreEnrolledRustyAccess(profile, "new-device", ["board"], () => {})
  expect(ports.status).not.toHaveBeenCalled()
  expect(ports.update).not.toHaveBeenCalled()
})
