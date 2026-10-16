import type * as ManagementClient from "./rustyManagementClient"
import type * as ConflictWorkflow from "./replicaCredentialConflictWorkflow"
import { afterEach, expect, it, vi } from "vitest"
import { ref, shallowRef } from "vue"
import type * as Vue from "vue"
import type * as RustyAttachmentDelivery from "./rustyAttachmentDelivery"
import type { BlobDescriptor } from "@meta-uber/mesh-blob"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "../domain/identity"
import type { BlindReplicaConfig, IdentityReplicaConfig } from "./blindReplication"
import { getReplicaConfigurations, setReplicaPreference } from "./privateReplicaRepository"
import { identityDevicePreferencesChanged } from "./identityDevicePreferenceEvents"
import { replicaKey, replicaStatus } from "./replicationHealth"

const runtime = vi.hoisted(() => ({
  cleanup: [] as Array<() => void>,
  calls: [] as Array<{ purpose: string; config: unknown; profile?: LocalProfile; guard: () => void }>,
  identitySync: vi.fn(async () => true),
  workspaceSync: vi.fn(async () => true),
  maintenance: vi.fn<(app: unknown, config: BlindReplicaConfig, guard: () => void, reload: () => Promise<void>) => Promise<void>>().mockResolvedValue(undefined),
  provision: vi.fn(),
  migrate: vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
  revokeIdentityDevice: vi.fn<(app: unknown, origin: string, deviceId: string, guard: () => void) => Promise<void>>().mockResolvedValue(undefined),
  recoverConflict: vi.fn<(app: unknown, origin: string, scopeId: string, workspaceId: string, guard: () => void) => Promise<void>>().mockResolvedValue(undefined),
  readRustyStatus: vi.fn<(...args: unknown[]) => Promise<{ capability: undefined }>>().mockResolvedValue({ capability: undefined }),
  scopeApproval: vi.fn(async () => 1),
  writer: vi.fn(async (_app: unknown, config: BlindReplicaConfig, guard: () => void) => { guard(); return config }),
  fetchAttachment: vi.fn<(app: unknown, workspaceId: string, descriptor: BlobDescriptor,
    ensureCurrent: () => void, fallback?: (descriptor: BlobDescriptor) => Promise<Uint8Array | undefined>) => Promise<Uint8Array | undefined>>(),
}))
vi.mock("./rustyAttachmentDelivery", async original => {
  const module = await original<typeof RustyAttachmentDelivery>()
  return { ...module, fetchRustyAttachment: (...args: Parameters<typeof module.fetchRustyAttachment>) =>
    module.guardedAttachmentRead(args[3], () => runtime.fetchAttachment(...args)) }
})
vi.mock("vue", async original => ({ ...await original<typeof Vue>(),
  onBeforeUnmount: (cleanup: () => void) => { runtime.cleanup.push(cleanup) },
}))
vi.mock("./identityReplicaStore", () => ({ createIdentityReplica: (config: IdentityReplicaConfig, profile: LocalProfile, guard: () => void) => {
  runtime.calls.push({ purpose: "identity", config: structuredClone({ ...config }), profile, guard })
  return { sync: async () => { guard(); const result = await runtime.identitySync(); guard(); return result } }
} }))
vi.mock("./blindReplicaStore", () => ({ createBlindReplica: (config: BlindReplicaConfig, _app: unknown, guard: () => void) => {
  runtime.calls.push({ purpose: "workspace", config: structuredClone({ ...config }), guard })
  return { sync: async () => { guard(); const result = await runtime.workspaceSync(); guard(); return result } }
} }))
vi.mock("./provisionIdentityReplica", () => ({ provisionIdentityReplica: runtime.provision }))
vi.mock("./rustyDeviceAccess", () => ({ migrateRustyDeviceAccess: (...args: unknown[]) => runtime.migrate(...args) }))
vi.mock("./rustyCredentialTransition", () => ({ revokeRustyIdentityDevice: (...args: Parameters<typeof runtime.revokeIdentityDevice>) => runtime.revokeIdentityDevice(...args) }))
vi.mock("./replicaCredentialConflictWorkflow", async original => ({
  ...await original<typeof ConflictWorkflow>(),
  recoverRustyCredentialConflict: (...args: Parameters<typeof runtime.recoverConflict>) => runtime.recoverConflict(...args),
}))
vi.mock("./rustyManagementClient", async original => ({
  ...await original<typeof ManagementClient>(),
  readRustyManagementStatus: (...args: unknown[]) => runtime.readRustyStatus(...args),
}))
vi.mock("./rustyEnrollment", () => ({ approveRustyScope: runtime.scopeApproval }))
vi.mock("./workspaceReplicaWriter", () => ({ ensureWorkspaceReplicaWriter: runtime.writer,
  maintainWorkspaceReplicaWriter: runtime.maintenance }))

