import { createActorBinding } from "./transactionProofs"
import { describe, expect, it, beforeEach } from "vitest"
import { deleteLocal, readLocal, writeLocal } from "../localDb"
import {
  canonicalizeJson,
  signEnvelope,
  verifyEnvelope,
  bootstrapIdentity,
  resetIdentityStorageForTest,
  sha256Base64Url,
} from "./identity"
import {
  validateCertificateChain,
  createDelegatedCertificate,
  createWorkspaceGenesis,
  createWorkspaceGrant,
  createAutomationWorkspaceGrant,
  verifyWorkspaceGrant,
  verifyWorkspaceGenesis,
  ProofStore,
} from "./proofs"
import type { DeviceCertificate } from "./model"

describe("Cryptographic proofs, authority, and certificate chains (Requirement 2.2)", () => {
  beforeEach(() => {
    resetIdentityStorageForTest()
  })

  it("Given malformed or newer durable proof evidence, when adding a certificate, then reject without replacing recovery data", async () => {
    const key = "tincanban.v1.proof_store"
    await deleteLocal(key)
    try {
      const profile = await bootstrapIdentity("Owner")
      const store = new ProofStore()
      await store.listCertificates()
      for (const raw of ["{broken", JSON.stringify({ certificates: [] }), JSON.stringify({ futureEvidence: { retained: true } })]) {
        await writeLocal(key, raw)
        await expect(store.putCertificate("new", profile.certificate)).rejects.toThrow(/proof|evidence|upgrade/i)
        expect(await readLocal(key)).toBe(raw)
      }
    } finally { await deleteLocal(key) }
  })

  it("Given grants for two workspaces, when one leaves the mesh, then only that workspace grants are removed", async () => {
    const owner = await bootstrapIdentity("Owner")
    const store = new ProofStore()
    const alpha = await createWorkspaceGrant(owner, "ws_alpha", "member", "editor")
    const beta = await createWorkspaceGrant(owner, "ws_beta", "member", "visitor")
    await store.putGrant(alpha.payload.grantId, alpha)
    await store.putGrant(beta.payload.grantId, beta)

    await store.removeWorkspaceGrants("ws_alpha")

    expect(await store.listGrants("ws_alpha")).toEqual([])
    expect(await store.listGrants("ws_beta")).toEqual([beta])
  })

  it("Given two proof-store instances loaded from one base, when each adds certificates and grants, then retain every durable record", async () => {
    const key = "tincanban.v1.proof_store"
    await deleteLocal(key)
    try {
      const alpha = await bootstrapIdentity("Alpha")
      resetIdentityStorageForTest()
      const beta = await bootstrapIdentity("Beta")
      const first = new ProofStore()
      const second = new ProofStore()
      await Promise.all([first.listCertificates(), second.listCertificates(), first.listGrants(), second.listGrants()])
      const alphaGrant = await createWorkspaceGrant(alpha, "workspace-alpha", "member-alpha", "editor")
      const betaGrant = await createWorkspaceGrant(beta, "workspace-beta", "member-beta", "visitor")

      await first.putCertificate("alpha-cert", alpha.certificate)
      await second.putCertificate("beta-cert", beta.certificate)
      await first.putGrant(alphaGrant.payload.grantId, alphaGrant)
      await second.putGrant(betaGrant.payload.grantId, betaGrant)

      const reopened = new ProofStore()
      expect((await reopened.listCertificates()).map(value => value.payload.deviceId).sort())
        .toEqual([alpha.certificate.payload.deviceId, beta.certificate.payload.deviceId].sort())
      expect((await reopened.listGrants()).map(value => value.payload.grantId).sort())
        .toEqual([alphaGrant.payload.grantId, betaGrant.payload.grantId].sort())
    } finally { await deleteLocal(key) }
  })

  it("Given retained signed records, when callers mutate inputs or getter results and another save occurs, then preserve stored evidence", async () => {
    const key = "tincanban.v1.proof_store"
    await deleteLocal(key)
    try {
      const profile = await bootstrapIdentity("Owner")
      const store = new ProofStore()
      const originalCertificate = structuredClone(profile.certificate)
      const certificateInput = structuredClone(originalCertificate)
      await store.putCertificate("owner-cert", certificateInput)
      certificateInput.payload.deviceId = "mutated-input"
      const certificateRead = await store.getCertificate("owner-cert")
      certificateRead!.payload.deviceId = "mutated-read"

      const originalGrant = await createWorkspaceGrant(profile, "workspace", "member", "editor")
      const grantInput = structuredClone(originalGrant)
      await store.putGrant(originalGrant.payload.grantId, grantInput)
      grantInput.payload.workspaceId = "mutated-input"
      const grantRead = await store.getGrant(originalGrant.payload.grantId)
      grantRead!.payload.workspaceId = "mutated-read"

      await store.putGenesis("workspace", await createWorkspaceGenesis(profile, "workspace", []))
      const reopened = new ProofStore()
      expect(await reopened.getCertificate("owner-cert")).toEqual(originalCertificate)
      expect(await reopened.getGrant(originalGrant.payload.grantId)).toEqual(originalGrant)
    } finally { await deleteLocal(key) }
  })

  it("Given a stale proof-store snapshot, when another instance removes workspace grants, then unrelated writes cannot resurrect them", async () => {
    const key = "tincanban.v1.proof_store"
    await deleteLocal(key)
    try {
      const profile = await bootstrapIdentity("Owner")
      const remover = new ProofStore()
      const removed = await createWorkspaceGrant(profile, "removed-workspace", "member-a", "editor")
      const retained = await createWorkspaceGrant(profile, "retained-workspace", "member-b", "visitor")
      await remover.putGrant(removed.payload.grantId, removed)
      await remover.putGrant(retained.payload.grantId, retained)

      const stale = new ProofStore()
      await stale.listGrants()
      await remover.removeWorkspaceGrants("removed-workspace")
      await stale.putCertificate("owner-cert", profile.certificate)

      const reopened = new ProofStore()
      expect(await reopened.listGrants("removed-workspace")).toEqual([])
      expect(await reopened.listGrants("retained-workspace")).toEqual([retained])
    } finally { await deleteLocal(key) }
  })

  it("canonicalizes JSON according to RFC 8785 and rejects non-finite numbers", () => {
    const a = { z: 1, a: "hello", m: [3, 2, 1] }
    const b = { a: "hello", m: [3, 2, 1], z: 1 }
    expect(canonicalizeJson(a)).toBe(canonicalizeJson(b))
    expect(canonicalizeJson(a)).toBe('{"a":"hello","m":[3,2,1],"z":1}')

    expect(() => canonicalizeJson({ invalid: Infinity })).toThrow(/non-finite/i)
    expect(() => canonicalizeJson({ invalid: NaN })).toThrow(/non-finite/i)
  })

  it("verifies signatures and detects tampering", async () => {
    const profile = await bootstrapIdentity("Tamper Test")
    const payload = { kind: "test-payload", version: 1, message: "original" }
    const signed = await signEnvelope(profile.privateKeys.devicePrivateKey, payload, profile.device.deviceId)

    // Valid signature
    expect(await verifyEnvelope(signed, profile.device.publicKey)).toBe(true)

    // Tampered payload
    const tamperedPayload = { ...signed, payload: { ...payload, message: "tampered" } }
    expect(await verifyEnvelope(tamperedPayload, profile.device.publicKey)).toBe(false)

    // Tampered signature
    const tamperedSig = { ...signed, signature: signed.signature.slice(0, -4) + "AAAA" }
    expect(await verifyEnvelope(tamperedSig, profile.device.publicKey)).toBe(false)
  })

  it("Given approved board scope, when owner creates automation grant, then signs exact bounded scope", async () => {
    const owner = await bootstrapIdentity("Owner")
    const scope = { version: 1 as const, boardId: "board-1", columns: { lead: "lead", interview: "interview", rejected: "rejected" }, fieldIds: ["company", "role"], expiresAt: Date.now() + 60_000 }
    const grant = await createAutomationWorkspaceGrant(owner, "workspace-1", "automation-person", scope)
    expect(grant.payload.role).toBe("automation")
    expect(grant.payload.automation).toEqual(scope)
    expect(await verifyWorkspaceGrant(grant, owner.device.publicKey)).toBe(true)
    const expired = await signEnvelope(owner.privateKeys.devicePrivateKey, {
      kind: "workspace-grant" as const, version: 1 as const, grantId: "expired-grant",
      workspaceId: "workspace-1", personId: "automation-person", role: "automation" as const,
      accessEpoch: 1,
      automation: { ...scope, expiresAt: Date.now() - 1 },
    }, owner.device.deviceId)
    expect(await verifyWorkspaceGrant(expired, owner.device.publicKey)).toBe(false)
    await expect(createAutomationWorkspaceGrant(owner, "workspace-1", "automation-person", { ...scope, columns: { ...scope.columns, rejected: "lead" } }))
      .rejects.toThrow(/scope/i)
    await expect(createAutomationWorkspaceGrant(owner, "workspace-1", "automation-person", { ...scope, expiresAt: Date.now() - 1 }))
      .rejects.toThrow(/scope/i)
    await expect(createAutomationWorkspaceGrant(owner, "workspace-1", "automation-person", { ...scope, boardId: "board-1", extra: true } as never))
      .rejects.toThrow(/scope/i)
    await expect(createWorkspaceGrant(owner, "workspace-1", "automation-person", "automation" as never))
      .rejects.toThrow(/automation/i)
  })

  it("validates root-issued device certificates", async () => {
    const profile = await bootstrapIdentity("Alice")
    const valid = await validateCertificateChain(profile.certificate, profile.identity.publicKey, [])
    expect(valid.ok).toBe(true)
  })

  it("validates delegated device certificates across chains", async () => {
    const profile = await bootstrapIdentity("Alice")

    // Device 2
    const dev2KeyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair
    const dev2RawPub = new Uint8Array(await crypto.subtle.exportKey("raw", dev2KeyPair.publicKey))
    const dev2Id = await sha256Base64Url(dev2RawPub)
    const dev2Pub = btoa(String.fromCharCode(...dev2RawPub)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

    // Calculate cert 1 hash
    const cert1Bytes = new TextEncoder().encode(canonicalizeJson(profile.certificate))
    const cert1Hash = await sha256Base64Url(cert1Bytes)

    // Device 1 (authorized to enroll) delegates to Device 2
    const cert2 = await createDelegatedCertificate(
      profile.privateKeys.devicePrivateKey,
      profile.device.deviceId,
      profile.identity.personId,
      dev2Id,
      dev2Pub,
      cert1Hash
    )

    // Validate chain: cert2 -> cert1 -> identity
    const valid = await validateCertificateChain(cert2, profile.identity.publicKey, [profile.certificate])
    expect(valid.ok).toBe(true)
  })

  it("detects and rejects cycles in certificate chains", async () => {
    const profile = await bootstrapIdentity("Alice")

    // Create a circular chain: cert A -> cert B -> cert A
    const fakeCertA: DeviceCertificate = {
      payload: {
        kind: "device-certificate",
        version: 1,
        personId: profile.identity.personId,
        deviceId: "dev_A",
        devicePublicKey: profile.device.publicKey,
        issuerCertificateHash: "hash_B",
        canEnrollDevices: true,
      },
      signerKeyId: "dev_B",
      signature: profile.certificate.signature,
    }

    const fakeCertB: DeviceCertificate = {
      payload: {
        kind: "device-certificate",
        version: 1,
        personId: profile.identity.personId,
        deviceId: "dev_B",
        devicePublicKey: profile.device.publicKey,
        issuerCertificateHash: "hash_A",
        canEnrollDevices: true,
      },
      signerKeyId: "dev_A",
      signature: profile.certificate.signature,
    }

    const pool = [fakeCertA, fakeCertB]
    const res = await validateCertificateChain(fakeCertA, profile.identity.publicKey, pool, {
      hashFn: (c) => (c === fakeCertA ? "hash_A" : "hash_B"),
      skipSigVerify: true,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toMatch(/cycle/i)
    }
  })

  it("rejects chains exceeding maximum depth 32", async () => {
    const profile = await bootstrapIdentity("Alice")
    // Build a mock chain with 33 levels
    const pool: DeviceCertificate[] = []
    let prevHash: string | null = null

    for (let i = 0; i < 35; i++) {
      const cert: DeviceCertificate = {
        payload: {
          kind: "device-certificate",
          version: 1,
          personId: profile.identity.personId,
          deviceId: `dev_${i}`,
          devicePublicKey: profile.device.publicKey,
          issuerCertificateHash: prevHash,
          canEnrollDevices: true,
        },
        signerKeyId: i === 0 ? profile.identity.personId : `dev_${i - 1}`,
        signature: profile.certificate.signature,
      }
      pool.push(cert)
      prevHash = `hash_${i}`
    }

    const deepestCert = pool[pool.length - 1]
    const res = await validateCertificateChain(deepestCert, profile.identity.publicKey, pool, {
      hashFn: (c) => `hash_${c.payload.deviceId.replace("dev_", "")}`,
      skipSigVerify: true,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toMatch(/depth/i)
    }
  })

  it("creates and verifies workspace genesis and grants", async () => {
    const profile = await bootstrapIdentity("Alice")
    const genesis = await createWorkspaceGenesis(profile, "ws_123", ["head_1"])
    const validGenesis = await verifyWorkspaceGenesis(genesis, profile.identity.publicKey)
    expect(validGenesis).toBe(true)

    // Issue grant to Bob
    const grant = await createWorkspaceGrant(profile, "ws_123", "person_bob", "editor")
    const validGrant = await verifyWorkspaceGrant(grant, profile.device.publicKey)
    expect(validGrant).toBe(true)
    expect(grant.payload.role).toBe("editor")
  })

  it("stores and queries proofs in ProofStore", async () => {
    const profile = await bootstrapIdentity("Alice")
    const store = new ProofStore()

    const binding = await createActorBinding(profile, "ws_123", "actor_1")
    const bindingBytes = new TextEncoder().encode(canonicalizeJson(binding))
    const bindingHash = await sha256Base64Url(bindingBytes)

    await store.putActorBinding(bindingHash, binding)
    const retrieved = await store.getActorBinding(bindingHash)
    expect(retrieved).toBeDefined()
    expect(retrieved?.payload.actorId).toBe("actor_1")
  })
})
