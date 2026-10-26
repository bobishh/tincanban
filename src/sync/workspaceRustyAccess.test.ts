import { beforeEach, expect, test, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, sha256Base64Url, signEnvelope } from "../domain/identity"
import { adoptApprovedApplicationDevice } from "../domain/identity"
import { BrowserIdentityStore, createDeviceAuthorizationApproval, createDeviceAuthorizationRequest, createIdentityAuthorityView,
  createDeviceRevocation, createRecoverableIdentity, issueDeviceAuthorization, publicKeyId, verifyIdentityDeviceAuthority } from "@meta-uber/mesh-identity"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import * as rustyPrincipalClient from "@meta-uber/mesh-replication/rusty-principal-grant"
import { createPeerAdvertisement, createWorkspaceDeviceRevocation } from "@meta-uber/mesh-workspace"
import { createWorkspaceGrant } from "../domain/proofs"
import * as rustyTransport from "./rustyIdentityTransport"
import { parseReplicaConfig } from "./blindReplicaConfig"
import { getReplicaConfigurations, setReplicaPreference, persistPrivateReplicaProgress } from "./privateReplicaRepository"
import { createBoardStorageAccess, receiveBoardStorageAccess, selectBoardStorageAccess } from "./workspaceRustyAccess"
import type { BlindReplicaConfig } from "./blindReplication"
import { withWorkspaceRustyAccess } from "./workspaceRustyExchange"
import type { WorkspaceSetStore } from "./workspaceSet"
import type { PeerStore } from "./peerStore"
import { createPersonalRoot } from "../domain/personalRoot"
import { rootIdentityProfileState } from "../domain/identityProfileRoot"
import { certHashDefault } from "../domain/proofs"
import { mergeIdentityAuthorityView } from "./identityAuthorityStore"
import type { WorkspaceGrant } from "../domain/model"

const token = (byte: number) => Buffer.alloc(32, byte).toString("base64url")
const config: BlindReplicaConfig = { origin: "https://rusty.example", scopeId: token(1), workspaceId: "board",
  servicePublicKey: token(2), contentKey: token(3), readToken: token(4), writeToken: token(5),
  keyEpoch: 1, policyRevision: 1, minimumWriterVersion: 2, cursor: 93, lastUploaded: token(6) }

beforeEach(() => { vi.restoreAllMocks(); resetIdentityStorageForTest() })

async function fixture() {
  const owner = await bootstrapIdentity()
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  const authorityView = await createIdentityAuthorityView(owner.identity,
    { certificates: [owner.certificate], revocations: [] }, await rootIdentityProfileState(root))
  await mergeIdentityAuthorityView(authorityView)
  const scopeAuthoritySnapshot = { genesis: await signEnvelope(owner.privateKeys.devicePrivateKey!, { kind: "scope-genesis", version: 1,
    scopeId: "board", creator: { personId: owner.identity.personId, publicKey: owner.identity.publicKey,
      certificates: [owner.certificate] }, controlEpoch: 1 }, owner.device.deviceId), grants: [], grantIssuers: [], revocations: [], controlTransfers: [] }
  const authority = { version: 1 as const, workspaceId: "board", ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], epoch: 1, updatedAt: "", transportSecret: token(7),
    scopeAuthoritySnapshot }
  vi.spyOn(rustyTransport, "ensureRustyWorkspaceScopeAuthority").mockImplementation(async (_profile, _access, snapshot) => ({
    workspaceId: "board", controllerPersonId: owner.identity.personId, controllerPublicKey: owner.identity.publicKey,
    controlEpoch: 1, snapshot: structuredClone(snapshot),
  }))
  const registerGrant = vi.spyOn(rustyPrincipalClient, "registerRustyResourcePrincipalGrant").mockImplementation(async options => {
    const role = options.workspaceGrant.payload.role
    const actions: ("read" | "write")[] = role === "visitor" ? ["read"] : ["read", "write"]
    const payload = { kind: "rusty-resource-principal-grant" as const, version: 1 as const,
      serviceId: await publicKeyId(options.servicePublicKey), origin: options.origin, workspaceId: options.workspaceId,
      resourceKind: "scope" as const, resourceId: options.storageScopeId, scopeId: options.storageScopeId,
      ownerPersonId: options.identity.personId, subjectPersonId: options.subjectIdentity.personId,
      subjectPublicKey: options.subjectIdentity.publicKey, grantId: options.workspaceGrant.payload.grantId,
      policyEpoch: options.workspaceGrant.payload.accessEpoch ?? 1,
      readTokenHash: await sha256Base64Url(new TextEncoder().encode(options.readToken)),
      ...(role !== "visitor" ? { writeTokenHash: await sha256Base64Url(new TextEncoder().encode(options.writeToken!)) } : {}),
      actions: [...actions], workspaceGrant: options.workspaceGrant,
      scopeAuthority: structuredClone(options.expectedScopeAuthoritySnapshot) }
    const principalGrant = await options.signAuthorization(payload)
    return { principalGrant, scopeAuthority: options.validateSnapshot(options.expectedScopeAuthoritySnapshot) }
  })
  const recipient = await new BrowserIdentityStore({ storageKey: crypto.randomUUID(), storage: (() => {
    const values = new Map<string, string>()
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) } }
  })() }).bootstrap("Participant")
  const createAccess = async (subject: typeof recipient, role: "owner" | "editor" | "visitor", selectedConfig = config) => {
    const grant = await createWorkspaceGrant(owner, "board", subject.identity.personId, role, 1)
    return { grant, access: await createBoardStorageAccess(owner, selectedConfig, grant, subject.identity.publicKey,
      async () => authority, async () => {}) }
  }
  const created = await createAccess(recipient, "editor")
  return { owner, authority, recipient, createAccess, registerGrant, ...created }
}

