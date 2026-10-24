import { beforeEach, expect, it } from "vitest"
import { createDeviceAuthorizationApproval, createDeviceAuthorizationRequest, createRecoverableIdentity,
  createIdentityProfileOperation, emptyIdentityProfileState, readIdentityProfileState } from "@meta-uber/mesh-identity"
import { bootstrapIdentity, clearInMemoryProfileForReloadTest, resetIdentityStorageForTest } from "../domain/identity"
import { defaultStorage } from "../storage"
import { completeIdentityBrowserSignIn } from "./completeIdentityBrowserSignIn"
import { identityEnrollmentConfirmed } from "./identityEnrollmentReceipt"

beforeEach(resetIdentityStorageForTest)

it("Given an approved signed profile photo, when browser sign-in completes, then reload retains the same person and photo", async () => {
  const app = await bootstrapIdentity("Local app")
  const owner = (await createRecoverableIdentity("better", "Photo Owner")).profile
  const initial = emptyIdentityProfileState(owner.identity.personId)
  const name = await createIdentityProfileOperation(owner, initial, "name", "Photo Owner")
  const named = await readIdentityProfileState({ ...initial, operations: [name] }, owner.identity)
  const avatarData = "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA"
  const photo = await createIdentityProfileOperation(owner, named, "photo", { avatarData, changedAt: new Date().toISOString() })
  const profileState = await readIdentityProfileState({ ...named, operations: [...named.operations, photo] }, owner.identity)
  const challenge = "a".repeat(64)
  const request = await createDeviceAuthorizationRequest(app, { applicationOrigin: "https://boards.example", challenge, expiresAt: Date.now() + 120_000 })
  const approval = await createDeviceAuthorizationApproval(owner, request, { applicationOrigin: "https://boards.example", challenge,
    certificates: [owner.certificate], revocations: [], profileState, includeProfileState: true })
  const adopted = await completeIdentityBrowserSignIn(approval, request, app)
  expect(await identityEnrollmentConfirmed(adopted)).toBe(true)
  clearInMemoryProfileForReloadTest()
  const restored = await bootstrapIdentity()
  expect(restored.identity.personId).toBe(owner.identity.personId)
  expect((await defaultStorage.loadPersonalRoot())?.photo?.avatarData).toBe(avatarData)
})

it("Given substituted profile evidence, when completing sign-in, then keep the original local identity", async () => {
  const app = await bootstrapIdentity("Local app")
  const owner = (await createRecoverableIdentity("better", "Owner")).profile
  const challenge = "b".repeat(64)
  const request = await createDeviceAuthorizationRequest(app, { applicationOrigin: "https://boards.example", challenge, expiresAt: Date.now() + 120_000 })
  const profileState = emptyIdentityProfileState(owner.identity.personId)
  const approval = await createDeviceAuthorizationApproval(owner, request, { applicationOrigin: "https://boards.example", challenge,
    certificates: [owner.certificate], revocations: [], profileState, includeProfileState: true })
  await expect(completeIdentityBrowserSignIn({ ...approval, profileState: { ...profileState, personId: "another-person" } }, request, app)).rejects.toThrow()
  expect((await bootstrapIdentity()).identity.personId).toBe(app.identity.personId)
})