import { useBlindReplication } from "./useBlindReplication"
import { RustyPermissionMigrationRequiredError } from "./rustyPermissionMigration"

afterEach(() => {
  for (const cleanup of runtime.cleanup.splice(0)) cleanup()
  runtime.calls.length = 0
  runtime.identitySync.mockReset().mockResolvedValue(true)
  runtime.workspaceSync.mockReset().mockResolvedValue(true)
  runtime.maintenance.mockReset().mockResolvedValue(undefined)
  runtime.provision.mockReset()
  runtime.migrate.mockReset().mockResolvedValue(undefined)
  runtime.revokeIdentityDevice.mockReset().mockResolvedValue(undefined)
  runtime.recoverConflict.mockReset().mockResolvedValue(undefined)
  runtime.readRustyStatus.mockReset().mockResolvedValue({ capability: undefined })
  runtime.scopeApproval.mockReset().mockResolvedValue(1)
  runtime.writer.mockReset().mockImplementation(async (_app, config, guard) => { guard(); return config })
  runtime.fetchAttachment.mockReset()
  resetIdentityStorageForTest()
})

async function fixture() {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Scheduler owner")
  const personId = profile.identity.personId
  const token = "A".repeat(43)
  const access = { origin: "https://rusty.example", servicePublicKey: token, readToken: token, writeToken: token,
    contentKey: token, keyEpoch: 1, policyRevision: 1, cursor: 0, lastUploaded: "" }
  const identity: IdentityReplicaConfig = { ...access, purpose: "identity", personId, scopeId: `identity-${crypto.randomUUID()}` }
  const workspace: BlindReplicaConfig = { ...access, purpose: "workspace", workspaceId: "workspace-a", scopeId: `board-${crypto.randomUUID()}` }
  const current = shallowRef(profile)
  const version = ref(0)
  const localChanges: Array<() => void> = []
  const activeWorkspace = { id: workspace.workspaceId }
  const app = {
    ready: ref(true), docVersion: version, getCurrentProfile: () => current.value,
    activeWorkspace,
    subscribeLocalChanges: (listener: () => void) => { localChanges.push(listener); return () => {} },
  } as unknown as Parameters<typeof useBlindReplication>[0]
  return { profile, personId, identity, workspace, current, version, localChanges, activeWorkspace, start: () => useBlindReplication(app) }
}

const file: BlobDescriptor = { kind: "blob", version: 1, blobId: `sha256:${"A".repeat(43)}`,
  name: "private.txt", mediaType: "text/plain", size: 2 }

it("Given confirmed history completion, when background synchronization starts and finishes, then retain its workspace notice", async () => {
  const f = await fixture()
  await setReplicaPreference(f.personId, f.workspace)
  const controller = f.start()
  await vi.waitFor(() => expect(runtime.workspaceSync).toHaveBeenCalled())
  await controller.syncNow()
  const message = "Older history archived. Previous versions remain available."
  controller.historyNotices.value[f.workspace.workspaceId] = message
  let release!: () => void
  runtime.workspaceSync.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = () => resolve(true) }))
  const pending = controller.syncNow()
  await vi.waitFor(() => expect(release).toBeTypeOf("function"))
  expect(controller.historyNotices.value).toEqual({ [f.workspace.workspaceId]: message })
  release(); await pending
  expect(controller.historyNotices.value).toEqual({ [f.workspace.workspaceId]: message })
})