async function formerOwnerAppGrantFixture() {
  const owner = (await createRecoverableIdentity("better", "Bo")).profile
  const formerApp = (await createRecoverableIdentity("better", "Former app")).profile
  const currentCandidate = await bootstrapIdentity("Current app")
  const applicationOrigin = "https://boards.example"
  const formerChallenge = "a".repeat(64)
  const currentChallenge = "b".repeat(64)
  const expiresAt = Date.now() + 90_000
  const formerRequest = await createDeviceAuthorizationRequest(formerApp, { applicationOrigin,
    challenge: formerChallenge, expiresAt })
  const formerCertificate = await issueDeviceAuthorization(owner, formerRequest,
    { applicationOrigin, challenge: formerChallenge })
  const currentRequest = await createDeviceAuthorizationRequest(currentCandidate, { applicationOrigin,
    challenge: currentChallenge, expiresAt })
  const currentApproval = await createDeviceAuthorizationApproval(owner, currentRequest, {
    applicationOrigin, challenge: currentChallenge, certificates: [owner.certificate],
  })
  const current = await adoptApprovedApplicationDevice(currentApproval, currentRequest, currentCandidate)
  const certificates = [owner.certificate, formerCertificate, current.certificate]
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  const view = await createIdentityAuthorityView(owner.identity, { certificates, revocations: [] }, await rootIdentityProfileState(root))
  await mergeIdentityAuthorityView(view)
  const scopeAuthoritySnapshot = { genesis: await signEnvelope(owner.privateKeys.devicePrivateKey!, {
    kind: "scope-genesis", version: 1, scopeId: "board",
    creator: { personId: owner.identity.personId, publicKey: owner.identity.publicKey, certificates }, controlEpoch: 1,
  }, owner.device.deviceId), grants: [], grantIssuers: [], revocations: [], controlTransfers: [] }
  const authority = { version: 1 as const, workspaceId: "board", ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: certificates, epoch: 1, updatedAt: "", transportSecret: token(7),
    scopeAuthoritySnapshot }
  vi.spyOn(rustyTransport, "ensureRustyWorkspaceScopeAuthority").mockImplementation(async (_profile, _access, snapshot) => ({
    workspaceId: "board", controllerPersonId: owner.identity.personId, controllerPublicKey: owner.identity.publicKey,
    controlEpoch: 1, snapshot: structuredClone(snapshot),
  }))
  const registerGrant = vi.spyOn(rustyPrincipalClient, "registerRustyResourcePrincipalGrant").mockImplementation(async options => {
    const role = options.workspaceGrant.payload.role
    const actions: ("read" | "write")[] = role === "visitor" ? ["read"] : ["read", "write"]
    const payload = { kind: "rusty-resource-principal-grant" as const, version: 1 as const,
      serviceId: await publicKeyId(options.servicePublicKey), origin: options.origin, workspaceId: options.workspaceId,
      resourceKind: "scope" as const, resourceId: options.storageScopeId, scopeId: options.storageScopeId,
      ownerPersonId: options.identity.personId, subjectPersonId: options.subjectIdentity.personId,
      subjectPublicKey: options.subjectIdentity.publicKey, grantId: options.workspaceGrant.payload.grantId,
      policyEpoch: options.workspaceGrant.payload.accessEpoch ?? 1,
      readTokenHash: await sha256Base64Url(new TextEncoder().encode(options.readToken)),
      ...(role !== "visitor" ? { writeTokenHash: await sha256Base64Url(new TextEncoder().encode(options.writeToken!)) } : {}),
      actions, workspaceGrant: options.workspaceGrant, scopeAuthority: structuredClone(options.expectedScopeAuthoritySnapshot) }
    const principalGrant = await options.signAuthorization(payload)
    return { principalGrant, scopeAuthority: options.validateSnapshot(options.expectedScopeAuthoritySnapshot) }
  })
  const recipient = await new BrowserIdentityStore({ storageKey: crypto.randomUUID(), storage: (() => {
    const values = new Map<string, string>()
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) } }
  })() }).bootstrap("Ray")
  const grantPayload = { kind: "workspace-grant", version: 1, grantId: crypto.randomUUID(), workspaceId: "board",
    personId: recipient.identity.personId, role: "editor", accessEpoch: 7 } satisfies WorkspaceGrant["payload"]
  const grant = await signEnvelope(formerApp.privateKeys.devicePrivateKey, grantPayload, formerApp.device.deviceId)
  return { owner, current, formerApp, authority, certificates, root, recipient, grant, registerGrant }
}

