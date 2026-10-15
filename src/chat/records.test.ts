import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  bootstrapIdentity,
  resetIdentityStorageForTest,
  sha256Base64Url,
  toBase64Url,
  signEnvelope,
  type LocalProfile,
} from "../domain/identity"
import {
  verifyChatRecord,
  type ChatRecord,
  type ChatAuthority,
  type ChatPayload,
} from "./records"
import { createChatRecord as createVerifiedChatRecord } from "./signing"
import { createChatRecordFixture as createChatRecord } from "./records.testSupport"
import { resolveSigningContext } from "../domain/signingContext"
import {
  certHashDefault,
  createDelegatedCertificate,
  createWorkspaceGrant,
} from "../domain/proofs"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import { peerStore } from "../sync/peerStore"

describe("Chat records cryptographic admission (src/chat/records.ts)", () => {
  const workspaceId = "ws_test_crypto"

  beforeEach(() => {
    resetIdentityStorageForTest()
  })

  async function createProfile(displayName: string): Promise<LocalProfile> {
    resetIdentityStorageForTest()
    return await bootstrapIdentity(displayName)
  }

  function makeOwnerAuthority(owner: LocalProfile): ChatAuthority {
    return {
      publicKey: owner.identity.publicKey,
      certificates: [owner.certificate],
    }
  }

  function makeEditorAuthority(
    owner: LocalProfile,
    grant: WorkspaceGrant,
    ownerCerts: DeviceCertificate[] = [owner.certificate]
  ): ChatAuthority {
    return {
      publicKey: owner.identity.publicKey,
      certificates: ownerCerts,
      grant,
    }
  }

  it("rejects a verified signing context supplied with another record author", async () => {
    const owner = await createProfile("Owner")
    const other = await createProfile("Other")
    const authorityRevision = "fixture-authority"
    const signingContext = await resolveSigningContext({ profile: owner, certificates: [owner.certificate],
      purpose: "chat-message", binding: { workspaceId }, authorityRevision,
      current: async () => ({ personId: owner.identity.personId, deviceId: owner.device.deviceId, authorityRevision }),
    })
    await expect(createVerifiedChatRecord(other, makeOwnerAuthority(owner), workspaceId, "chat-message", "Substituted author",
      0, undefined, signingContext)).rejects.toThrow("Chat signing context does not match the record author")
  })

  it("verifies an editor grant with the embedded owner certificate when the local certificate catalog is incomplete", async () => {
    const owner = await createProfile("Owner")
    const editor = await createProfile("Editor")
    const grant = await createWorkspaceGrant(owner, workspaceId, editor.identity.personId, "editor")
    const record = await createChatRecord(editor, [editor.certificate], makeEditorAuthority(owner, grant), workspaceId, "chat-message", "Hello")
    const previousIndexedDb = globalThis.indexedDB
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {} })
    const credential = vi.spyOn(peerStore,"getWorkspaceCredential").mockResolvedValue({
      ownerPersonId:owner.identity.personId,ownerPublicKey:owner.identity.publicKey,ownerCertificates:[],ownerHistory:[],
    } as never)
    const peers = vi.spyOn(peerStore,"listPeers").mockResolvedValue([])
    try {
      await expect(verifyChatRecord(record,workspaceId,owner.identity.personId)).resolves.toStrictEqual(record)
      const forged = structuredClone(record)
      forged.authority.certificates[0]!.signature = toBase64Url(new Uint8Array(64))
      await expect(verifyChatRecord(forged,workspaceId,owner.identity.personId)).rejects.toThrow("Invalid workspace grant")
    } finally {
      credential.mockRestore(); peers.mockRestore()
      Object.defineProperty(globalThis,"indexedDB",{configurable:true,value:previousIndexedDb})
    }
  })

  it("signs bounded v2 context, rejects tampering, and preserves legacy v1", async () => {
    const owner = await createProfile("Owner")
    const context = { references: [{ workspaceScope: workspaceId, boardId: "board", itemId: "item" }], mentions: ["person"] }
    const record = await createChatRecord(owner, [owner.certificate], makeOwnerAuthority(owner), workspaceId, "chat-message", "Discuss", 0, context)
    expect(record.signed.payload.version).toBe(2)
    await expect(verifyChatRecord(record, workspaceId, owner.identity.personId)).resolves.toStrictEqual(record)
    const forged = structuredClone(record)
    forged.signed.payload.context!.references[0]!.itemId = "changed"
    await expect(verifyChatRecord(forged, workspaceId, owner.identity.personId)).rejects.toThrow("Invalid message signature")
    const legacy = await createChatRecord(owner, [owner.certificate], makeOwnerAuthority(owner), workspaceId, "chat-message", "Legacy")
    expect(legacy.signed.payload.version).toBe(1)
    await expect(verifyChatRecord(legacy, workspaceId, owner.identity.personId)).resolves.toStrictEqual(legacy)
    legacy.signed.payload.context = context
    await expect(verifyChatRecord(legacy, workspaceId, owner.identity.personId)).rejects.toThrow("Invalid chat record")
  })

  describe("1. Owner signed message admitted", () => {
    it("admits signed ephemeral typing state and rejects unknown typing values", async () => {
      const owner = await createProfile("Owner Alice")
      const record = await createChatRecord(owner, [owner.certificate], makeOwnerAuthority(owner),
        workspaceId, "chat-typing", "typing", Date.now())
      await expect(verifyChatRecord(record, workspaceId, owner.identity.personId)).resolves.toStrictEqual(record)

      record.signed.payload.text = "maybe"
      await expect(verifyChatRecord(record, workspaceId, owner.identity.personId)).rejects.toThrow("Invalid typing presence")
    })

    it("admits owner-signed chat message with valid Ed25519 signature", async () => {
      const owner = await createProfile("Owner Alice")
      const authority = makeOwnerAuthority(owner)

      const record = await createChatRecord(
        owner,
        [owner.certificate],
        authority,
        workspaceId,
        "chat-message",
        "Hello from owner Alice"
      )

      const verified = await verifyChatRecord(record, workspaceId, owner.identity.personId)
      expect(verified).toStrictEqual(record)
      expect(verified.signed.payload.text).toBe("Hello from owner Alice")
      expect(verified.signed.payload.personId).toBe(owner.identity.personId)
    })

    it("admits owner-signed chat profile with normalized display name", async () => {
      const owner = await createProfile("Owner Alice")
      const authority = makeOwnerAuthority(owner)

      const record = await createChatRecord(
        owner,
        [owner.certificate],
        authority,
        workspaceId,
        "chat-profile",
        "Alice"
      )

      const verified = await verifyChatRecord(record, workspaceId, owner.identity.personId)
      expect(verified).toStrictEqual(record)
      expect(verified.signed.payload.text).toBe("Alice")
    })

    it("admits owner message signed by enrolled secondary device with valid delegation chain", async () => {
      const owner = await createProfile("Owner Alice")

      // Secondary device keypair for Alice
      const dev2KeyPair = (await crypto.subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"]
      )) as CryptoKeyPair
      const dev2RawPub = new Uint8Array(await crypto.subtle.exportKey("raw", dev2KeyPair.publicKey))
      const dev2Id = await sha256Base64Url(dev2RawPub)
      const dev2Pub = toBase64Url(dev2RawPub)
      const cert1Hash = await certHashDefault(owner.certificate)

      // Delegated cert: dev2 signed by owner's primary device
      const cert2 = await createDelegatedCertificate(
        owner.privateKeys.devicePrivateKey,
        owner.device.deviceId,
        owner.identity.personId,
        dev2Id,
        dev2Pub,
        cert1Hash
      )

      const payload: ChatPayload = {
        kind: "chat-message",
        version: 1,
        workspaceId,
        personId: owner.identity.personId,
        deviceId: dev2Id,
        id: `${dev2Id}:${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        text: "Message from Alice's second device",
        revision: 0,
      }

      const signed = await signEnvelope(dev2KeyPair.privateKey, payload, dev2Id)
      const record: ChatRecord = {
        signed,
        publicKey: owner.identity.publicKey,
        certificates: [cert2, owner.certificate],
        authority: makeOwnerAuthority(owner),
      }

      const verified = await verifyChatRecord(record, workspaceId, owner.identity.personId)
      expect(verified).toStrictEqual(record)
      expect(verified.signed.payload.deviceId).toBe(dev2Id)
    })
  })

  describe("2. Tampered text rejected", () => {
    it("rejects message when payload text is tampered after signing", async () => {
      const owner = await createProfile("Owner Alice")
      const authority = makeOwnerAuthority(owner)

      const record = await createChatRecord(
        owner,
        [owner.certificate],
        authority,
        workspaceId,
        "chat-message",
        "Original message"
      )

      // Tamper text
      record.signed.payload.text = "Tampered fraudulent text"

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid message signature")
    })

    it("rejects profile record when display name is tampered after signing", async () => {
      const owner = await createProfile("Owner Alice")
      const authority = makeOwnerAuthority(owner)

      const record = await createChatRecord(
        owner,
        [owner.certificate],
        authority,
        workspaceId,
        "chat-profile",
        "Alice"
      )

      // Tamper display name
      record.signed.payload.text = "Mallory"

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid message signature")
    })

    it("rejects message when signature bytes are corrupted", async () => {
      const owner = await createProfile("Owner Alice")
      const authority = makeOwnerAuthority(owner)

      const record = await createChatRecord(
        owner,
        [owner.certificate],
        authority,
        workspaceId,
        "chat-message",
        "Integrity check message"
      )

      // Corrupt signature
      const sig = record.signed.signature
      record.signed.signature = sig.slice(0, -4) + "AAAA"

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid message signature")
    })
  })

  describe("3. Impersonated person ID rejected", () => {
    it("rejects message when attacker claims owner personId but signs with attacker identity key", async () => {
      const owner = await createProfile("Owner Alice")
      const mallory = await createProfile("Mallory")

      // Mallory claims Alice's personId in the payload, but uses Mallory's device and public key
      const payload: ChatPayload = {
        kind: "chat-message",
        version: 1,
        workspaceId,
        personId: owner.identity.personId, // Impersonation attempt
        deviceId: mallory.device.deviceId,
        id: `${mallory.device.deviceId}:${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        text: "I am totally Alice",
        revision: 0,
      }

      const signed = await signEnvelope(
        mallory.privateKeys.devicePrivateKey,
        payload,
        mallory.device.deviceId
      )

      const record: ChatRecord = {
        signed,
        publicKey: mallory.identity.publicKey, // Mallory's key does not match owner.identity.personId
        certificates: [mallory.certificate],
        authority: makeOwnerAuthority(owner),
      }

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Identity does not match its key")
    })

    it("rejects message when attacker claims owner personId and owner publicKey but signs with attacker device key", async () => {
      const owner = await createProfile("Owner Alice")
      const mallory = await createProfile("Mallory")

      // Mallory claims Alice's personId & deviceId & publicKey, but signs with Mallory's key
      const payload: ChatPayload = {
        kind: "chat-message",
        version: 1,
        workspaceId,
        personId: owner.identity.personId,
        deviceId: owner.device.deviceId,
        id: `${owner.device.deviceId}:${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        text: "Forged message with Alice deviceId",
        revision: 0,
      }

      const signedWithMalloryKey = await signEnvelope(
        mallory.privateKeys.devicePrivateKey,
        payload,
        owner.device.deviceId
      )

      const record: ChatRecord = {
        signed: signedWithMalloryKey,
        publicKey: owner.identity.publicKey,
        certificates: [owner.certificate],
        authority: makeOwnerAuthority(owner),
      }

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid message signature")
    })

    it("rejects message when attacker claims owner personId with Mallory's deviceId against owner certificates", async () => {
      const owner = await createProfile("Owner Alice")
      const mallory = await createProfile("Mallory")

      const payload: ChatPayload = {
        kind: "chat-message",
        version: 1,
        workspaceId,
        personId: owner.identity.personId,
        deviceId: mallory.device.deviceId,
        id: `${mallory.device.deviceId}:${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        text: "Impersonation with Mallory device",
        revision: 0,
      }

      const signed = await signEnvelope(
        mallory.privateKeys.devicePrivateKey,
        payload,
        mallory.device.deviceId
      )

      const record: ChatRecord = {
        signed,
        publicKey: owner.identity.publicKey,
        certificates: [owner.certificate], // Does not contain mallory.device.deviceId
        authority: makeOwnerAuthority(owner),
      }

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Missing device certificate")
    })

    it("rejects mutating personId on an otherwise valid signed envelope", async () => {
      const owner = await createProfile("Owner Alice")
      const mallory = await createProfile("Mallory")

      const record = await createChatRecord(
        owner,
        [owner.certificate],
        makeOwnerAuthority(owner),
        workspaceId,
        "chat-message",
        "Genuine message"
      )

      // Attacker mutates personId in the signed payload
      record.signed.payload.personId = mallory.identity.personId

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow()
    })
  })

  describe("4. Cross-workspace replay rejected", () => {
    it("rejects valid message from workspace-A replayed into workspace-B", async () => {
      const owner = await createProfile("Owner Alice")
      const authority = makeOwnerAuthority(owner)

      const record = await createChatRecord(
        owner,
        [owner.certificate],
        authority,
        "workspace_A",
        "chat-message",
        "Secret discussion in workspace A"
      )

      // Replaying into workspace_B without altering payload
      await expect(
        verifyChatRecord(record, "workspace_B", owner.identity.personId)
      ).rejects.toThrow("Invalid chat record")
    })

    it("rejects message when workspaceId in payload is modified to match target workspace", async () => {
      const owner = await createProfile("Owner Alice")
      const authority = makeOwnerAuthority(owner)

      const record = await createChatRecord(
        owner,
        [owner.certificate],
        authority,
        "workspace_A",
        "chat-message",
        "Original message"
      )

      // Tamper workspaceId in the signed payload to try bypassing the workspaceId check
      record.signed.payload.workspaceId = "workspace_B"

      await expect(
        verifyChatRecord(record, "workspace_B", owner.identity.personId)
      ).rejects.toThrow("Invalid message signature")
    })

    it("rejects replaying editor message and grant into an unauthorized workspace", async () => {
      const owner = await createProfile("Owner Alice")
      const editor = await createProfile("Editor Bob")

      // Owner grants Bob editor access ONLY on workspace_A
      const grantA = await createWorkspaceGrant(
        owner,
        "workspace_A",
        editor.identity.personId,
        "editor"
      )

      const authorityA = makeEditorAuthority(owner, grantA)

      // Bob writes a message targeting workspace_B but supplies grant for workspace_A
      const record = await createChatRecord(
        editor,
        [editor.certificate],
        authorityA,
        "workspace_B",
        "chat-message",
        "Trying to write to workspace B"
      )

      await expect(
        verifyChatRecord(record, "workspace_B", owner.identity.personId)
      ).rejects.toThrow("No permission to write to this chat")
    })
  })

  describe("5. Unrelated self-signed identity without owner grant rejected", () => {
    it("rejects self-signed message from unrelated identity when authority has no grant", async () => {
      const owner = await createProfile("Owner Alice")
      const stranger = await createProfile("Stranger Eve")

      // Eve creates a record targeting Alice's workspace, referencing Alice's public authority but without grant
      const authorityWithoutGrant: ChatAuthority = {
        publicKey: owner.identity.publicKey,
        certificates: [owner.certificate],
      }

      const record = await createChatRecord(
        stranger,
        [stranger.certificate],
        authorityWithoutGrant,
        workspaceId,
        "chat-message",
        "Unauthorized intrusion"
      )

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("No permission to write to this chat")
    })

    it("rejects message when attacker supplies a self-signed fabricated grant", async () => {
      const owner = await createProfile("Owner Alice")
      const stranger = await createProfile("Stranger Eve")

      // Eve fabricates and self-signs a workspace grant claiming editor role
      const fabricatedGrant = await createWorkspaceGrant(
        stranger, // signed by Eve, not Alice!
        workspaceId,
        stranger.identity.personId,
        "editor"
      )

      const fakeAuthority: ChatAuthority = {
        publicKey: owner.identity.publicKey,
        certificates: [owner.certificate],
        grant: fabricatedGrant,
      }

      const record = await createChatRecord(
        stranger,
        [stranger.certificate],
        fakeAuthority,
        workspaceId,
        "chat-message",
        "I forged my own permission"
      )

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid workspace grant")
    })

    it("rejects message when grant specifies visitor role instead of editor/owner", async () => {
      const owner = await createProfile("Owner Alice")
      const viewer = await createProfile("Viewer Bob")

      const viewerGrant = await createWorkspaceGrant(
        owner,
        workspaceId,
        viewer.identity.personId,
        "visitor"
      )

      const authority = makeEditorAuthority(owner, viewerGrant)

      const record = await createChatRecord(
        viewer,
        [viewer.certificate],
        authority,
        workspaceId,
        "chat-message",
        "Can a viewer chat?"
      )

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("No permission to write to this chat")
    })

    it("rejects message when grant was issued for another person", async () => {
      const owner = await createProfile("Owner Alice")
      const bob = await createProfile("Bob")
      const charlie = await createProfile("Charlie")

      // Owner grants Charlie, but Bob tries to use Charlie's grant
      const charlieGrant = await createWorkspaceGrant(
        owner,
        workspaceId,
        charlie.identity.personId,
        "editor"
      )

      const authority = makeEditorAuthority(owner, charlieGrant)

      const record = await createChatRecord(
        bob,
        [bob.certificate],
        authority,
        workspaceId,
        "chat-message",
        "Bob using Charlie's grant"
      )

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("No permission to write to this chat")
    })
  })

  describe("6. Owner-granted editor admitted", () => {
    it("admits message from editor holding valid owner device-signed grant", async () => {
      const owner = await createProfile("Owner Alice")
      const editor = await createProfile("Editor Bob")

      // Owner issues grant signed by owner's device key
      const grant = await createWorkspaceGrant(
        owner,
        workspaceId,
        editor.identity.personId,
        "editor"
      )

      const authority = makeEditorAuthority(owner, grant)

      const record = await createChatRecord(
        editor,
        [editor.certificate],
        authority,
        workspaceId,
        "chat-message",
        "Hello from authorized editor Bob"
      )

      const verified = await verifyChatRecord(record, workspaceId, owner.identity.personId)
      expect(verified).toStrictEqual(record)
      expect(verified.signed.payload.personId).toBe(editor.identity.personId)
    })

    it("admits message from editor holding valid owner root-signed grant", async () => {
      const owner = await createProfile("Owner Alice")
      const editor = await createProfile("Editor Bob")

      // Owner issues grant signed by owner's root identity key
      const rootGrantPayload = {
        kind: "workspace-grant" as const,
        version: 1 as const,
        grantId: crypto.randomUUID(),
        workspaceId,
        personId: editor.identity.personId,
        role: "editor" as const,
      }

      const rootGrant = (await signEnvelope(
        owner.privateKeys.identityPrivateKey!,
        rootGrantPayload,
        owner.identity.personId
      )) as unknown as WorkspaceGrant

      const authority = makeEditorAuthority(owner, rootGrant)

      const record = await createChatRecord(
        editor,
        [editor.certificate],
        authority,
        workspaceId,
        "chat-message",
        "Hello with root-signed grant"
      )

      const verified = await verifyChatRecord(record, workspaceId, owner.identity.personId)
      expect(verified).toStrictEqual(record)
    })

    it("admits chat-profile from editor holding valid grant", async () => {
      const owner = await createProfile("Owner Alice")
      const editor = await createProfile("Editor Bob")

      const grant = await createWorkspaceGrant(
        owner,
        workspaceId,
        editor.identity.personId,
        "editor"
      )

      const authority = makeEditorAuthority(owner, grant)

      const record = await createChatRecord(
        editor,
        [editor.certificate],
        authority,
        workspaceId,
        "chat-profile",
        "Editor Bob"
      )

      const verified = await verifyChatRecord(record, workspaceId, owner.identity.personId)
      expect(verified).toStrictEqual(record)
      expect(verified.signed.payload.text).toBe("Editor Bob")
    })

    it("admits the former owner's editor profile after ownership transfers", async () => {
      const formerOwner = await createProfile("Former owner")
      const newOwner = await createProfile("New owner")
      const grant = await createWorkspaceGrant(formerOwner, workspaceId, formerOwner.identity.personId, "editor")
      const record = await createChatRecord(formerOwner, [formerOwner.certificate], {
        publicKey: newOwner.identity.publicKey,
        certificates: [newOwner.certificate, formerOwner.certificate],
        grant,
      }, workspaceId, "chat-profile", "Former owner editor")
      const previousIndexedDb = globalThis.indexedDB
      Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {} })
      const credential = vi.spyOn(peerStore, "getWorkspaceCredential").mockResolvedValue({
        version: 1,
        workspaceId,
        ownerPersonId: newOwner.identity.personId,
        ownerPublicKey: newOwner.identity.publicKey,
        ownerCertificates: [newOwner.certificate, formerOwner.certificate],
        ownerHistory: [{ personId: formerOwner.identity.personId, publicKey: formerOwner.identity.publicKey,
          certificates: [formerOwner.certificate] }],
        localGrant: grant,
        transportSecret: "test-secret",
        epoch: 2,
        updatedAt: new Date().toISOString(),
      })
      const peers = vi.spyOn(peerStore, "listPeers").mockResolvedValue([])

      try {
        await expect(verifyChatRecord(record, workspaceId, newOwner.identity.personId)).resolves.toStrictEqual(record)
      } finally {
        credential.mockRestore()
        peers.mockRestore()
        Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: previousIndexedDb })
      }
    })
  })

  describe("7. Bad root/device chain rejected", () => {
    it("rejects record with corrupted root certificate signature", async () => {
      const owner = await createProfile("Owner Alice")

      const corruptedCert: DeviceCertificate = {
        ...owner.certificate,
        signature: owner.certificate.signature.slice(0, -4) + "BBBB",
      }

      const authority: ChatAuthority = {
        publicKey: owner.identity.publicKey,
        certificates: [corruptedCert],
      }

      const record = await createChatRecord(
        owner,
        [corruptedCert],
        authority,
        workspaceId,
        "chat-message",
        "Message with corrupted root cert"
      )

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid signature")
    })

    it("rejects record when signer certificate is missing from certificates pool", async () => {
      const owner = await createProfile("Owner Alice")
      const authority = makeOwnerAuthority(owner)

      const record = await createChatRecord(
        owner,
        [], // empty certs pool
        authority,
        workspaceId,
        "chat-message",
        "Missing cert test"
      )

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid certificate chain")
    })

    it("rejects record when delegated certificate issuer is missing from pool", async () => {
      const owner = await createProfile("Owner Alice")

      const dev2KeyPair = (await crypto.subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"]
      )) as CryptoKeyPair
      const dev2RawPub = new Uint8Array(await crypto.subtle.exportKey("raw", dev2KeyPair.publicKey))
      const dev2Id = await sha256Base64Url(dev2RawPub)
      const dev2Pub = toBase64Url(dev2RawPub)
      const cert1Hash = await certHashDefault(owner.certificate)

      const cert2 = await createDelegatedCertificate(
        owner.privateKeys.devicePrivateKey,
        owner.device.deviceId,
        owner.identity.personId,
        dev2Id,
        dev2Pub,
        cert1Hash
      )

      const payload: ChatPayload = {
        kind: "chat-message",
        version: 1,
        workspaceId,
        personId: owner.identity.personId,
        deviceId: dev2Id,
        id: `${dev2Id}:${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        text: "Orphan delegated certificate",
        revision: 0,
      }

      const signed = await signEnvelope(dev2KeyPair.privateKey, payload, dev2Id)
      const record: ChatRecord = {
        signed,
        publicKey: owner.identity.publicKey,
        certificates: [cert2], // Missing owner.certificate!
        authority: makeOwnerAuthority(owner),
      }

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid certificate chain")
    })

    it("rejects record when delegated certificate signature is invalid", async () => {
      const owner = await createProfile("Owner Alice")

      const dev2KeyPair = (await crypto.subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"]
      )) as CryptoKeyPair
      const dev2RawPub = new Uint8Array(await crypto.subtle.exportKey("raw", dev2KeyPair.publicKey))
      const dev2Id = await sha256Base64Url(dev2RawPub)
      const dev2Pub = toBase64Url(dev2RawPub)
      const cert1Hash = await certHashDefault(owner.certificate)

      const cert2 = await createDelegatedCertificate(
        owner.privateKeys.devicePrivateKey,
        owner.device.deviceId,
        owner.identity.personId,
        dev2Id,
        dev2Pub,
        cert1Hash
      )

      // Corrupt cert2 signature
      const corruptedCert2: DeviceCertificate = {
        ...cert2,
        signature: cert2.signature.slice(0, -4) + "CCCC",
      }

      const payload: ChatPayload = {
        kind: "chat-message",
        version: 1,
        workspaceId,
        personId: owner.identity.personId,
        deviceId: dev2Id,
        id: `${dev2Id}:${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        text: "Bad delegated signature",
        revision: 0,
      }

      const signed = await signEnvelope(dev2KeyPair.privateKey, payload, dev2Id)
      const record: ChatRecord = {
        signed,
        publicKey: owner.identity.publicKey,
        certificates: [corruptedCert2, owner.certificate],
        authority: makeOwnerAuthority(owner),
      }

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid signature")
    })

    it("rejects record when delegating cert lacks canEnrollDevices capability", async () => {
      const owner = await createProfile("Owner Alice")

      const dev2KeyPair = (await crypto.subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"]
      )) as CryptoKeyPair
      const dev2RawPub = new Uint8Array(await crypto.subtle.exportKey("raw", dev2KeyPair.publicKey))
      const dev2Id = await sha256Base64Url(dev2RawPub)
      const dev2Pub = toBase64Url(dev2RawPub)

      // Owner cert but with canEnrollDevices set to false
      const nonEnrollerCertPayload = {
        ...owner.certificate.payload,
        canEnrollDevices: false as unknown as true,
      }
      const nonEnrollerCert = (await signEnvelope(
        owner.privateKeys.identityPrivateKey!,
        nonEnrollerCertPayload,
        owner.identity.personId
      )) as unknown as DeviceCertificate

      const cert1Hash = await certHashDefault(nonEnrollerCert)

      const cert2 = await createDelegatedCertificate(
        owner.privateKeys.devicePrivateKey,
        owner.device.deviceId,
        owner.identity.personId,
        dev2Id,
        dev2Pub,
        cert1Hash
      )

      const payload: ChatPayload = {
        kind: "chat-message",
        version: 1,
        workspaceId,
        personId: owner.identity.personId,
        deviceId: dev2Id,
        id: `${dev2Id}:${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        text: "Delegated by non-enroller",
        revision: 0,
      }

      const signed = await signEnvelope(dev2KeyPair.privateKey, payload, dev2Id)
      const record: ChatRecord = {
        signed,
        publicKey: owner.identity.publicKey,
        certificates: [cert2, nonEnrollerCert],
        authority: {
          publicKey: owner.identity.publicKey,
          certificates: [nonEnrollerCert],
        },
      }

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid certificate chain")
    })

    it("rejects certificate with mismatched personId", async () => {
      const owner = await createProfile("Owner Alice")
      const stranger = await createProfile("Stranger")

      // Certificate with stranger's personId placed in owner's cert pool
      const badCert: DeviceCertificate = {
        ...owner.certificate,
        payload: {
          ...owner.certificate.payload,
          personId: stranger.identity.personId,
        },
      }

      const record: ChatRecord = {
        signed: await signEnvelope(
          owner.privateKeys.devicePrivateKey,
          {
            kind: "chat-message",
            version: 1,
            workspaceId,
            personId: owner.identity.personId,
            deviceId: owner.device.deviceId,
            id: `${owner.device.deviceId}:${crypto.randomUUID()}`,
            createdAt: new Date().toISOString(),
            text: "Mismatched personId cert",
            revision: 0,
          },
          owner.device.deviceId
        ),
        publicKey: owner.identity.publicKey,
        certificates: [badCert],
        authority: makeOwnerAuthority(owner),
      }

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid device certificate")
    })

    it("rejects certificate where devicePublicKey does not match deviceId", async () => {
      const owner = await createProfile("Owner Alice")

      const badCert: DeviceCertificate = {
        ...owner.certificate,
        payload: {
          ...owner.certificate.payload,
          deviceId: "tampered_device_id",
        },
      }

      const record: ChatRecord = {
        signed: await signEnvelope(
          owner.privateKeys.devicePrivateKey,
          {
            kind: "chat-message",
            version: 1,
            workspaceId,
            personId: owner.identity.personId,
            deviceId: "tampered_device_id",
            id: `tampered_device_id:${crypto.randomUUID()}`,
            createdAt: new Date().toISOString(),
            text: "DeviceId mismatch",
            revision: 0,
          },
          "tampered_device_id"
        ),
        publicKey: owner.identity.publicKey,
        certificates: [badCert],
        authority: makeOwnerAuthority(owner),
      }

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid device certificate")
    })

    it("rejects a device certificate chain renewed by the same already trusted device", async () => {
      const owner = await createProfile("Owner Alice")

      const cert1Hash = await certHashDefault(owner.certificate)
      const renewedCert = await createDelegatedCertificate(
        owner.privateKeys.devicePrivateKey,
        owner.device.deviceId,
        owner.identity.personId,
        owner.device.deviceId,
        owner.device.publicKey,
        cert1Hash
      )

      // When traversing from loopCert -> owner.certificate, the same deviceId is seen twice
      const payload: ChatPayload = {
        kind: "chat-message",
        version: 1,
        workspaceId,
        personId: owner.identity.personId,
        deviceId: owner.device.deviceId,
        id: `${owner.device.deviceId}:${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        text: "Certificate renewed",
        revision: 0,
      }

      const signed = await signEnvelope(
        owner.privateKeys.devicePrivateKey,
        payload,
        owner.device.deviceId
      )

      const record: ChatRecord = {
        signed,
        publicKey: owner.identity.publicKey,
        certificates: [renewedCert, owner.certificate],
        authority: makeOwnerAuthority(owner),
      }

      await expect(verifyChatRecord(record, workspaceId, owner.identity.personId)).rejects.toThrow("Invalid device certificate")
    })

    it("rejects certificate chain exceeding maximum length 32", async () => {
      const owner = await createProfile("Owner Alice")
      const authority = makeOwnerAuthority(owner)

      // 33 certificates in chain
      const hugeCertList = new Array(33).fill(owner.certificate)

      const record: ChatRecord = {
        signed: await signEnvelope(
          owner.privateKeys.devicePrivateKey,
          {
            kind: "chat-message",
            version: 1,
            workspaceId,
            personId: owner.identity.personId,
            deviceId: owner.device.deviceId,
            id: `${owner.device.deviceId}:${crypto.randomUUID()}`,
            createdAt: new Date().toISOString(),
            text: "Too many certs",
            revision: 0,
          },
          owner.device.deviceId
        ),
        publicKey: owner.identity.publicKey,
        certificates: hugeCertList,
        authority,
      }

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid certificate chain")
    })

    it("rejects record when envelope signerKeyId does not match payload deviceId", async () => {
      const owner = await createProfile("Owner Alice")
      const authority = makeOwnerAuthority(owner)

      const payload: ChatPayload = {
        kind: "chat-message",
        version: 1,
        workspaceId,
        personId: owner.identity.personId,
        deviceId: owner.device.deviceId,
        id: `${owner.device.deviceId}:${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        text: "Mismatched signerKeyId",
        revision: 0,
      }

      // signerKeyId intentionally different from payload.deviceId
      const signed = await signEnvelope(
        owner.privateKeys.devicePrivateKey,
        payload,
        "different_device_id"
      )

      const record: ChatRecord = {
        signed,
        publicKey: owner.identity.publicKey,
        certificates: [owner.certificate],
        authority,
      }

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid chat record")
    })

    it("rejects record with invalid workspace authority public key", async () => {
      const owner = await createProfile("Owner Alice")
      const impostor = await createProfile("Impostor Authority")

      // Authority has impostor's public key instead of owner's
      const invalidAuthority: ChatAuthority = {
        publicKey: impostor.identity.publicKey,
        certificates: [owner.certificate],
      }

      const record = await createChatRecord(
        owner,
        [owner.certificate],
        invalidAuthority,
        workspaceId,
        "chat-message",
        "Wrong authority"
      )

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid workspace authority")
    })
  })

  describe("8. Oversized and future-dated records rejected", () => {
    it("rejects record exceeding 32,768 serialized JSON bytes", async () => {
      const owner = await createProfile("Owner Alice")
      const authority = makeOwnerAuthority(owner)

      const record = await createChatRecord(
        owner,
        [owner.certificate],
        authority,
        workspaceId,
        "chat-message",
        "Valid text"
      )

      // Attach oversized metadata
      const oversized = {
        ...record,
        extraPadding: "A".repeat(35000),
      }

      await expect(
        verifyChatRecord(oversized, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Chat record too large")
    })

    it("rejects chat message body exceeding 8,000 Unicode codepoints", async () => {
      const owner = await createProfile("Owner Alice")
      const authority = makeOwnerAuthority(owner)

      const text8001 = "x".repeat(8001)

      const record = await createChatRecord(
        owner,
        [owner.certificate],
        authority,
        workspaceId,
        "chat-message",
        text8001
      )

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Message must contain 1–8,000 characters")
    })

    it("rejects empty or whitespace-only chat message text", async () => {
      const owner = await createProfile("Owner Alice")
      const authority = makeOwnerAuthority(owner)

      const recordEmpty = await createChatRecord(
        owner,
        [owner.certificate],
        authority,
        workspaceId,
        "chat-message",
        ""
      )
      await expect(
        verifyChatRecord(recordEmpty, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Message must contain 1–8,000 characters")

      const recordSpaces = await createChatRecord(
        owner,
        [owner.certificate],
        authority,
        workspaceId,
        "chat-message",
        "   \t\n   "
      )
      await expect(
        verifyChatRecord(recordSpaces, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Message must contain 1–8,000 characters")
    })

    it("rejects future-dated record exceeding 5-minute threshold", async () => {
      const owner = await createProfile("Owner Alice")
      const authority = makeOwnerAuthority(owner)

      // 10 minutes in the future (> 300,000 ms limit)
      const futureTime = new Date(Date.now() + 600_000).toISOString()

      const payload: ChatPayload = {
        kind: "chat-message",
        version: 1,
        workspaceId,
        personId: owner.identity.personId,
        deviceId: owner.device.deviceId,
        id: `${owner.device.deviceId}:${crypto.randomUUID()}`,
        createdAt: futureTime,
        text: "I am from the future",
        revision: 0,
      }

      const signed = await signEnvelope(
        owner.privateKeys.devicePrivateKey,
        payload,
        owner.device.deviceId
      )

      const record: ChatRecord = {
        signed,
        publicKey: owner.identity.publicKey,
        certificates: [owner.certificate],
        authority,
      }

      await expect(
        verifyChatRecord(record, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid chat record")
    })

    it("rejects record with malformed or non-canonical createdAt timestamp", async () => {
      const owner = await createProfile("Owner Alice")
      const authority = makeOwnerAuthority(owner)

      // Non-date string
      const payloadBadDate: ChatPayload = {
        kind: "chat-message",
        version: 1,
        workspaceId,
        personId: owner.identity.personId,
        deviceId: owner.device.deviceId,
        id: `${owner.device.deviceId}:${crypto.randomUUID()}`,
        createdAt: "not-a-valid-iso-date",
        text: "Malformed timestamp",
        revision: 0,
      }

      const recordBadDate: ChatRecord = {
        signed: await signEnvelope(
          owner.privateKeys.devicePrivateKey,
          payloadBadDate,
          owner.device.deviceId
        ),
        publicKey: owner.identity.publicKey,
        certificates: [owner.certificate],
        authority,
      }

      await expect(
        verifyChatRecord(recordBadDate, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid chat record")

      // Non-canonical format (missing milliseconds / time components: e.g. "2026-09-10")
      const payloadNonCanonical: ChatPayload = {
        kind: "chat-message",
        version: 1,
        workspaceId,
        personId: owner.identity.personId,
        deviceId: owner.device.deviceId,
        id: `${owner.device.deviceId}:${crypto.randomUUID()}`,
        createdAt: "2026-09-10",
        text: "Non canonical date",
        revision: 0,
      }

      const recordNonCanonical: ChatRecord = {
        signed: await signEnvelope(
          owner.privateKeys.devicePrivateKey,
          payloadNonCanonical,
          owner.device.deviceId
        ),
        publicKey: owner.identity.publicKey,
        certificates: [owner.certificate],
        authority,
      }

      await expect(
        verifyChatRecord(recordNonCanonical, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid chat record")
    })

    it("rejects record with invalid revision number", async () => {
      const owner = await createProfile("Owner Alice")
      const authority = makeOwnerAuthority(owner)

      const payloadNegativeRev: ChatPayload = {
        kind: "chat-message",
        version: 1,
        workspaceId,
        personId: owner.identity.personId,
        deviceId: owner.device.deviceId,
        id: `${owner.device.deviceId}:${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        text: "Negative revision",
        revision: -1,
      }

      const recordNegativeRev: ChatRecord = {
        signed: await signEnvelope(
          owner.privateKeys.devicePrivateKey,
          payloadNegativeRev,
          owner.device.deviceId
        ),
        publicKey: owner.identity.publicKey,
        certificates: [owner.certificate],
        authority,
      }

      await expect(
        verifyChatRecord(recordNegativeRev, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid chat record")
    })

    it("rejects record with payload ID not starting with deviceId prefix", async () => {
      const owner = await createProfile("Owner Alice")
      const authority = makeOwnerAuthority(owner)

      const payloadBadId: ChatPayload = {
        kind: "chat-message",
        version: 1,
        workspaceId,
        personId: owner.identity.personId,
        deviceId: owner.device.deviceId,
        id: `wrong_prefix:${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        text: "ID prefix mismatch",
        revision: 0,
      }

      const recordBadId: ChatRecord = {
        signed: await signEnvelope(
          owner.privateKeys.devicePrivateKey,
          payloadBadId,
          owner.device.deviceId
        ),
        publicKey: owner.identity.publicKey,
        certificates: [owner.certificate],
        authority,
      }

      await expect(
        verifyChatRecord(recordBadId, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid chat record")
    })

    it("rejects chat-profile with invalid or unnormalized display name", async () => {
      const owner = await createProfile("Owner Alice")
      const authority = makeOwnerAuthority(owner)

      // Unnormalized display name (leading and trailing whitespace)
      const recordUnnormalized = await createChatRecord(
        owner,
        [owner.certificate],
        authority,
        workspaceId,
        "chat-profile",
        "  Alice  "
      )

      await expect(
        verifyChatRecord(recordUnnormalized, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid display name")

      // Display name with illegal control character
      const recordControlChar = await createChatRecord(
        owner,
        [owner.certificate],
        authority,
        workspaceId,
        "chat-profile",
        "Alice\u0000Smith"
      )

      await expect(
        verifyChatRecord(recordControlChar, workspaceId, owner.identity.personId)
      ).rejects.toThrow("Invalid display name")
    })
  })
})