it("Given a legacy workspace connection, when post-sync maintenance confirms writer migration, then use the new causal credentials on the next sync", async () => {
  const f = await fixture()
  await setReplicaPreference(f.personId, f.workspace)
  runtime.maintenance.mockImplementationOnce(async (_app, config, guard, reload) => {
    guard()
    await setReplicaPreference(f.personId, { ...config, policyRevision: 2, minimumWriterVersion: 2 })
    guard()
    await reload()
  })
  const controller = f.start()
  await vi.waitFor(() => expect(runtime.workspaceSync, controller.error.value).toHaveBeenCalled())
  await controller.syncNow()
  expect(runtime.calls.find(call => call.purpose === "workspace")?.config).toMatchObject(f.workspace)
  expect(controller.configs.value[0]).toMatchObject({ policyRevision: 2, minimumWriterVersion: 2 })
  await controller.syncNow()
  expect(runtime.calls.filter(call => call.purpose === "workspace").at(-1)?.config).toMatchObject({ policyRevision: 2, minimumWriterVersion: 2 })
})

it("Given optional writer maintenance fails after normal sync, then keep replica health synced and record contextual failure", async () => {
  const f = await fixture()
  await setReplicaPreference(f.personId, f.workspace)
  runtime.maintenance.mockRejectedValue(new Error("Module terminated"))
  const tracing = await import("./meshTrace")
  const trace = vi.spyOn(tracing, "meshTrace")
  const controller = f.start()
  await vi.waitFor(() => expect(runtime.workspaceSync).toHaveBeenCalled())
  await controller.syncNow()
  expect(controller.statuses.value[replicaKey(f.workspace)]?.phase).toBe("synced")
  expect(controller.error.value).toBe("")
  expect(trace).toHaveBeenCalledWith("workspace.replica.writer-maintenance.failed", expect.objectContaining({
    phase: "post-sync-pass", workspaceId: f.workspace.workspaceId, "server.address": "rusty.example",
  }), "warn", expect.any(Error))
})

it("Given an active workspace file request, then the controller supplies a live session guard to Rusty delivery", async () => {
  const f = await fixture()
  const controller = f.start()
  await vi.waitFor(() => expect(controller.busy.value).toBe(false))
  runtime.fetchAttachment.mockImplementationOnce(async (_app, workspaceId, descriptor, guard) => {
    guard()
    expect(workspaceId).toBe(f.workspace.workspaceId)
    expect(descriptor).toEqual(file)
    return new Uint8Array([1, 2])
  })
  const peer = vi.fn(async () => undefined)
  expect(await controller.fetchAttachment(f.workspace.workspaceId, file, peer)).toEqual(new Uint8Array([1, 2]))
  expect(peer).not.toHaveBeenCalled()
})

it.each(["workspace", "identity"] as const)(
  "Given a file download waits, when the active %s changes, then never return the previous session's bytes", async changed => {
    const f = await fixture()
    const controller = f.start()
    await vi.waitFor(() => expect(controller.busy.value).toBe(false))
    runtime.fetchAttachment.mockImplementationOnce(async () => {
      if (changed === "workspace") f.activeWorkspace.id = "different-workspace"
      else f.current.value = { ...f.profile, device: { ...f.profile.device, publicKey: "different-device-key" } }
      return new Uint8Array([1, 2])
    })
    await expect(controller.fetchAttachment(f.workspace.workspaceId, file)).rejects.toThrow(/identity|workspace|session/i)
  },
)

it("Given board and personal Rusty connections, when removal receives confirmed revocation, then remove only that board connection", async () => {
  const f = await fixture()
  await setReplicaPreference(f.personId, f.identity)
  await setReplicaPreference(f.personId, f.workspace)
  const controller = f.start()
  await vi.waitFor(() => expect(runtime.workspaceSync, controller.error.value).toHaveBeenCalled())
  await controller.syncNow()
  await controller.remove(f.workspace)
  expect(runtime.scopeApproval).toHaveBeenCalledWith(f.workspace, f.profile, true)
  expect(await getReplicaConfigurations(f.personId)).toEqual([])
  expect(controller.identityConfigs.value[0]?.scopeId).toBe(f.identity.scopeId)
})