test("Given different identities, when editor and visitor receive owner-attested storage, then only editor receives writing access and both keep private progress", async () => {
  const { authority, access, recipient, createAccess } = await fixture()
  const editor = selectBoardStorageAccess(access, config.writeToken, "editor")!
  await receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor", [editor], async () => {}, recipient.identity.publicKey)
  const saved = (await getReplicaConfigurations(recipient.identity.personId))[0]!
  expect(saved).toMatchObject({ cursor: 0, lastUploaded: "", writeToken: config.writeToken, boardAccess: { mode: "write" } })
  await persistPrivateReplicaProgress(recipient.identity.personId, { ...saved, cursor: 19, lastUploaded: token(6) }, () => {})
  await receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor", [editor], async () => {}, recipient.identity.publicKey)
  expect((await getReplicaConfigurations(recipient.identity.personId))[0]!.cursor).toBe(19)

  const visitor = await createAccess(recipient, "visitor")
  const reader = selectBoardStorageAccess(visitor.access, config.writeToken, "visitor")!
  expect(JSON.stringify(reader)).not.toContain(config.writeToken)
  expect(reader.writeToken).toBe("")
  expect(parseReplicaConfig(JSON.stringify(reader)).boardAccess?.mode).toBe("read")
  expect(selectBoardStorageAccess(access, "", "editor")).toBeUndefined()
})

test("Given an unchanged editor grant signed by another active Bo app device, when current Bo reattests Rusty, then preserve the grant and sign storage access with the current device", async () => {
  const { current, authority, recipient, grant, registerGrant } = await formerOwnerAppGrantFixture()
  expect(current.identity.personId).toBe(authority.ownerPersonId)
  expect(current.device.deviceId).not.toBe(grant.signerKeyId)

  const access = await createBoardStorageAccess(current, config, grant, recipient.identity.publicKey,
    async () => authority, async () => {})

  expect(access.authorization.payload.workspaceGrant).toEqual(grant)
  expect(access.authorization.payload).toMatchObject({ subjectPersonId: recipient.identity.personId,
    subjectPublicKey: recipient.identity.publicKey, grantId: grant.payload.grantId, policyEpoch: 7, actions: ["read", "write"] })
  expect(access.authorization.signerKeyId).toBe(current.device.deviceId)
  expect(access.principalGrant?.signerKeyId).toBe(current.device.deviceId)
  expect(registerGrant).toHaveBeenCalledWith(expect.objectContaining({ deviceId: current.device.deviceId,
    devicePublicKey: current.device.publicKey, workspaceGrant: grant, subjectIdentity: {
      personId: recipient.identity.personId, publicKey: recipient.identity.publicKey, displayName: "",
    } }))
})

test("Given a revoked former Bo device, when its old workspace grant is presented, then refuse reattestation before Rusty registration", async () => {
  const { owner, current, formerApp, authority, certificates, root, recipient, grant, registerGrant } = await formerOwnerAppGrantFixture()
  const evidence = await verifyIdentityDeviceAuthority(owner.identity, { certificates, revocations: [] })
  const revocation = await createDeviceRevocation(owner, evidence, formerApp.device.deviceId, await rootIdentityProfileState(root))
  const revokedView = await createIdentityAuthorityView(owner.identity, { certificates, revocations: [revocation] },
    await rootIdentityProfileState(root))
  await mergeIdentityAuthorityView(revokedView)

  await expect(createBoardStorageAccess(current, config, grant, recipient.identity.publicKey,
    async () => authority, async () => {})).rejects.toThrow(/revoked/i)
  expect(registerGrant).not.toHaveBeenCalled()
})

