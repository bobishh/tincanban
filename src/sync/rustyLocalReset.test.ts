import { afterEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, toBase64Url } from "../domain/identity"
import * as local from "../localDb"
import type { BlindReplicaConfig } from "./blindReplication"
import { exportPrivateReplicaState, getPrivateReplicaConfigurations, receivePrivateReplicaState, setReplicaPreference } from "./privateReplicaRepository"
import { prepareReplicaCredentialFreeze, readReplicaCredentialFreeze, replicaCredentialFreezeKey } from "./replicaCredentialFreeze"
import { identityReplicaSetupKey } from "./identityReplicaConnection"
import { workspaceReplicaSetupKey } from "./workspaceReplicaConnection"
import { connectWorkspaceReplica } from "./replicaConnections"
import { stateKey } from "./privateReplicaRepositoryState"
import { RustyManagementRepository } from "./rustyManagementRepository"
const membership = vi.hoisted(() => ({ role: vi.fn(async () => "owner"), admission: vi.fn(async () => ({})) }))
vi.mock("./changeAuthorization", () => ({ workspaceRole: membership.role, localWorkspaceAdmissionAuthority: membership.admission }))
import { forgetRustyOrigin } from "./rustyLocalReset"

afterEach(() => { resetIdentityStorageForTest(); vi.restoreAllMocks(); membership.role.mockReset().mockResolvedValue("owner"); membership.admission.mockReset().mockResolvedValue({}) })

async function resetArchiveKeys(owner: string): Promise<string[]> {
  const keys = (await local.listLocalKeys()).filter(key => key.startsWith("tincanban.rusty-local-reset.v1."))
  const records = await Promise.all(keys.map(async key => ({ key, owner: JSON.parse((await local.readLocal(key))!).personId as string })))
  return records.filter(record => record.owner === owner).map(record => record.key)
}

it("Given a device removal spanning two servers, when one Rusty origin is forgotten, then archive its exact job and retain only the other server and workspace intent", async () => {
  const f = await fixture()
  const key = `tincanban.my-device-removals.v1.${f.owner}`
  const job = { version: 1, personId: f.owner, signerDeviceId: f.profile.device.deviceId, deviceId: "former-device", name: "Old device",
    workspaces: { "other-board": "pending" }, origins: { [f.config.origin]: { status: "pending", error: "Old storage epoch" }, [f.other.origin]: { status: "pending" } } }
  const raw = JSON.stringify([job])
  await local.writeLocal(key, raw)
  await forgetRustyOrigin(f.app as never, f.config.origin, f.config.workspaceId, () => {})
  expect(JSON.parse((await local.readLocal(key))!)).toEqual([{ ...job, origins: { [f.other.origin]: { status: "pending" } } }])
  const archives = await resetArchiveKeys(f.owner)
  const audit = JSON.parse((await local.readLocal(archives.at(-1)!))!) as { records: Array<{ key: string; value: string | null }> }
  expect(audit.records).toContainEqual({ key, value: raw })
})

it("Given a newer device removal is saved during reset, when its CAS commits, then retain the newer job and reject the entire reset", async () => {
  const f = await fixture()
  const key = `tincanban.my-device-removals.v1.${f.owner}`
  const native = local.compareAndSwapLocal
  vi.spyOn(local, "compareAndSwapLocal").mockImplementationOnce(async (plan, guard) => {
    await local.writeLocal(key, "newer removal evidence")
    return native(plan, guard)
  })
  await expect(forgetRustyOrigin(f.app as never, f.config.origin, f.config.workspaceId, () => {})).rejects.toThrow(/changed|retry/i)
  expect(await local.readLocal(key)).toBe("newer removal evidence")
  expect(await readReplicaCredentialFreeze(f.owner, f.config.origin)).toEqual(f.frozen)
})