it("Given Rusty rejects board removal, when revocation fails, then retain pending credentials and report incomplete removal", async () => {
  const f = await fixture()
  await setReplicaPreference(f.personId, f.identity)
  await setReplicaPreference(f.personId, f.workspace)
  const controller = f.start()
  await vi.waitFor(() => expect(runtime.workspaceSync, controller.error.value).toHaveBeenCalled())
  await controller.syncNow()
  runtime.scopeApproval.mockRejectedValue(new Error("Rusty unavailable"))
  await expect(controller.remove(f.workspace)).rejects.toThrow("Rusty unavailable")
  const pending = (await getReplicaConfigurations(f.personId))[0]
  expect(pending).toMatchObject({ scopeId: f.workspace.scopeId, removalPending: true })
  expect(replicaStatus(pending, controller.statuses.value[replicaKey(pending)], Date.now())).toBe("Removal pending")
  expect(controller.identityConfigs.value[0]?.scopeId).toBe(f.identity.scopeId)
})

it("Given only a personal Rusty connection, when the app starts, then its normal loop synchronizes identity without needing a board config", async () => {
  const f = await fixture()
  await setReplicaPreference(f.personId, f.identity)
  const controller = f.start()
  await vi.waitFor(() => expect(runtime.identitySync).toHaveBeenCalledTimes(1))
  await controller.syncNow()
  expect(runtime.calls.map(call => call.purpose)).toEqual(["identity"])
  expect(controller.configs.value).toEqual([])
  expect(controller.identityConfigs.value[0]?.personId).toBe(f.personId)
  expect(controller.statuses.value[replicaKey(f.identity)]?.phase).toBe("synced")
})

it("Given an existing board Rusty connection lacks private delivery, when the normal loop starts, then provision and start a separate personal replica", async () => {
  const f = await fixture()
  await setReplicaPreference(f.personId, f.workspace)
  runtime.provision.mockImplementationOnce(async () => { await setReplicaPreference(f.personId, f.identity) })
  const controller = f.start()
  await vi.waitFor(() => expect(runtime.identitySync).toHaveBeenCalled())
  await controller.syncNow()
  expect(runtime.provision).toHaveBeenCalledTimes(1)
  expect(runtime.calls.map(call => call.purpose)).toEqual(["identity", "workspace"])
})

it("Given private scope migration is unavailable, then expose its actual setup failure while existing board replication continues", async () => {
  const f = await fixture()
  await setReplicaPreference(f.personId, f.workspace)
  runtime.provision.mockRejectedValue(new Error("Owner policy migration required"))
  const controller = f.start()
  await vi.waitFor(() => expect(runtime.workspaceSync, controller.error.value).toHaveBeenCalled())
  await controller.syncNow()
  expect(controller.profileSetupErrors.value[f.workspace.origin]).toBe("Owner policy migration required")
  expect(controller.profilePermissionUpdates.value).toEqual([])
  expect(controller.statuses.value[replicaKey(f.workspace)]?.phase).toBe("synced")
  expect(runtime.identitySync).not.toHaveBeenCalled()
})

it("Given private identity-scope provisioning requires a Rusty permission update, then mark that origin for explicit owner action", async () => {
  const f = await fixture()
  await setReplicaPreference(f.personId, f.workspace)
  runtime.provision.mockRejectedValueOnce(new RustyPermissionMigrationRequiredError())
  const controller = f.start()

  await vi.waitFor(() => expect(controller.profilePermissionUpdates.value).toEqual([f.workspace.origin]))
  expect(controller.profileSetupErrors.value[f.workspace.origin]).toMatch(/Update Rusty device access/i)
  expect(runtime.workspaceSync, controller.error.value).toHaveBeenCalled()
})