test("Given a verified grant authority that is revoked locally during Rusty setup, when reattesting, then abort before principal registration", async () => {
  const { owner, current, formerApp, authority, certificates, root, recipient, grant, registerGrant } = await formerOwnerAppGrantFixture()
  const evidence = await verifyIdentityDeviceAuthority(owner.identity, { certificates, revocations: [] })
  const revocation = await createDeviceRevocation(owner, evidence, formerApp.device.deviceId, await rootIdentityProfileState(root))
  const revokedView = await createIdentityAuthorityView(owner.identity, { certificates, revocations: [revocation] },
    await rootIdentityProfileState(root))
  vi.mocked(rustyTransport.ensureRustyWorkspaceScopeAuthority).mockImplementation(async (_profile, _access, snapshot) => {
    await mergeIdentityAuthorityView(revokedView)
    return { workspaceId: "board", controllerPersonId: owner.identity.personId,
      controllerPublicKey: owner.identity.publicKey, controlEpoch: 1, snapshot: structuredClone(snapshot) }
  })

  await expect(createBoardStorageAccess(current, config, grant, recipient.identity.publicKey,
    async () => authority, async () => {})).rejects.toThrow(/identity authority changed/i)
  expect(registerGrant).not.toHaveBeenCalled()
})

test("Given a foreign, forged, or modified former-device grant, when reattesting, then refuse it before Rusty registration", async () => {
  const { current, authority, recipient, grant, registerGrant } = await formerOwnerAppGrantFixture()
  const foreign = (await createRecoverableIdentity("better", "Foreign signer")).profile
  const foreignGrant = await signEnvelope(foreign.privateKeys.devicePrivateKey, grant.payload, foreign.device.deviceId)
  const invalidGrants = [
    { ...grant, signature: token(9) },
    { ...grant, payload: { ...grant.payload, role: "visitor" as const } },
    { ...grant, payload: { ...grant.payload, personId: await publicKeyId(foreign.identity.publicKey) } },
    foreignGrant,
  ]

  for (const invalidGrant of invalidGrants) {
    await expect(createBoardStorageAccess(current, config, invalidGrant, recipient.identity.publicKey,
      async () => authority, async () => {})).rejects.toThrow()
  }
  expect(registerGrant).not.toHaveBeenCalled()
})

test("Given Rusty registration loses its first acknowledgement, when the same grant is retried, then preserve its exact scope", async () => {
  const { current, authority, recipient, grant, registerGrant } = await formerOwnerAppGrantFixture()
  registerGrant.mockRejectedValueOnce(new Error("Lost Rusty registration acknowledgement"))
  const create = () => createBoardStorageAccess(current, config, grant, recipient.identity.publicKey,
    async () => authority, async () => {})

  await expect(create()).rejects.toThrow("Lost Rusty registration acknowledgement")
  const retried = await create()

  expect(registerGrant).toHaveBeenCalledTimes(2)
  expect(registerGrant.mock.calls[0]![0].workspaceGrant).toEqual(grant)
  expect(registerGrant.mock.calls[1]![0].workspaceGrant).toEqual(grant)
  expect(retried.authorization.payload.workspaceGrant).toEqual(grant)
  expect(retried.authorization.payload.actions).toEqual(["read", "write"])
})

test("Given an owner's attestation, when an editor forwards it with owner offline, then another editor verifies and installs it", async () => {
  const { authority, access, recipient } = await fixture()
  const forwarded = selectBoardStorageAccess(access, config.writeToken, "editor")!
  await receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor", [forwarded], async () => {}, recipient.identity.publicKey)
  expect((await getReplicaConfigurations(recipient.identity.personId))[0]!.origin).toBe(config.origin)
})