async function fixture() {
  const profile = await bootstrapIdentity("Reset owner")
  const config: BlindReplicaConfig = { purpose: "workspace", workspaceId: "board-reset", origin: "https://rusty.example",
    scopeId: "old-scope", servicePublicKey: "A".repeat(43), keyEpoch: 1, policyRevision: 1,
    contentKey: toBase64Url(new Uint8Array(32).fill(1)), readToken: toBase64Url(new Uint8Array(32).fill(2)), writeToken: toBase64Url(new Uint8Array(32).fill(3)), cursor: 0, lastUploaded: "" }
  const owner = profile.identity.personId
  await setReplicaPreference(owner, config)
  const { workspaceId: workspace, ...privateConfig } = config
  expect(workspace).toBe(config.workspaceId)
  await setReplicaPreference(owner, { ...privateConfig, purpose: "identity", personId: owner, scopeId: "old-profile" })
  const other = { ...config, origin: "https://other.example", scopeId: "other-scope" }
  await setReplicaPreference(owner, other)
  const old = await exportPrivateReplicaState(owner)
  const frozen = await prepareReplicaCredentialFreeze(profile, config.origin, config.servicePublicKey, "former-device", () => {})
  const freezeKey = await replicaCredentialFreezeKey(owner, config.origin)
  const journalKey = freezeKey.replace("replica-credential-freeze", "replica-credential-transition")
  const journalRaw = JSON.stringify({ freeze: frozen, originalEvidence: "retained" })
  await local.writeLocal(journalKey, journalRaw)
  const boardSetupKey = await workspaceReplicaSetupKey(owner, config.origin, config.workspaceId)
  const profileSetupKey = await identityReplicaSetupKey(owner, config.origin)
  await local.writeLocal(boardSetupKey, JSON.stringify({ personId: owner, config }))
  await local.writeLocal(profileSetupKey, JSON.stringify({ personId: owner, config: { ...privateConfig, purpose: "identity", personId: owner, scopeId: "old-profile" } }))
  const app = { getCurrentProfile: () => profile, getWorkspaceRole: vi.fn(async () => await membership.role()),
    readWorkspaceDoc: vi.fn(async () => ({ id: config.workspaceId, ownerPersonId: owner })) }
  return { profile, config, owner, other, old, frozen, freezeKey, journalKey, journalRaw, boardSetupKey, profileSetupKey, app }
}

it("Given a frozen server and another origin, When its owner explicitly forgets it, Then tombstone its board and profile connections, archive exact intent, and preserve browser data", async () => {
  const f = await fixture()
  const profileRaw = await local.readLocal("tincanban.local_profile.v1")
  await local.writeLocal("board-document-reset-proof", "board and attachment bytes")
  await forgetRustyOrigin(f.app as never, f.config.origin, f.config.workspaceId, () => {})
  expect(await getPrivateReplicaConfigurations(f.owner)).toMatchObject([f.other])
  expect(await readReplicaCredentialFreeze(f.owner, f.config.origin)).toBeUndefined()
  for (const key of [f.journalKey, f.boardSetupKey, f.profileSetupKey]) expect(await local.readLocal(key)).toBeNull()
  const archives = await resetArchiveKeys(f.owner)
  expect(archives).toHaveLength(1)
  const audit = JSON.parse((await local.readLocal(archives[0]!))!) as { records: Array<{ key: string; value: string | null }> }
  expect(audit.records).toContainEqual({ key: f.journalKey, value: f.journalRaw })
  expect(audit.records).toContainEqual({ key: f.freezeKey, value: JSON.stringify(f.frozen) })
  expect(await local.readLocal("tincanban.local_profile.v1")).toBe(profileRaw)
  expect(await local.readLocal("board-document-reset-proof")).toBe("board and attachment bytes")
  await receivePrivateReplicaState(f.owner, f.old)
  expect(await getPrivateReplicaConfigurations(f.owner)).toMatchObject([f.other])
})

it("Given unavailable current board admission, When forgetting an origin is requested, Then reject before touching saved credentials", async () => {
  const f = await fixture()
  membership.admission.mockRejectedValueOnce(new Error("Current membership unavailable"))
  await expect(forgetRustyOrigin(f.app as never, f.config.origin, f.config.workspaceId, () => {})).rejects.toThrow(/membership/i)
  expect(await readReplicaCredentialFreeze(f.owner, f.config.origin)).toEqual(f.frozen)
})

it("Given journal bytes change before reset commits, When the captured transaction publishes, Then retain newer intent and every active connection", async () => {
  const f = await fixture()
  const native = local.compareAndSwapLocal
  vi.spyOn(local, "compareAndSwapLocal").mockImplementationOnce(async (plan, guard) => {
    await local.writeLocal(f.journalKey, "newer journal")
    return native(plan, guard)
  })
  await expect(forgetRustyOrigin(f.app as never, f.config.origin, f.config.workspaceId, () => {})).rejects.toThrow(/changed|retry/i)
  expect(await local.readLocal(f.journalKey)).toBe("newer journal")
  expect(await readReplicaCredentialFreeze(f.owner, f.config.origin)).toEqual(f.frozen)
  expect(await getPrivateReplicaConfigurations(f.owner)).toHaveLength(3)
})

it("Given an admitted editor, When forgetting its own local bindings, Then clear local access without contacting the server", async () => {
  const f = await fixture()
  membership.role.mockResolvedValueOnce("editor")
  await forgetRustyOrigin(f.app as never, f.config.origin, f.config.workspaceId, () => {})
  expect(await getPrivateReplicaConfigurations(f.owner)).toMatchObject([f.other])
  membership.role.mockResolvedValue("editor")
  await expect(connectWorkspaceReplica(f.app as never, f.config.origin, f.config.workspaceId, () => {})).rejects.toThrow(/owner/i)
})