it("Given an identity replica reports missing Rusty permission, then mark its origin for explicit owner action", async () => {
  const f = await fixture()
  await setReplicaPreference(f.personId, f.identity)
  runtime.identitySync.mockRejectedValueOnce(new RustyPermissionMigrationRequiredError())
  const controller = f.start()

  await vi.waitFor(() => expect(controller.profilePermissionUpdates.value).toEqual([f.identity.origin]))
  await vi.waitFor(() => expect(controller.statuses.value[replicaKey(f.identity)]?.phase).toBe("error"))
  expect(controller.statuses.value[replicaKey(f.identity)]).toMatchObject({
    phase: "error", error: expect.stringMatching(/Update Rusty device access/i),
  })
})

it("Given Rusty permission migration is required, when owner updates device access, then retry provisioning and clear the origin flag", async () => {
  const f = await fixture()
  await setReplicaPreference(f.personId, f.workspace)
  runtime.provision.mockRejectedValueOnce(new RustyPermissionMigrationRequiredError())
  const controller = f.start()
  await vi.waitFor(() => expect(controller.profilePermissionUpdates.value).toEqual([f.workspace.origin]))
  await vi.waitFor(() => expect(controller.busy.value).toBe(false))
  runtime.migrate.mockResolvedValue(undefined)

  await controller.updateDeviceAccess(f.workspace.origin, f.workspace.workspaceId)

  expect(runtime.migrate).toHaveBeenCalledWith(expect.anything(), f.workspace.origin, f.workspace.workspaceId, expect.any(Function))
  expect(runtime.provision).toHaveBeenCalledTimes(2)
  expect(controller.profilePermissionUpdates.value).toEqual([])
  expect(runtime.workspaceSync, controller.error.value).toHaveBeenCalled()
})

it("Given permission migration remains unavailable, when explicit update fails, then preserve origin flag and user-visible error", async () => {
  const f = await fixture()
  await setReplicaPreference(f.personId, f.identity)
  runtime.identitySync.mockRejectedValueOnce(new RustyPermissionMigrationRequiredError())
  const controller = f.start()
  await vi.waitFor(() => expect(controller.profilePermissionUpdates.value).toEqual([f.identity.origin]))
  await vi.waitFor(() => expect(controller.busy.value).toBe(false))
  runtime.migrate.mockRejectedValue(new Error("Owner approval denied"))

  await expect(controller.updateDeviceAccess(f.identity.origin, f.workspace.workspaceId)).rejects.toThrow("Owner approval denied")

  expect(controller.profilePermissionUpdates.value).toEqual([f.identity.origin])
  expect(controller.error.value).toBe("Owner approval denied")
  expect(runtime.identitySync).toHaveBeenCalledTimes(1)
})

it("Given a personal snapshot adds a board connection, when the normal pass pulls it, then that pass reloads settings and synchronizes the new board", async () => {
  const f = await fixture()
  await setReplicaPreference(f.personId, f.identity)
  runtime.identitySync.mockImplementationOnce(async () => {
    await setReplicaPreference(f.personId, f.workspace)
    identityDevicePreferencesChanged(f.personId)
    return true
  })
  const controller = f.start()
  await vi.waitFor(() => expect(runtime.workspaceSync, controller.error.value).toHaveBeenCalled())
  await controller.syncNow()
  expect(runtime.calls.map(call => call.purpose)).toEqual(["identity", "workspace"])
  expect(controller.configs.value[0]?.workspaceId).toBe("workspace-a")
})

it("Given personal replication fails, when a board sync succeeds, then health distinguishes the failure and does not stop board delivery", async () => {
  const f = await fixture()
  await setReplicaPreference(f.personId, f.identity)
  await setReplicaPreference(f.personId, f.workspace)
  runtime.identitySync.mockRejectedValue(new Error("Private scope revoked"))
  const controller = f.start()
  await vi.waitFor(() => expect(runtime.workspaceSync, controller.error.value).toHaveBeenCalled())
  await controller.syncNow()
  expect(runtime.workspaceSync, controller.error.value).toHaveBeenCalled()
  expect(controller.statuses.value[replicaKey(f.identity)]).toMatchObject({ phase: "error", error: "Private scope revoked" })
  expect(controller.statuses.value[replicaKey(f.workspace)]?.phase).toBe("synced")
  expect(controller.error.value).toContain("Profile")
  expect(controller.profilePermissionUpdates.value).toEqual([])
})