test("Given a previously accepted storage grant, when scope control transfers, then preserve the historical owner signature", async () => {
  const { owner, access, recipient, authority } = await fixture()
  const successor = await new BrowserIdentityStore({ storageKey: crypto.randomUUID(), storage: (() => {
    const values = new Map<string, string>()
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) } }
  })() }).bootstrap("Successor")
  const transferPayload = meshRustRuntime().state.createScopeControlTransferPayload({ snapshot: authority.scopeAuthoritySnapshot,
    toController: { personId: successor.identity.personId, publicKey: successor.identity.publicKey,
      certificates: [successor.certificate] } }, Date.now()) as { kind: string }
  const transfer = await signEnvelope(owner.privateKeys.devicePrivateKey!, transferPayload, owner.device.deviceId)
  const scopeAuthoritySnapshot = { ...authority.scopeAuthoritySnapshot, controlTransfers: [transfer] }
  const next = { ...authority, ownerPersonId: successor.identity.personId, ownerPublicKey: successor.identity.publicKey,
    ownerCertificates: [successor.certificate], scopeAuthoritySnapshot }
  meshRustRuntime().state.validateScopeAuthority(scopeAuthoritySnapshot, Date.now())

  await receiveBoardStorageAccess(recipient.identity.personId, "board", next, "editor",
    [selectBoardStorageAccess(access, config.writeToken, "editor")!], async () => {}, recipient.identity.publicKey)

  expect((await getReplicaConfigurations(recipient.identity.personId))[0]).toMatchObject({
    workspaceId: "board", origin: config.origin, boardAccess: { mode: "write" }, writeToken: config.writeToken,
  })
})

test("Given an active owner app device missing from immutable scope history, when its explicit root-bound attestation arrives, then accept it", async () => {
  const { owner, current, authority, recipient } = await formerOwnerAppGrantFixture()
  const originalSnapshot = authority.scopeAuthoritySnapshot as { genesis: { payload: { creator: {
    personId: string; publicKey: string; certificates: unknown[]
  } } }; [key: string]: unknown }
  const oldController = { ...originalSnapshot.genesis.payload.creator, certificates: [owner.certificate] }
  authority.scopeAuthoritySnapshot = { ...originalSnapshot, genesis: await signEnvelope(owner.privateKeys.devicePrivateKey!, {
    ...originalSnapshot.genesis.payload, creator: oldController,
  }, owner.device.deviceId) }
  const grant = await createWorkspaceGrant(owner, "board", recipient.identity.personId, "editor")
  const access = await createBoardStorageAccess(current, config, grant, recipient.identity.publicKey,
    async () => authority, async () => {})
  const forwarded = selectBoardStorageAccess(access, config.writeToken, "editor")!
  const tampered = structuredClone(forwarded)
  tampered.boardAccess!.certificates[0] = { ...tampered.boardAccess!.certificates[0]!, signature: token(9) }
  await expect(receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor", [tampered], async () => {},
    recipient.identity.publicKey)).rejects.toThrow()
  const missingChain = structuredClone(forwarded)
  missingChain.boardAccess!.certificates = []
  await expect(receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor", [missingChain], async () => {},
    recipient.identity.publicKey)).rejects.toThrow()
  const stranger = (await createRecoverableIdentity("better", "Unrelated signer")).profile
  const wrongRoot = structuredClone(forwarded)
  wrongRoot.boardAccess!.certificates = [stranger.certificate]
  await expect(receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor", [wrongRoot], async () => {},
    recipient.identity.publicKey)).rejects.toThrow()
  const revokedRecord = await createWorkspaceDeviceRevocation(owner, "board", owner.identity.personId,
    current.device.deviceId, ["head"], [owner.certificate])
  const revokedAuthority = { ...authority, catalog: { deviceRevocations: [revokedRecord] } }
  await expect(receiveBoardStorageAccess(recipient.identity.personId, "board", revokedAuthority, "editor", [forwarded], async () => {},
    recipient.identity.publicKey)).rejects.toThrow(/revoked/i)

  await receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor", [forwarded], async () => {},
    recipient.identity.publicKey)

  expect((await getReplicaConfigurations(recipient.identity.personId))[0]).toMatchObject({
    workspaceId: "board", boardAccess: { mode: "write" },
  })
})

test("Given a forged token, signature, foreign board or revoked session, when received, then no credentials are installed", async () => {
  const { authority, access, recipient } = await fixture()
  const valid = selectBoardStorageAccess(access, config.writeToken, "editor")!
  for (const value of [{ ...valid, writeToken: token(8) }, { ...valid, workspaceId: "foreign" },
    { ...valid, boardAccess: { ...valid.boardAccess!, authorization: { ...valid.boardAccess!.authorization, signature: token(9) } } },
    { ...valid, boardAccess: { ...valid.boardAccess!, principalGrant: { ...valid.boardAccess!.principalGrant!, signature: token(9) } } }]) {
    await expect(receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor", [value], async () => {}, recipient.identity.publicKey)).rejects.toThrow()
  }
  await expect(receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor", [valid], async () => {
    throw new Error("revoked")
  }, recipient.identity.publicKey)).rejects.toThrow("revoked")
  expect(await getReplicaConfigurations(recipient.identity.personId)).toEqual([])
})

