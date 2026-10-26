import { beforeEach, expect, test } from "vitest"
import { createRecoverableIdentity } from "@meta-uber/mesh-identity"
import { bootstrapIdentity, resetIdentityStorageForTest, sha256Base64Url, signEnvelope } from "../domain/identity"
import { parseBoardStorageAccess } from "../domain/boardStorageAccess"
import { parseReplicaConfig } from "../sync/blindReplicaConfig"
import { verifyRetainedOwnerStorage } from "./ownerReconnectFlow"

const token = (byte: number) => Buffer.alloc(32, byte).toString("base64url")
const workspaceId = "legacy-board"

beforeEach(() => resetIdentityStorageForTest())

async function fixture() {
  const owner = await bootstrapIdentity("Legacy owner")
  const scopeAuthoritySnapshot = { genesis: await signEnvelope(owner.privateKeys.devicePrivateKey!, {
    kind: "scope-genesis", version: 1, scopeId: workspaceId,
    creator: { personId: owner.identity.personId, publicKey: owner.identity.publicKey, certificates: [owner.certificate] }, controlEpoch: 1,
  }, owner.device.deviceId), grants: [], grantIssuers: [], revocations: [], controlTransfers: [] }
  const authority = {
    version: 1, workspaceId, ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate], epoch: 1, updatedAt: "", transportSecret: token(7), scopeAuthoritySnapshot,
    catalog: { deviceRevocations: [] },
  }
  const baseConfig = parseReplicaConfig(JSON.stringify({ purpose: "workspace", origin: "https://rusty.example",
    scopeId: token(8), workspaceId, servicePublicKey: token(9), readToken: token(4), writeToken: token(4),
    keyEpoch: 1, contentKey: token(3), policyRevision: 1, cursor: 0, lastUploaded: "" }))
  const connection = Object.fromEntries(Object.entries(baseConfig)
    .filter(([key]) => !["boardAccess", "writeToken", "cursor", "lastUploaded", "preferenceRevision"].includes(key)))
  const authorization = await signEnvelope(owner.privateKeys.devicePrivateKey!, {
    kind: "workspace-rusty-access", version: 1 as const, workspaceId, ownerPersonId: owner.identity.personId,
    connection, writeTokenHash: await sha256Base64Url(new TextEncoder().encode(baseConfig.writeToken)),
  }, owner.device.deviceId)
  const access = parseBoardStorageAccess({ mode: "write", authorization, certificates: [owner.certificate] })
  const config = parseReplicaConfig(JSON.stringify({ ...baseConfig, boardAccess: access }))
  const board = { authority, role: "visitor" } as Parameters<typeof verifyRetainedOwnerStorage>[2]
  return { owner, authority, access, config, board, baseConfig, connection }
}

test("Given retained v1 owner access, when its signed connection maps to current workspace scope, then accept even read-only participant role", async () => {
  const { access, config, board } = await fixture()

  await expect(verifyRetainedOwnerStorage(config, access, board, workspaceId)).resolves.toBeUndefined()
})

test("Given a v1 owner signature, when retained writer token changes, then reject token binding", async () => {
  const { access, board, baseConfig } = await fixture()
  const config = parseReplicaConfig(JSON.stringify({ ...baseConfig, writeToken: token(5), boardAccess: access }))

  await expect(verifyRetainedOwnerStorage(config, access, board, workspaceId)).rejects.toThrow(/token binding/i)
})

test("Given a foreign device envelope, when it claims current owner, then reject its signer chain", async () => {
  const { owner, config, board, connection } = await fixture()
  const foreign = (await createRecoverableIdentity("better", "Foreign signer")).profile
  const authorization = await signEnvelope(foreign.privateKeys.devicePrivateKey!, {
    kind: "workspace-rusty-access", version: 1 as const, workspaceId, ownerPersonId: owner.identity.personId,
    connection, writeTokenHash: await sha256Base64Url(new TextEncoder().encode(config.writeToken)),
  }, foreign.device.deviceId)
  const forged = parseBoardStorageAccess({ mode: "write", authorization, certificates: [foreign.certificate] })

  await expect(verifyRetainedOwnerStorage(config, forged, board, workspaceId)).rejects.toThrow()
})

test("Given a valid old owner envelope, when its signing device is revoked, then reject it", async () => {
  const { owner, access, config, board } = await fixture()
  const revokedAuthority = { ...board.authority, catalog: { deviceRevocations: [{ record: { payload: {
    personId: owner.identity.personId, deviceId: owner.device.deviceId,
  }, signature: token(6) } }] } }
  const revokedBoard = { ...board, authority: revokedAuthority }

  await expect(verifyRetainedOwnerStorage(config, access, revokedBoard, workspaceId)).rejects.toThrow(/signature or token binding/i)
})