it.each(["other-origin-only", "missing-v2"])('Given origin-bound frozen intent with %s private state, When forgetting Rusty, Then archive exact intent and prevent stale peer resurrection', async state => {
  const f = await fixture()
  const key = stateKey(f.owner), raw = (await local.readLocal(key))!
  if (state === "missing-v2") await local.deleteLocal(key)
  else await local.writeLocal(key, JSON.stringify({ ...JSON.parse(raw), entries: JSON.parse(raw).entries.filter((entry: { origin: string }) => entry.origin !== f.config.origin) }))
  for (const setup of [f.boardSetupKey, f.profileSetupKey]) await local.deleteLocal(setup)
  const profileRaw = await local.readLocal("tincanban.local_profile.v1")
  await forgetRustyOrigin(f.app as never, f.config.origin, f.config.workspaceId, () => {})
  expect(await readReplicaCredentialFreeze(f.owner, f.config.origin)).toBeUndefined()
  expect(await local.readLocal(f.journalKey)).toBeNull()
  const archives = await resetArchiveKeys(f.owner)
  const audit = JSON.parse((await local.readLocal(archives.at(-1)!))!) as { records: Array<{ key: string; value: string | null }> }
  expect(audit.records).toContainEqual({ key: f.freezeKey, value: JSON.stringify(f.frozen) })
  expect(audit.records).toContainEqual({ key: f.journalKey, value: f.journalRaw })
  expect(await local.readLocal("tincanban.local_profile.v1")).toBe(profileRaw)
  expect(await getPrivateReplicaConfigurations(f.owner)).toMatchObject(state === "missing-v2" ? [] : [f.other])
  await receivePrivateReplicaState(f.owner, f.old)
  expect((await getPrivateReplicaConfigurations(f.owner)).some(config => config.origin === f.config.origin)).toBe(false)
})

it("Given neither connection nor origin-bound intent, When forgetting an unknown server, Then reject without writing an audit or changing other origins", async () => {
  const f = await fixture()
  const before = await local.readLocal(stateKey(f.owner))
  const keys = await local.listLocalKeys()
  await expect(forgetRustyOrigin(f.app as never, "https://unknown.example", f.config.workspaceId, () => {})).rejects.toThrow(/no saved/i)
  expect(await local.readLocal(stateKey(f.owner))).toBe(before)
  expect(await local.listLocalKeys()).toEqual(keys)
})

it("Given only bound board and profile setup intents and no v2 state, When forgetting Rusty, Then tombstone both scopes and retain exact setup evidence", async () => {
  const f = await fixture()
  await local.deleteLocal(stateKey(f.owner))
  for (const key of [f.freezeKey, f.journalKey]) await local.deleteLocal(key)
  const boardSetup = await local.readLocal(f.boardSetupKey)
  await forgetRustyOrigin(f.app as never, f.config.origin, f.config.workspaceId, () => {})
  expect(await local.readLocal(f.boardSetupKey)).toBeNull()
  expect(await local.readLocal(f.profileSetupKey)).toBeNull()
  const archives = await resetArchiveKeys(f.owner)
  const audit = JSON.parse((await local.readLocal(archives.at(-1)!))!) as { records: Array<{ key: string; value: string | null }> }
  expect(audit.records).toContainEqual({ key: f.boardSetupKey, value: boardSetup })
  await receivePrivateReplicaState(f.owner, f.old)
  expect((await getPrivateReplicaConfigurations(f.owner)).filter(config => config.origin === f.config.origin)).toEqual([])
})

it("Given only signed origin management evidence and no active scopes, When forgetting Rusty, Then archive authority and require direct observation before replay", async () => {
  const f = await fixture()
  for (const key of [stateKey(f.owner), f.freezeKey, f.journalKey, f.boardSetupKey, f.profileSetupKey]) await local.deleteLocal(key)
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))
  const serviceId = await sha256Base64Url(publicKey)
  const binding = { origin: f.config.origin, servicePublicKey: toBase64Url(publicKey), resourceKind: "person" as const, resourceId: f.owner }
  const capability = await signEnvelope(keys.privateKey, { kind: "rusty-person-management-capability" as const, version: 1 as const,
    serviceId, origin: binding.origin, personId: f.owner, resourceKind: binding.resourceKind, resourceId: f.owner,
    revision: 4, operations: ["management.update"], revokedDeviceIds: [], requestId: "old-policy",
    authorizationHash: "A".repeat(43), issuedAt: Date.now() }, serviceId, "RUSTY/2")
  const repository = new RustyManagementRepository(f.owner)
  await repository.observe(binding, capability)
  await forgetRustyOrigin(f.app as never, f.config.origin, f.config.workspaceId, () => {})
  await repository.import([{ binding, capability }])
  expect(await repository.read(binding)).toBeUndefined()
  expect(await getPrivateReplicaConfigurations(f.owner)).toEqual([])
})
