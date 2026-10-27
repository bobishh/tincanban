import { beforeEach, expect, it } from "vitest"
import { createDeviceEnrollmentInvite } from "@meta-uber/mesh-pairing"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { compareAndSwapLocal } from "../localDb"
import { readIdentityStateRevision } from "../identityStateRevision"
import { exportIdentityPeerRecovery, planIdentityPeerRecoveryImport, readIdentityPeerRecovery,
  saveIdentityPeerRecovery } from "./identityPeerRecoveryCatalog"

beforeEach(() => resetIdentityStorageForTest())

it("Given a private source address, when catalog delivery repeats or crosses reload, then retain one retryable source without board contents", async () => {
  const profile = await bootstrapIdentity()
  const invite = createDeviceEnrollmentInvite("source-endpoint", "secret", profile)
  const entry = { workspaceId: "board", invite }
  const before = await readIdentityStateRevision()
  await saveIdentityPeerRecovery(profile.identity.personId, [entry])
  const next = await readIdentityStateRevision()
  expect(next).not.toBe(before)
  const components = await exportIdentityPeerRecovery(profile.identity.personId)
  expect(JSON.stringify(components)).not.toMatch(/snapshot|transportSecret|privateKey/)
  const manifest = { personId: profile.identity.personId, components }
  await compareAndSwapLocal(await planIdentityPeerRecoveryImport(manifest))
  expect(await readIdentityPeerRecovery(profile.identity.personId)).toEqual([entry])
  expect(await readIdentityStateRevision()).toBe(next)
})

it("Given a foreign source or expired invitation, when importing addresses, then reject foreign Identity and omit expired sources", async () => {
  const profile = await bootstrapIdentity()
  const invite = createDeviceEnrollmentInvite("source-endpoint", "secret", profile, Date.now() - 11 * 60_000)
  await saveIdentityPeerRecovery(profile.identity.personId, [{ workspaceId: "board", invite }])
  expect(await readIdentityPeerRecovery(profile.identity.personId)).toEqual([])
  invite.issuerPersonId = "someone-else"
  await expect(saveIdentityPeerRecovery(profile.identity.personId, [{ workspaceId: "board", invite }])).rejects.toThrow(/Identity/)
})

it("Given an older client retained recovery hints as an optional component, when a newer client imports them, then recover the same source", async () => {
  const profile = await bootstrapIdentity()
  const entry = { workspaceId: "board", invite: createDeviceEnrollmentInvite("endpoint", "secret", profile) }
  await compareAndSwapLocal(await planIdentityPeerRecoveryImport({ personId: profile.identity.personId, components: {
    preservedExtensions: { schema: "preserved-identity-components@1", required: false, value: {
      personId: profile.identity.personId, extensions: [{ name: "peerRecovery", component: {
        schema: "identity-peer-recovery@1", required: false, value: { personId: profile.identity.personId, sources: [entry] },
      } }],
    } },
  } }))
  expect(await readIdentityPeerRecovery(profile.identity.personId)).toEqual([entry])
})

it("Given a full catalog of 512 live hints, when the same catalog is delivered again, then duplicates do not exceed the unique-source quota", async () => {
  const profile = await bootstrapIdentity()
  const invite = createDeviceEnrollmentInvite("endpoint", "secret", profile)
  const sources = Array.from({ length: 512 }, (_, index) => ({ workspaceId: `board-${index}`, invite }))
  await saveIdentityPeerRecovery(profile.identity.personId, sources)
  const before = await readIdentityStateRevision()
  await saveIdentityPeerRecovery(profile.identity.personId, sources)
  expect(await readIdentityPeerRecovery(profile.identity.personId)).toHaveLength(512)
  expect(await readIdentityStateRevision()).toBe(before)
})
