import { beforeEach, expect, test, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { BrowserIdentityStore } from "@meta-uber/mesh-identity"
import { parseReplicaConfig } from "./blindReplicaConfig"
import { getReplicaConfigurations, setReplicaPreference, persistPrivateReplicaProgress } from "./privateReplicaRepository"
import { createBoardStorageAccess, receiveBoardStorageAccess, selectBoardStorageAccess } from "./workspaceRustyAccess"
import type { BlindReplicaConfig } from "./blindReplication"
import { withWorkspaceRustyAccess } from "./workspaceRustyExchange"
import type { WorkspaceSetStore } from "./workspaceSet"
import type { PeerStore } from "./peerStore"

const token = (byte: number) => Buffer.alloc(32, byte).toString("base64url")
const config: BlindReplicaConfig = { origin: "https://rusty.example", scopeId: token(1), workspaceId: "board",
  servicePublicKey: token(2), contentKey: token(3), readToken: token(4), writeToken: token(5),
  keyEpoch: 1, policyRevision: 1, minimumWriterVersion: 2, cursor: 93, lastUploaded: token(6) }

beforeEach(() => resetIdentityStorageForTest())

async function fixture() {
  const owner = await bootstrapIdentity()
  const authority = { version: 1 as const, workspaceId: "board", ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], epoch: 1, updatedAt: "", transportSecret: token(7) }
  const access = await createBoardStorageAccess(owner, config, async () => authority, async () => {})
  const recipient = await new BrowserIdentityStore({ storageKey: crypto.randomUUID(), storage: (() => {
    const values = new Map<string, string>()
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) } }
  })() }).bootstrap("Participant")
  return { owner, authority, access, recipient }
}

test("Given different identities, when editor and visitor receive owner-attested storage, then only editor receives writing access and both keep private progress", async () => {
  const { authority, access, recipient } = await fixture()
  const editor = selectBoardStorageAccess(access, config.writeToken, "editor")!
  await receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor", [editor], async () => {})
  const saved = (await getReplicaConfigurations(recipient.identity.personId))[0]!
  expect(saved).toMatchObject({ cursor: 0, lastUploaded: "", writeToken: config.writeToken, boardAccess: { mode: "write" } })
  await persistPrivateReplicaProgress(recipient.identity.personId, { ...saved, cursor: 19, lastUploaded: token(6) }, () => {})
  await receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor", [editor], async () => {})
  expect((await getReplicaConfigurations(recipient.identity.personId))[0]!.cursor).toBe(19)

  const reader = selectBoardStorageAccess(access, config.writeToken, "visitor")!
  expect(JSON.stringify(reader)).not.toContain(config.writeToken)
  expect(reader.writeToken).toBe("")
  expect(parseReplicaConfig(JSON.stringify(reader)).boardAccess?.mode).toBe("read")
  expect(selectBoardStorageAccess(access, "", "editor")).toBeUndefined()
})

test("Given an owner's attestation, when an editor forwards it with owner offline, then another editor verifies and installs it", async () => {
  const { authority, access, recipient } = await fixture()
  const forwarded = selectBoardStorageAccess(access, config.writeToken, "editor")!
  await receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor", [forwarded], async () => {})
  expect((await getReplicaConfigurations(recipient.identity.personId))[0]!.origin).toBe(config.origin)
})

test("Given a forged token, signature, foreign board or revoked session, when received, then no credentials are installed", async () => {
  const { authority, access, recipient } = await fixture()
  const valid = selectBoardStorageAccess(access, config.writeToken, "editor")!
  for (const value of [{ ...valid, writeToken: token(8) }, { ...valid, workspaceId: "foreign" },
    { ...valid, boardAccess: { ...valid.boardAccess!, authorization: { ...valid.boardAccess!.authorization, signature: token(9) } } }]) {
    await expect(receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor", [value], async () => {})).rejects.toThrow()
  }
  await expect(receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor", [valid], async () => {
    throw new Error("revoked")
  })).rejects.toThrow("revoked")
  expect(await getReplicaConfigurations(recipient.identity.personId)).toEqual([])
})

test("Given current credentials, when an older policy or changed same-revision attestation arrives, then retain current storage", async () => {
  const { owner, authority, access, recipient } = await fixture()
  const newerConfig = { ...config, policyRevision: 2 }
  const newerAccess = await createBoardStorageAccess(owner, newerConfig, async () => authority, async () => {})
  const newer = selectBoardStorageAccess(newerAccess, config.writeToken, "editor")!
  await receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor", [newer], async () => {})
  await receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor",
    [selectBoardStorageAccess(access, config.writeToken, "editor")!], async () => {})
  const changed = await createBoardStorageAccess(owner, { ...newerConfig, contentKey: token(10) }, async () => authority, async () => {})
  await expect(receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor",
    [selectBoardStorageAccess(changed, config.writeToken, "editor")!], async () => {})).rejects.toThrow(/revision/i)
  expect((await getReplicaConfigurations(recipient.identity.personId))[0]!.policyRevision).toBe(2)
})

