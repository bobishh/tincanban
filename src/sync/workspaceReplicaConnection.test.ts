import { afterEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, toBase64Url } from "../domain/identity"
import * as localDb from "../localDb"
import { getReplicaConfigurations, setReplicaPreference } from "./privateReplicaRepository"
import { prepareReplicaCredentialFreeze } from "./replicaCredentialFreeze"
import type { BlindReplicaConfig } from "./blindReplication"
import type { RustyScopeEnrollmentOptions } from "./rustyEnrollment"
import type { RustyScopePolicyReceipt } from "../product-replica/rustyScopePolicy"

const workspaceId = "workspace-1"
const remote = vi.hoisted(() => ({
  approve: vi.fn<(config: BlindReplicaConfig, profile: unknown, revoked?: boolean, options?: unknown) => Promise<number>>().mockResolvedValue(2),
}))
vi.mock("./rustyEnrollment", () => ({ approveRustyScope: remote.approve }))

import { ensureWorkspaceReplicaConnection, workspaceReplicaSetupKey } from "./workspaceReplicaConnection"
import { connectWorkspaceReplica } from "./replicaConnections"

async function serviceFixture() {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))
  return { origin: "https://rusty.example", servicePublicKey: toBase64Url(publicKey), scopeManagement: 1 as const,
    servicePrivateKey: keys.privateKey, serviceId: await sha256Base64Url(publicKey) }
}

async function receipt(config: BlindReplicaConfig, personId: string, service: Awaited<ReturnType<typeof serviceFixture>>,
  minimumWriterVersion: unknown = 2) {
  return await signEnvelope(service.servicePrivateKey, {
    kind: "rusty-scope-policy-receipt" as const, version: 1 as const, serviceId: service.serviceId, scopeId: config.scopeId,
    personId, revision: 2, revoked: false, challengeId: "challenge-1", authorizationHash: "A".repeat(43),
    ...(minimumWriterVersion === undefined || minimumWriterVersion === null ? {} : { minimumWriterVersion }),
  }, service.serviceId, "RUSTY/2") as unknown as RustyScopePolicyReceipt
}

function approveAndConfirm(service: Awaited<ReturnType<typeof serviceFixture>>) {
  remote.approve.mockImplementation(async (config, profile, _revoked, rawOptions) => {
    const identity = profile as { identity: { personId: string } }
    const options = rawOptions as RustyScopeEnrollmentOptions | undefined
    await options?.confirmed?.(await receipt(config, identity.identity.personId, service, options.minimumWriterVersion ?? null))
    return 2
  })
}

afterEach(() => {
  resetIdentityStorageForTest()
  remote.approve.mockReset().mockResolvedValue(2)
  vi.restoreAllMocks()
})

it("Given a saved legacy enrollment, when setup resumes, then preserve its v1 request and accept its signed legacy receipt", async () => {
  const service = await serviceFixture()
  const profile = await bootstrapIdentity("Legacy setup resume")
  remote.approve.mockRejectedValueOnce(new Error("approval reply lost"))
  await expect(ensureWorkspaceReplicaConnection(service, workspaceId, profile, () => {})).rejects.toThrow("reply lost")
  const key = await workspaceReplicaSetupKey(profile.identity.personId, service.origin, workspaceId)
  const raw = (await localDb.readLocal(key))!
  const saved = JSON.parse(raw) as { config: BlindReplicaConfig }
  const legacyConfig = { ...saved.config }
  delete legacyConfig.minimumWriterVersion
  const legacyRaw = JSON.stringify({ ...JSON.parse(raw), config: legacyConfig })
  await localDb.writeLocal(key, legacyRaw)

  approveAndConfirm(service)
  const result = await ensureWorkspaceReplicaConnection(service, workspaceId, profile, () => {})
  expect(remote.approve).toHaveBeenCalledWith(legacyConfig, expect.anything(), false,
    expect.objectContaining({ ensureCurrent: expect.any(Function), confirmed: expect.any(Function) }))
  expect(remote.approve.mock.calls[1]?.[3]).not.toHaveProperty("minimumWriterVersion")
  expect(result).toMatchObject({ ...legacyConfig, policyRevision: 2 })
})