it("Given personal credentials change, when private settings notify the app, then the next pass creates a replica for the exact new credential revision", async () => {
  const f = await fixture()
  await setReplicaPreference(f.personId, f.identity)
  const controller = f.start()
  await vi.waitFor(() => expect(runtime.calls).toHaveLength(1))
  await controller.syncNow()
  await setReplicaPreference(f.personId, { ...f.identity, keyEpoch: 2, contentKey: "B".repeat(42) + "A",
    historicalContentKeys: { "1": f.identity.contentKey } })
  identityDevicePreferencesChanged(f.personId)
  await vi.waitFor(() => expect(runtime.calls, controller.error.value).toHaveLength(2))
  expect(runtime.calls[1]?.config).toMatchObject({ keyEpoch: 2, contentKey: "B".repeat(42) + "A",
    historicalContentKeys: { "1": f.identity.contentKey } })
})

it("Given another registered identity device, when owner removes its Rusty access, then call the identity-wide transition with a live session guard", async () => {
  const f = await fixture()
  await setReplicaPreference(f.personId, f.identity)
  const controller = f.start()
  await vi.waitFor(() => expect(controller.busy.value).toBe(false))
  await controller.revokeIdentityDevice(f.identity.origin, "other-registered-device")
  expect(runtime.revokeIdentityDevice).toHaveBeenCalledTimes(1)
  const [app, origin, deviceId, guard] = runtime.revokeIdentityDevice.mock.calls[0]!
  expect(app).toBeDefined()
  expect(origin).toBe(f.identity.origin)
  expect(deviceId).toBe("other-registered-device")
  expect(guard).toBeTypeOf("function")
  expect(() => guard()).not.toThrow()
  f.current.value = { ...f.profile, device: { ...f.profile.device, deviceId: "replacement-device" } }
  expect(() => guard()).toThrow(/identity changed/i)
})

it("Given a paused credential conflict, when the owner resumes recovery, then bind it to the exact workspace session", async () => {
  const f = await fixture()
  const controller = f.start()
  await vi.waitFor(() => expect(controller.busy.value).toBe(false))
  await controller.recoverCredentialConflict("https://rusty.example", "conflicted-scope", f.workspace.workspaceId)
  expect(runtime.recoverConflict).toHaveBeenCalledTimes(1)
  const [app, origin, scopeId, workspaceId, guard] = runtime.recoverConflict.mock.calls[0]!
  expect(app).toBeDefined()
  expect(origin).toBe("https://rusty.example")
  expect(scopeId).toBe("conflicted-scope")
  expect(workspaceId).toBe(f.workspace.workspaceId)
  expect(guard).toBeTypeOf("function")
  expect(() => guard()).not.toThrow()
  f.activeWorkspace.id = "another-workspace"
  expect(() => guard()).toThrow(/identity changed or workspace switched/i)
})

it("Given the same person's active device changes during sync, then the old replica cannot continue under the replacement device", async () => {
  const f = await fixture()
  await setReplicaPreference(f.personId, f.identity)
  let release!: () => void
  runtime.identitySync.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = () => resolve(true) }))
  const controller = f.start()
  await vi.waitFor(() => expect(runtime.calls).toHaveLength(1))
  const old = runtime.calls[0]!
  f.current.value = { ...f.profile, device: { ...f.profile.device, deviceId: "replacement-device" } }
  f.version.value += 1
  await vi.waitFor(() => expect(() => old.guard()).toThrow("Identity changed"))
  release()
  await controller.syncNow()
  await vi.waitFor(() => expect(runtime.calls.some(call => call.profile?.device.deviceId === "replacement-device"), controller.error.value).toBe(true))
})

it("Given the app unmounts, then a cached private replica's identity guard rejects later work", async () => {
  const f = await fixture()
  await setReplicaPreference(f.personId, f.identity)
  f.start()
  await vi.waitFor(() => expect(runtime.calls).toHaveLength(1))
  runtime.cleanup[0]!()
  expect(() => runtime.calls[0]!.guard()).toThrow("Identity changed")
})