test("Given a visitor grant, when writing credentials arrive, then reject rather than persist a capability above the current role", async () => {
  const { authority, access, recipient } = await fixture()
  await expect(receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "visitor",
    [selectBoardStorageAccess(access, config.writeToken, "editor")!], vi.fn(async () => {}))).rejects.toThrow()
  expect(await getReplicaConfigurations(recipient.identity.personId)).toEqual([])
})

test("Given a privately configured owner connection, when recipient sharing runs, then the owner record is never replaced", async () => {
  const { owner, authority, access } = await fixture()
  await setReplicaPreference(owner.identity.personId, config)
  await receiveBoardStorageAccess(owner.identity.personId, "board", authority, "owner",
    [selectBoardStorageAccess(access, config.writeToken, "editor")!], async () => {})
  expect((await getReplicaConfigurations(owner.identity.personId))[0]!.boardAccess).toBeUndefined()
})

test("Given a live authorized visitor session, when mesh metadata publishes after owner adds Rusty, then transfer only this board's reading capability", async () => {
  const { owner, authority, recipient } = await fixture()
  await setReplicaPreference(owner.identity.personId, config)
  await setReplicaPreference(owner.identity.personId, { ...config, workspaceId: "other-board", scopeId: token(22) })
  const guard = vi.fn(async () => {})
  const peers = { getWorkspaceCredential: async () => authority,
    getPeer: async () => ({ personId: recipient.identity.personId, role: "visitor" }) } as unknown as PeerStore
  const sender = withWorkspaceRustyAccess({ readMesh: async () => ({ version: 1, peers: [] }) } as unknown as WorkspaceSetStore,
    { workspaceId: "board", profile: owner, remotePersonId: recipient.identity.personId, remoteDeviceId: recipient.device.deviceId, peers, guard })
  const packet = await sender.readMesh!("board") as { boardStorageAccess: BlindReplicaConfig[] }
  expect(packet.boardStorageAccess).toHaveLength(1)
  expect(packet.boardStorageAccess[0]!.writeToken).toBe("")
  expect(JSON.stringify(packet)).not.toContain(config.writeToken)
  expect(JSON.stringify(packet)).not.toContain("other-board")
  expect(packet).not.toHaveProperty("identityDevicePreferences")
  const mergeMesh = vi.fn(async () => {})
  const receiver = withWorkspaceRustyAccess({ mergeMesh } as unknown as WorkspaceSetStore,
    { workspaceId: "board", profile: recipient, remotePersonId: owner.identity.personId, remoteDeviceId: owner.device.deviceId,
      peers: { getWorkspaceCredential: async () => ({ ...authority, localGrant: { payload: { role: "visitor" } } }) } as unknown as PeerStore, guard })
  await receiver.mergeMesh!("board", packet)
  expect(mergeMesh).toHaveBeenCalledWith("board", { version: 1, peers: [] })
  expect((await getReplicaConfigurations(recipient.identity.personId))[0]!.boardAccess?.mode).toBe("read")
  await expect(sender.readMesh!("other-board")).rejects.toThrow("workspace")
})

test("Given a removed connection tombstone, when a peer replays earlier access, then do not resurrect that connection", async () => {
  const { authority, access, recipient } = await fixture()
  const connection = selectBoardStorageAccess(access, config.writeToken, "editor")!
  const personId = recipient.identity.personId
  await receiveBoardStorageAccess(personId, "board", authority, "editor", [connection], async () => {})
  await setReplicaPreference(personId, (await getReplicaConfigurations(personId))[0]!, true)
  await receiveBoardStorageAccess(personId, "board", authority, "editor", [connection], async () => {})
  expect(await getReplicaConfigurations(personId)).toEqual([])
})

test("Given an editor changed to visitor, when read access arrives, then remove the stored writing capability", async () => {
  const { authority, access, recipient } = await fixture()
  await receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor",
    [selectBoardStorageAccess(access, config.writeToken, "editor")!], async () => {})
  await receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "visitor",
    [selectBoardStorageAccess(access, config.writeToken, "visitor")!], async () => {})
  expect((await getReplicaConfigurations(recipient.identity.personId))[0]!.writeToken).toBe("")
})

test("Given legacy identical reading and writing tokens, when owner prepares participant sharing, then require separate tokens before disclosure", async () => {
  const { owner, authority } = await fixture()
  await expect(createBoardStorageAccess(owner, { ...config, writeToken: config.readToken }, async () => authority, async () => {}))
    .rejects.toThrow(/separate/i)
})