it("Given a new v2 setup, when a saved receipt omits or downgrades its floor, then do not activate its credentials", async () => {
  for (const receiptFloor of [undefined, 1]) {
    resetIdentityStorageForTest()
    remote.approve.mockReset()
    const service = await serviceFixture()
    const profile = await bootstrapIdentity("V2 setup receipt floor")
    remote.approve.mockImplementation(async (config, _profile, _revoked, rawOptions) => {
      const options = rawOptions as RustyScopeEnrollmentOptions | undefined
      await options?.confirmed?.(await receipt(config, profile.identity.personId, service, receiptFloor ?? null))
      return 2
    })
    await expect(ensureWorkspaceReplicaConnection(service, workspaceId, profile, () => {})).rejects.toThrow(/receipt binding|invalid/i)
    expect(await getReplicaConfigurations(profile.identity.personId)).toEqual([])
    const key = await workspaceReplicaSetupKey(profile.identity.personId, service.origin, workspaceId)
    expect(JSON.parse((await localDb.readLocal(key))!).stage).toBe("enroll")
  }
})

it("Given Rusty enrollment loses its reply, when setup retries, then reuse the exact persisted scope and credentials", async () => {
  const service = await serviceFixture()
  const profile = await bootstrapIdentity("Board setup retry")
  remote.approve.mockRejectedValueOnce(new Error("approval reply lost"))

  await expect(ensureWorkspaceReplicaConnection(service, workspaceId, profile, () => {})).rejects.toThrow("reply lost")
  const key = await workspaceReplicaSetupKey(profile.identity.personId, service.origin, workspaceId)
  const pendingRaw = await localDb.readLocal(key)
  expect(pendingRaw).not.toBeNull()
  const pendingConfig = (JSON.parse(pendingRaw!) as { config: BlindReplicaConfig }).config
  expect(pendingConfig.minimumWriterVersion).toBe(2)
  expect(await getReplicaConfigurations(profile.identity.personId)).toEqual([])

  approveAndConfirm(service)
  const result = await ensureWorkspaceReplicaConnection(service, workspaceId, profile, () => {})
  expect(remote.approve.mock.calls.map(([config]) => config)).toEqual([pendingConfig, pendingConfig])
  expect(remote.approve.mock.calls.map(([, , , options]) => options)).toEqual([
    expect.objectContaining({ minimumWriterVersion: 2 }), expect.objectContaining({ minimumWriterVersion: 2 }),
  ])
  expect(result).toMatchObject({ ...pendingConfig, policyRevision: 2 })
  expect(await localDb.readLocal(key)).toBeNull()
})

it("Given signed approval is received but activation intent cannot be saved, then retain the setup and leave preferences untouched", async () => {
  const service = await serviceFixture()
  const profile = await bootstrapIdentity("Activation intent failure")
  approveAndConfirm(service)
  const key = await workspaceReplicaSetupKey(profile.identity.personId, service.origin, workspaceId)
  const approve = remote.approve.getMockImplementation()!
  let setupBeforeCallback: string | null | undefined
  remote.approve.mockImplementation(async (...args) => {
    setupBeforeCallback = await localDb.readLocal(key)
    return approve(...args)
  })
  const compareAndSwap = localDb.compareAndSwapLocal.bind(localDb)
  const fault = vi.spyOn(localDb, "compareAndSwapLocal").mockImplementation(async (plan, ensureCurrent) => {
    const activation = plan.writes.some(write => write.key === key && typeof write.value === "string" &&
      (JSON.parse(write.value) as { stage?: string }).stage === "activate")
    if (activation) return false
    return compareAndSwap(plan, ensureCurrent)
  })

  await expect(ensureWorkspaceReplicaConnection(service, workspaceId, profile, () => {})).rejects.toThrow(/activation|intent|changed/i)
  fault.mockRestore()
  expect(await getReplicaConfigurations(profile.identity.personId)).toEqual([])
  expect(await localDb.readLocal(key)).toBe(setupBeforeCallback)
  expect(setupBeforeCallback).not.toBeNull()
  expect(remote.approve).toHaveBeenCalledTimes(1)
})