test("Given current credentials, when an older policy or changed same-revision attestation arrives, then retain current storage", async () => {
  const { owner, authority, access, grant, recipient } = await fixture()
  const newerConfig = { ...config, policyRevision: 2 }
  const newerAccess = await createBoardStorageAccess(owner, newerConfig, grant, recipient.identity.publicKey, async () => authority, async () => {})
  const newer = selectBoardStorageAccess(newerAccess, config.writeToken, "editor")!
  await receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor", [newer], async () => {}, recipient.identity.publicKey)
  await receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor",
    [selectBoardStorageAccess(access, config.writeToken, "editor")!], async () => {}, recipient.identity.publicKey)
  const changed = await createBoardStorageAccess(owner, { ...newerConfig, contentKey: token(10) }, grant, recipient.identity.publicKey, async () => authority, async () => {})
  await expect(receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor",
    [selectBoardStorageAccess(changed, config.writeToken, "editor")!], async () => {}, recipient.identity.publicKey)).rejects.toThrow(/revision/i)
  expect((await getReplicaConfigurations(recipient.identity.personId))[0]!.policyRevision).toBe(2)
})

test("Given a visitor grant, when writing credentials arrive, then reject rather than persist a capability above the current role", async () => {
  const { authority, access, recipient } = await fixture()
  await expect(receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "visitor",
    [selectBoardStorageAccess(access, config.writeToken, "editor")!], vi.fn(async () => {}), recipient.identity.publicKey)).rejects.toThrow()
  expect(await getReplicaConfigurations(recipient.identity.personId)).toEqual([])
})

test("Given a privately configured owner connection, when recipient sharing runs, then the owner record is never replaced", async () => {
  const { owner, authority, createAccess } = await fixture()
  const ownerAccess = await createAccess(owner, "owner")
  await setReplicaPreference(owner.identity.personId, config)
  await receiveBoardStorageAccess(owner.identity.personId, "board", authority, "owner",
    [selectBoardStorageAccess(ownerAccess.access, config.writeToken, "owner")!], async () => {}, owner.identity.publicKey)
  expect((await getReplicaConfigurations(owner.identity.personId))[0]!.boardAccess).toBeUndefined()
})

test("Given a live authorized visitor session, when mesh metadata publishes after owner adds Rusty, then transfer only this board's reading capability", async () => {
  const { owner, authority, recipient } = await fixture()
  await setReplicaPreference(owner.identity.personId, config)
  await setReplicaPreference(owner.identity.personId, { ...config, workspaceId: "other-board", scopeId: token(22) })
  const guard = vi.fn(async () => {})
  const grant = await createWorkspaceGrant(owner, "board", recipient.identity.personId, "visitor")
  const advertisement = await createPeerAdvertisement(recipient, { workspaceId: "board", endpoint: "iroh://visitor", grant,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate] })
  const peers = { getWorkspaceCredential: async () => authority, getWorkspaceAuthority: async () => authority,
    getPeer: async () => ({ personId: recipient.identity.personId, deviceId: recipient.device.deviceId, role: "visitor", advertisement }) } as unknown as PeerStore
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
      peers: { getWorkspaceCredential: async () => ({ ...authority, localGrant: grant }), getWorkspaceAuthority: async () => authority } as unknown as PeerStore, guard })
  await receiver.mergeMesh!("board", packet)
  expect(mergeMesh).toHaveBeenCalledWith("board", { version: 1, peers: [] })
  expect((await getReplicaConfigurations(recipient.identity.personId))[0]!.boardAccess?.mode).toBe("read")
  await expect(sender.readMesh!("other-board")).rejects.toThrow("workspace")
})

