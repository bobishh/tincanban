import { beforeEach, expect, it, vi } from "vitest"
import type * as Runtime from "@meta-uber/mesh-runtime"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { rootIdentityProfileState } from "../domain/identityProfileRoot"
import { createDelegatedCertificate, createDeviceRevocation, createIdentityAuthorityView, createIdentityEnrollmentDevice,
  verifyIdentityDeviceAuthority } from "@meta-uber/mesh-identity"
import { certHashDefault } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { mergeIdentityAuthorityView, requireIdentityAuthorityView } from "../sync/identityAuthorityStore"

const runtime = vi.hoisted(() => ({ host: vi.fn(), sync: vi.fn(), serve: vi.fn() }))
vi.mock("@meta-uber/mesh-runtime", async original => ({ ...await original<typeof Runtime>(),
  createBrowserIdentityEnrollmentHost: runtime.host, syncProfileState: runtime.sync, serveIdentityProfileSync: runtime.serve }))
import { startIdentityProfileHost } from "./identityPortalEnrollment"

beforeEach(() => { resetIdentityStorageForTest(); vi.resetAllMocks() })

it.each([false, true])("Given an approved new Identity device with prior revocation=%s, when its certificate is saved, then publish verified authority before the first profile sync", async revoked => {
  const profile = await bootstrapIdentity("Enrollment owner")
  const root = createPersonalRoot(profile, await certHashDefault(profile.certificate))
  await defaultStorage.savePersonalRoot(root)
  await mergeIdentityAuthorityView(await createIdentityAuthorityView(profile.identity,
    { certificates: [profile.certificate], revocations: [] }, await rootIdentityProfileState(root)))
  if (revoked) {
    const old = await createIdentityEnrollmentDevice("Revoked profile device")
    const oldCertificate = await createDelegatedCertificate(profile.privateKeys.devicePrivateKey, profile.device.deviceId,
      profile.identity.personId, old.device.deviceId, old.device.publicKey, await certHashDefault(profile.certificate))
    const certificates = [profile.certificate, oldCertificate], state = await rootIdentityProfileState(root)
    const authority = await verifyIdentityDeviceAuthority(profile.identity, { certificates, revocations: [] })
    const revocation = await createDeviceRevocation(profile, authority, old.device.deviceId, state)
    await mergeIdentityAuthorityView(await createIdentityAuthorityView(profile.identity, { certificates, revocations: [revocation] }, state))
  }
  const guest = await createIdentityEnrollmentDevice("New profile device")
  const certificate = await createDelegatedCertificate(profile.privateKeys.devicePrivateKey, profile.device.deviceId,
    profile.identity.personId, guest.device.deviceId, guest.device.publicKey, await certHashDefault(profile.certificate))
  const close = vi.fn(async () => {})
  const pending = { request: { payload: { personId: profile.identity.personId, deviceId: guest.device.deviceId } },
    reject: vi.fn(), approve: async (options: { persist: (identity: unknown, certificates: unknown[]) => Promise<void> }) => {
      await options.persist(profile.identity, [profile.certificate, certificate])
      return { connection: {}, remoteRoute: {} }
    } }
  runtime.host.mockResolvedValue({ inviteUrl: "https://identity.example/pair#fixture", waitForEnrollment: async () => pending, close })
  runtime.serve.mockReturnValue({ close: async () => {}, done: Promise.resolve() })
  runtime.sync.mockImplementation(async (options: { current(): Promise<{ certificates: typeof certificate[] }> }) => {
    const current = await options.current()
    if (!current.certificates.some(candidate => candidate.payload.deviceId === guest.device.deviceId)) throw new Error("Identity route device is not enrolled")
    expect((await requireIdentityAuthorityView(profile.identity.personId)).certificates).toContainEqual(certificate)
    expect((await requireIdentityAuthorityView(profile.identity.personId)).revocations).toHaveLength(revoked ? 1 : 0)
  })
  await expect(startIdentityProfileHost({ profile, portalOrigin: "https://identity.example", onInvite: vi.fn(),
    onRequest: async () => "approve", onStatus: vi.fn() })).resolves.toBeDefined()
  expect(runtime.sync).toHaveBeenCalledOnce()
  expect(close).not.toHaveBeenCalled()
})
