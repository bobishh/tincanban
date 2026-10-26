import { beforeEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault, defaultProofStore } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { createDeviceSyncState } from "./deviceSyncState"
import { confirmIdentityAuthorityFixture } from "./identityAuthority.testSupport"
import * as authorityStore from "./identityAuthorityStore"
import { reconnectWorkspaceDevice } from "./deviceReconnection"

beforeEach(resetIdentityStorageForTest)

it("Given renewal persisted before its authority merge failed, when reconnect retries, then register same device and join", async () => {
  const original = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(original, await certHashDefault(original.certificate))
  await defaultStorage.savePersonalRoot(root)
  await confirmIdentityAuthorityFixture(root, [original.certificate])

  const state = createDeviceSyncState()
  state.canRenewDevice.value = true
  state.parsedInvite.value = { kind: "workspace-join", workspaceId: "board", workspaceTitle: "Board",
    workspaces: [{ id: "board", title: "Board" }], expiresAt: new Date(Date.now() + 60_000).toISOString() } as never
  state.step.value = "workspace-reconnect-confirm"
  const actualMerge = authorityStore.mergeIdentityAuthorityView
  const failOnce = vi.spyOn(authorityStore, "mergeIdentityAuthorityView")
    .mockRejectedValueOnce(new Error("Simulated interruption after profile persistence"))
    .mockImplementation(actualMerge)
  const context = { state, stop: vi.fn(async () => {}), resetMesh: vi.fn(async () => {}),
    refreshProfile: vi.fn(async () => {}), join: vi.fn(async () => {}) }

  await reconnectWorkspaceDevice(context)
  const renewed = await bootstrapIdentity()
  expect(renewed.device.deviceId).not.toBe(original.device.deviceId)
  expect(state.step.value).toBe("error")
  expect(state.error.value).toContain("Simulated interruption after profile persistence")
  expect(failOnce).toHaveBeenCalledTimes(1)

  state.step.value = "workspace-reconnect-confirm"
  await reconnectWorkspaceDevice(context)

  expect((await bootstrapIdentity()).device.deviceId).toBe(renewed.device.deviceId)
  await expect(authorityStore.readIdentityAuthorityView(original.identity.personId))
    .resolves.toMatchObject({ certificates: expect.arrayContaining([renewed.certificate]) })
  await expect(defaultProofStore.getCertificate(await certHashDefault(renewed.certificate))).resolves.toEqual(renewed.certificate)
  expect(context.join).toHaveBeenCalledTimes(1)
  failOnce.mockRestore()
})