it("Given activation succeeds, when credentials publish, then clear setup in the same atomic private-state plan", async () => {
  const service = await serviceFixture()
  const profile = await bootstrapIdentity("Atomic activation")
  approveAndConfirm(service)
  const key = await workspaceReplicaSetupKey(profile.identity.personId, service.origin, workspaceId)
  const compareAndSwap = localDb.compareAndSwapLocal.bind(localDb)
  const plans: Array<{ conditions: Array<{ key: string; value: string | null }>; writes: Array<{ key: string; value: string | null }> }> = []
  vi.spyOn(localDb, "compareAndSwapLocal").mockImplementation(async (plan, ensureCurrent) => {
    plans.push(structuredClone(plan))
    return compareAndSwap(plan, ensureCurrent)
  })

  const result = await ensureWorkspaceReplicaConnection(service, workspaceId, profile, () => {})
  const activation = plans.find(plan => plan.writes.some(write => write.key === key && write.value === null) &&
    plan.writes.some(write => write.key === `tincanban.private-replica-state.v2.${profile.identity.personId}`))
  expect(activation).toBeDefined()
  expect(activation!.conditions).toContainEqual(expect.objectContaining({
    key: expect.stringMatching(/^tincanban\.replica-credential-freeze\.v1\./), value: null,
  }))
  expect(await getReplicaConfigurations(profile.identity.personId)).toEqual([result])
  expect(await localDb.readLocal(key)).toBeNull()
})

it("Given enrollment setup is pending, when the service pin changes, then keep the exact saved intent and send no replacement", async () => {
  const service = await serviceFixture()
  const changedService = await serviceFixture()
  const profile = await bootstrapIdentity("Pinned setup")
  remote.approve.mockRejectedValueOnce(new Error("offline"))
  await expect(ensureWorkspaceReplicaConnection(service, workspaceId, profile, () => {})).rejects.toThrow("offline")
  const key = await workspaceReplicaSetupKey(profile.identity.personId, service.origin, workspaceId)
  const before = await localDb.readLocal(key)

  await expect(ensureWorkspaceReplicaConnection({ ...service, servicePublicKey: changedService.servicePublicKey }, workspaceId, profile, () => {}))
    .rejects.toThrow(/pin/i)
  expect(await localDb.readLocal(key)).toBe(before)
  expect(remote.approve).toHaveBeenCalledTimes(1)
})

it("Given identity changes during approval, then retain setup without publishing credentials", async () => {
  const service = await serviceFixture()
  const profile = await bootstrapIdentity("Identity guard")
  let current = true
  remote.approve.mockImplementationOnce(async () => { current = false; return 2 })

  await expect(ensureWorkspaceReplicaConnection(service, workspaceId, profile, () => {
    if (!current) throw new Error("Identity changed")
  })).rejects.toThrow("Identity changed")
  const key = await workspaceReplicaSetupKey(profile.identity.personId, service.origin, workspaceId)
  expect(await localDb.readLocal(key)).not.toBeNull()
  expect(await getReplicaConfigurations(profile.identity.personId)).toEqual([])
})

it("Given a removed workspace connection, when setup is retried, then its tombstone blocks resurrection", async () => {
  const service = await serviceFixture()
  const profile = await bootstrapIdentity("Removed board connection")
  approveAndConfirm(service)
  const config = await ensureWorkspaceReplicaConnection(service, workspaceId, profile, () => {})
  await setReplicaPreference(profile.identity.personId, config, true)
  remote.approve.mockClear()

  await expect(ensureWorkspaceReplicaConnection(service, workspaceId, profile, () => {})).rejects.toThrow(/removed/i)
  expect(remote.approve).not.toHaveBeenCalled()
  expect(await getReplicaConfigurations(profile.identity.personId)).toEqual([])
})

