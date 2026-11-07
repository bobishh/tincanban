import { afterEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, toBase64Url } from "../domain/identity"
import { prepareReplicaCredentialFreeze } from "./replicaCredentialFreeze"
import { setReplicaPreference } from "./privateReplicaRepository"
import { provisionIdentityReplica } from "./provisionIdentityReplica"
import { provisionIdentityReplicas } from "./provisionIdentityReplicas"

afterEach(() => { vi.unstubAllGlobals(); resetIdentityStorageForTest() })

it("Given profile provisioning shares a frozen Rusty origin, when its background setup starts, then do not discover or mutate service policy", async () => {
  const profile = await bootstrapIdentity("Background provision")
  const servicePublicKey = toBase64Url(new Uint8Array(32).fill(7))
  const access = { origin: "https://rusty.example", servicePublicKey }
  const config = { purpose: "workspace" as const, workspaceId: "board", scopeId: "scope", ...access,
    contentKey: toBase64Url(new Uint8Array(32).fill(2)), readToken: toBase64Url(new Uint8Array(32).fill(3)),
    writeToken: toBase64Url(new Uint8Array(32).fill(4)), keyEpoch: 1, policyRevision: 1, cursor: 0,
    lastUploaded: "", minimumWriterVersion: 2 as const }
  await setReplicaPreference(profile.identity.personId, config)
  await prepareReplicaCredentialFreeze(profile, access.origin, servicePublicKey, "revoked-device", () => {})
  const fetch = vi.fn(async () => { throw new Error("discovery must not run while frozen") })
  vi.stubGlobal("fetch", fetch)

  await expect(provisionIdentityReplica(access, profile, () => {})).rejects.toThrow(/transition|frozen/i)
  expect(fetch).not.toHaveBeenCalled()
  const errors = await provisionIdentityReplicas({ getCurrentProfile: () => profile } as never, [config], new Set(), () => {})
  expect(errors[access.origin]).toMatch(/transition|frozen/i)
  expect(fetch).not.toHaveBeenCalled()
})

it("Given shared board storage on a service not approved by this Identity, when provisioning the private catalog, then skip optional backup without an error or private upload", async () => {
  const profile = await bootstrapIdentity("Editor")
  const access = { origin: "https://unapproved.example", servicePublicKey: toBase64Url(new Uint8Array(32).fill(7)) }
  const fetch = vi.fn(async () => { throw new Error("Unapproved service must not be contacted") })
  vi.stubGlobal("fetch", fetch)
  await expect(provisionIdentityReplica(access, profile, () => {})).resolves.toBeUndefined()
  expect(fetch).not.toHaveBeenCalled()
})