test("Given a signed visitor membership, when owner prepares Rusty access, then bind a read-only principal grant to that exact person and policy epoch", async () => {
  const { owner, authority, recipient, registerGrant } = await fixture()
  const grant = await createWorkspaceGrant(owner, "board", recipient.identity.personId, "visitor", 4)
  const member = await createPeerAdvertisement(recipient, { workspaceId: "board", endpoint: "iroh://visitor",
    grant, ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate] })
  const remote = { workspaceId: "board", personId: recipient.identity.personId, deviceId: recipient.device.deviceId,
    endpoint: "iroh://visitor", transportSecret: token(8), role: "visitor" as const,
    lastSeen: new Date().toISOString(), advertisement: member }
  const peers = { getWorkspaceCredential: async () => authority, getWorkspaceAuthority: async () => authority, getPeer: async () => remote } as unknown as PeerStore
  await setReplicaPreference(owner.identity.personId, config)
  const sender = withWorkspaceRustyAccess({ readMesh: async () => ({ version: 1, peers: [] }) } as unknown as WorkspaceSetStore,
    { workspaceId: "board", profile: owner, remotePersonId: recipient.identity.personId,
      remoteDeviceId: recipient.device.deviceId, peers, guard: async () => {} })

  const packet = await sender.readMesh!("board") as { boardStorageAccess: BlindReplicaConfig[] }
  const authorization = packet.boardStorageAccess[0]!.boardAccess!.authorization

  expect(authorization.payload).toMatchObject({
    version: 2,
    subjectPersonId: recipient.identity.personId,
    subjectPublicKey: recipient.identity.publicKey,
    actions: ["read"],
    policyEpoch: 4,
    grantId: grant.payload.grantId,
  })
  expect(packet.boardStorageAccess[0]!.boardAccess!.principalGrant).toMatchObject({
    payload: {
      kind: "rusty-resource-principal-grant",
      version: 1,
      workspaceId: "board",
      resourceKind: "scope",
      resourceId: config.scopeId,
      scopeId: config.scopeId,
      ownerPersonId: owner.identity.personId,
      subjectPersonId: recipient.identity.personId,
      subjectPublicKey: recipient.identity.publicKey,
      grantId: grant.payload.grantId,
      policyEpoch: 4,
      actions: ["read"],
      workspaceGrant: grant,
    },
  })
  expect(JSON.stringify(authorization.payload)).not.toContain(config.writeToken)
  expect(Object.hasOwn(registerGrant.mock.lastCall![0], "writeToken")).toBe(false)
})

test("Given a signed workspace authority snapshot absent from the mesh credential projection, when owner shares Rusty, then use the authoritative snapshot", async () => {
  const { owner, authority, recipient, registerGrant } = await fixture()
  const grant = await createWorkspaceGrant(owner, "board", recipient.identity.personId, "editor", 3)
  const advertisement = await createPeerAdvertisement(recipient, { workspaceId: "board", endpoint: "iroh://editor", grant,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate] })
  const { scopeAuthoritySnapshot, ...credential } = authority
  expect(scopeAuthoritySnapshot).toEqual(authority.scopeAuthoritySnapshot)
  const peers = { getWorkspaceCredential: async () => credential,
    getWorkspaceAuthority: async () => authority,
    getPeer: async () => ({ personId: recipient.identity.personId, deviceId: recipient.device.deviceId, role: "editor", advertisement })
  } as unknown as PeerStore
  registerGrant.mockClear()
  await setReplicaPreference(owner.identity.personId, config)
  const sender = withWorkspaceRustyAccess({ readMesh: async () => ({ version: 1, peers: [] }) } as unknown as WorkspaceSetStore,
    { workspaceId: "board", profile: owner, remotePersonId: recipient.identity.personId,
      remoteDeviceId: recipient.device.deviceId, peers, guard: async () => {} })

  const packet = await sender.readMesh!("board") as { boardStorageAccess: BlindReplicaConfig[] }
  expect(packet.boardStorageAccess[0]!.boardAccess!.principalGrant?.payload.scopeAuthority).toEqual(authority.scopeAuthoritySnapshot)
  expect(registerGrant).toHaveBeenCalledTimes(1)
})

test("Given an editor membership, when owner prepares Rusty access, then grant read and write to that editor only", async () => {
  const { owner, authority, recipient } = await fixture()
  const grant = await createWorkspaceGrant(owner, "board", recipient.identity.personId, "editor", 7)
  const advertisement = await createPeerAdvertisement(recipient, { workspaceId: "board", endpoint: "iroh://editor", grant,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate] })
  const peers = { getWorkspaceCredential: async () => authority, getWorkspaceAuthority: async () => authority,
    getPeer: async () => ({ personId: recipient.identity.personId, deviceId: recipient.device.deviceId, role: "editor", advertisement }) } as unknown as PeerStore
  await setReplicaPreference(owner.identity.personId, config)
  const sender = withWorkspaceRustyAccess({ readMesh: async () => ({ version: 1, peers: [] }) } as unknown as WorkspaceSetStore,
    { workspaceId: "board", profile: owner, remotePersonId: recipient.identity.personId,
      remoteDeviceId: recipient.device.deviceId, peers, guard: async () => {} })

  const packet = await sender.readMesh!("board") as { boardStorageAccess: BlindReplicaConfig[] }
  expect(packet.boardStorageAccess[0]!.boardAccess!.principalGrant?.payload).toMatchObject({
    subjectPersonId: recipient.identity.personId,
    subjectPublicKey: recipient.identity.publicKey,
    actions: ["read", "write"],
    policyEpoch: 7,
    grantId: grant.payload.grantId,
  })
  const principalGrant = JSON.stringify(packet.boardStorageAccess[0]!.boardAccess!.principalGrant)
  expect(principalGrant).not.toContain(config.readToken)
  expect(principalGrant).not.toContain(config.writeToken)
})

