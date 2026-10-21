import { afterEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, toBase64Url } from "../domain/identity"
import * as local from "../localDb"
import type { BlindReplicaConfig } from "./blindReplication"
import { exportPrivateReplicaState, getPrivateReplicaConfigurations, receivePrivateReplicaState, setReplicaPreference } from "./privateReplicaRepository"
import { prepareReplicaCredentialFreeze, readReplicaCredentialFreeze, replicaCredentialFreezeKey } from "./replicaCredentialFreeze"
import { identityReplicaSetupKey } from "./identityReplicaConnection"
import { workspaceReplicaSetupKey } from "./workspaceReplicaConnection"
import { connectWorkspaceReplica } from "./replicaConnections"
const membership = vi.hoisted(() => ({ role: vi.fn(async () => "owner"), admission: vi.fn(async () => ({})) }))
vi.mock("./changeAuthorization", () => ({ workspaceRole: membership.role, localWorkspaceAdmissionAuthority: membership.admission }))
import { forgetRustyOrigin } from "./rustyLocalReset"

afterEach(() => { resetIdentityStorageForTest(); vi.restoreAllMocks(); membership.role.mockReset().mockResolvedValue("owner"); membership.admission.mockReset().mockResolvedValue({}) })

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
  await local.writeLocal(profileSetupKey, JSON.stringify({ personId: owner, config: { ...config, purpose: "identity" } }))
  const app = { getCurrentProfile: () => profile, readWorkspaceDoc: vi.fn(async () => ({ id: config.workspaceId, ownerPersonId: owner })) }
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
  const archives = (await local.listLocalKeys()).filter(key => key.startsWith("tincanban.rusty-local-reset.v1."))
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
  f.app.readWorkspaceDoc.mockResolvedValue({ id: f.config.workspaceId, ownerPersonId: "different-board-owner" })
  await expect(connectWorkspaceReplica(f.app as never, f.config.origin, f.config.workspaceId, () => {})).rejects.toThrow(/owner/i)
})
