import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "../domain/identity"
import { createIdentityRegistrationGate } from "./identityRegistrationGate"

let profile: LocalProfile
beforeEach(async () => { resetIdentityStorageForTest(); profile = await bootstrapIdentity("Owner") })
afterEach(resetIdentityStorageForTest)

it("Given an unregistered owner action, when enrollment is cancelled, then keep the exact command and perform no sharing", async () => {
  const command = { workspaceId: "board-a", selections: ["one", "two"] }
  const execute = vi.fn(async () => "sent")
  const gate = createIdentityRegistrationGate({ configured: true, getProfile: () => profile,
    refreshIdentity: async () => {}, requestRegistration: async () => false })

  await expect(gate.run({ capture: async () => command, recheckAuthority: async () => {}, execute }))
    .resolves.toBeUndefined()

  expect(command.selections).toEqual(["one", "two"])
  expect(execute).not.toHaveBeenCalled()
})

it("Given a new device for the same person, when enrollment is required, then resume only after recovery confirmation and recheck authority", async () => {
  const command = { workspaceId: "board-a", operation: { kind: "publish", heads: ["head"] } }
  const sequence: string[] = []
  const execute = vi.fn(async (_current: LocalProfile, captured: typeof command) => captured.operation.kind)
  const gate = createIdentityRegistrationGate({ configured: true, getProfile: () => profile,
    refreshIdentity: async () => { sequence.push("identity-refreshed") },
    requestRegistration: async () => { sequence.push("recovery-confirmed"); return true } })

  await expect(gate.run({ capture: async () => command,
    assertCurrent: async (_initial, captured) => { expect(captured).toBe(command); sequence.push("command-current") },
    recheckAuthority: async () => { sequence.push("authority-rechecked") }, execute }))
    .resolves.toBe("publish")

  expect(sequence).toEqual(["recovery-confirmed", "identity-refreshed", "command-current", "authority-rechecked"])
  expect(execute).toHaveBeenCalledWith(profile, command)
})

it("Given a registered person on a different device certificate, when the owner action starts, then require a fresh enrollment", async () => {
  const completed = profile
  const changed = { ...profile, device: { ...profile.device, deviceId: "different-device" },
    certificate: { ...profile.certificate, payload: { ...profile.certificate.payload, deviceId: "different-device" } } }
  const { writeLocal } = await import("../localDb")
  const { certHashDefault } = await import("../domain/proofs")
  await writeLocal(`tincanban.identity.enrollment.v1.${profile.identity.personId}`, JSON.stringify({
    personId: profile.identity.personId, deviceId: completed.device.deviceId,
    certificateHash: await certHashDefault(completed.certificate), completedAt: new Date().toISOString(),
  }))
  profile = changed
  const requestRegistration = vi.fn(async () => false)
  const gate = createIdentityRegistrationGate({ configured: true, getProfile: () => profile,
    refreshIdentity: async () => {}, requestRegistration })

  await expect(gate.run({ capture: async () => "invite", recheckAuthority: async () => {}, execute: async () => "sent" }))
    .resolves.toBeUndefined()
  expect(requestRegistration).toHaveBeenCalledOnce()
})