test.each([false, true])("Given an owner peer and Rusty configured=%s, when exchanging workspace metadata, then do not require a participant grant or share storage", async configured => {
  const { owner, authority, registerGrant } = await fixture()
  registerGrant.mockClear()
  if (configured) await setReplicaPreference(owner.identity.personId, config)
  const advertisement = await createPeerAdvertisement(owner, { workspaceId: "board", endpoint: "iroh://owner",
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate] })
  const peers = { getWorkspaceCredential: async () => authority, getWorkspaceAuthority: async () => authority,
    getPeer: async () => ({ personId: owner.identity.personId, deviceId: owner.device.deviceId, role: "owner", advertisement }) } as unknown as PeerStore
  const mesh = { version: 1, peers: [] }
  const sender = withWorkspaceRustyAccess({ readMesh: async () => mesh } as unknown as WorkspaceSetStore,
    { workspaceId: "board", profile: owner, remotePersonId: owner.identity.personId,
      remoteDeviceId: owner.device.deviceId, peers, guard: async () => {} })

  await expect(sender.readMesh!("board")).resolves.toEqual(mesh)
  expect(registerGrant).not.toHaveBeenCalled()
})

test("Given the Rusty scope control ledger, when sharing participant storage, then register the exact accepted ledger before disclosure", async () => {
  const { access, authority, registerGrant } = await fixture()
  const principal = access.principalGrant!
  expect(principal.payload.scopeAuthority).toEqual(authority.scopeAuthoritySnapshot)
  expect(registerGrant).toHaveBeenCalledTimes(1)
  expect(registerGrant.mock.calls[0]![0]).toMatchObject({
    storageScopeId: config.scopeId,
    workspaceId: "board",
    expectedScopeAuthoritySnapshot: authority.scopeAuthoritySnapshot,
    workspaceGrant: access.authorization.payload.workspaceGrant,
    readToken: config.readToken,
    writeToken: config.writeToken,
  })
  expect(registerGrant.mock.calls[0]![0].signAuthorization).toBeTypeOf("function")
})

test("Given Rusty rejects principal registration, when preparing board access, then do not return an attestation", async () => {
  const { createAccess, registerGrant, recipient } = await fixture()
  registerGrant.mockRejectedValueOnce(new Error("Rusty registration failed"))
  await expect(createAccess(recipient, "editor")).rejects.toThrow("Rusty registration failed")
})

test("Given a removed connection tombstone, when a peer replays earlier access, then do not resurrect that connection", async () => {
  const { authority, access, recipient } = await fixture()
  const connection = selectBoardStorageAccess(access, config.writeToken, "editor")!
  const personId = recipient.identity.personId
  await receiveBoardStorageAccess(personId, "board", authority, "editor", [connection], async () => {}, recipient.identity.publicKey)
  await setReplicaPreference(personId, (await getReplicaConfigurations(personId))[0]!, true)
  await receiveBoardStorageAccess(personId, "board", authority, "editor", [connection], async () => {}, recipient.identity.publicKey)
  expect(await getReplicaConfigurations(personId)).toEqual([])
})

test("Given an editor changed to visitor, when read access arrives, then remove the stored writing capability", async () => {
  const { authority, access, recipient, createAccess } = await fixture()
  await receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "editor",
    [selectBoardStorageAccess(access, config.writeToken, "editor")!], async () => {}, recipient.identity.publicKey)
  await receiveBoardStorageAccess(recipient.identity.personId, "board", authority, "visitor",
    [selectBoardStorageAccess((await createAccess(recipient, "visitor")).access, config.writeToken, "visitor")!], async () => {}, recipient.identity.publicKey)
  expect((await getReplicaConfigurations(recipient.identity.personId))[0]!.writeToken).toBe("")
})

test("Given legacy identical reading and writing tokens, when owner prepares participant sharing, then require separate tokens before disclosure", async () => {
  const { owner, authority } = await fixture()
  const grant = await createWorkspaceGrant(owner, "board", owner.identity.personId, "owner")
  await expect(createBoardStorageAccess(owner, { ...config, writeToken: config.readToken }, grant, owner.identity.publicKey, async () => authority, async () => {}))
    .rejects.toThrow(/separate/i)
})