it("Given another scope activates while setup is pending, when retry runs, then preserve both the winner and original pending credentials", async () => {
  const service = await serviceFixture()
  const profile = await bootstrapIdentity("Competing workspace scope")
  remote.approve.mockRejectedValueOnce(new Error("offline"))
  await expect(ensureWorkspaceReplicaConnection(service, workspaceId, profile, () => {})).rejects.toThrow("offline")
  const key = await workspaceReplicaSetupKey(profile.identity.personId, service.origin, workspaceId)
  const pending = (await localDb.readLocal(key))!
  const before = JSON.parse(pending) as { config: BlindReplicaConfig }
  const competing = { ...before.config, scopeId: "competing-scope" }
  await setReplicaPreference(profile.identity.personId, competing)

  await expect(ensureWorkspaceReplicaConnection(service, workspaceId, profile, () => {})).rejects.toThrow(/scope|setup|conflict/i)
  expect(await localDb.readLocal(key)).toBe(pending)
  expect(remote.approve).toHaveBeenCalledTimes(1)
  expect(await getReplicaConfigurations(profile.identity.personId)).toEqual([expect.objectContaining({ scopeId: competing.scopeId })])
})

it("Given a removed scope, when the owner explicitly adds a new connection, then keep the old tombstone and create distinct scope credentials", async () => {
  const service = await serviceFixture()
  const profile = await bootstrapIdentity("Explicit reconnect")
  approveAndConfirm(service)
  const first = await ensureWorkspaceReplicaConnection(service, workspaceId, profile, () => {})
  await setReplicaPreference(profile.identity.personId, first, true)
  const second = await ensureWorkspaceReplicaConnection(service, workspaceId, profile, () => {}, { allowNewScopeAfterRemoval: true })
  expect(second.scopeId).not.toBe(first.scopeId)
  expect(second.contentKey).not.toBe(first.contentKey)
  const wire = await (await import("./privateReplicaRepository")).exportPrivateReplicaState(profile.identity.personId)
  expect(wire.entries.find(entry => entry.scopeId === first.scopeId)?.operations.every(operation => operation.config === null)).toBe(true)
})

it("Given a credential transition is frozen, when explicit Connect starts, then do not read the board or request server policy", async () => {
  const service = await serviceFixture()
  const profile = await bootstrapIdentity("Frozen board Connect")
  const config: BlindReplicaConfig = { purpose: "workspace", workspaceId, origin: service.origin,
    servicePublicKey: service.servicePublicKey, scopeId: "existing-scope", contentKey: "A".repeat(43),
    readToken: "B".repeat(43), writeToken: "C".repeat(43), keyEpoch: 1, policyRevision: 1,
    cursor: 0, lastUploaded: "", minimumWriterVersion: 2 }
  await setReplicaPreference(profile.identity.personId, config)
  await prepareReplicaCredentialFreeze(profile, service.origin, service.servicePublicKey, "revoked-device", () => {})
  const readWorkspaceDoc = vi.fn(async () => ({ id: workspaceId, ownerPersonId: profile.identity.personId }))
  const app = { getCurrentProfile: () => profile, readWorkspaceDoc } as never
  const fetch = vi.fn(async () => { throw new Error("network must not start while frozen") })
  vi.stubGlobal("fetch", fetch)

  await expect(connectWorkspaceReplica(app, service.origin, workspaceId, () => {})).rejects.toThrow(/transition|frozen/i)
  expect(readWorkspaceDoc).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it("Given an active workspace connection becomes frozen, when setup is called directly, then do not reuse or enroll it", async () => {
  const service = await serviceFixture()
  const profile = await bootstrapIdentity("Frozen existing board")
  const config: BlindReplicaConfig = { purpose: "workspace", workspaceId, origin: service.origin,
    servicePublicKey: service.servicePublicKey, scopeId: "existing-scope", contentKey: "A".repeat(43),
    readToken: "B".repeat(43), writeToken: "C".repeat(43), keyEpoch: 1, policyRevision: 1,
    cursor: 0, lastUploaded: "", minimumWriterVersion: 2 }
  await setReplicaPreference(profile.identity.personId, config)
  await prepareReplicaCredentialFreeze(profile, service.origin, service.servicePublicKey, "revoked-device", () => {})
  remote.approve.mockClear()

  await expect(ensureWorkspaceReplicaConnection(service, workspaceId, profile, () => {})).rejects.toThrow(/transition|frozen/i)
  expect(remote.approve).not.toHaveBeenCalled()
  expect(await getReplicaConfigurations(profile.identity.personId)).toMatchObject([expect.objectContaining({ scopeId: config.scopeId })])
})
