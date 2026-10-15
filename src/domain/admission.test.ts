import { createActorBinding, createChangeProof } from "./transactionProofs"
import { beforeAll, describe, expect, it, beforeEach, vi } from "vitest"
import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import {
  bootstrapIdentity,
  resetIdentityStorageForTest,
  sha256Base64Url,
  canonicalizeJson,
} from "./identity"
import { ProofStore } from "./proofs"
import { AdmissionController } from "./admission"
import { createWorkspaceDoc } from "./seeds"
import type { WorkspaceDocumentV2 } from "./model"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("Trusted-document admission and missing-proof queue (Requirement 2.3)", () => {
  beforeEach(() => {
    resetIdentityStorageForTest()
  })

  it("admits verified change when complete proof and certificate chain exist", async () => {
    const profile = await bootstrapIdentity("Alice")
    const proofStore = new ProofStore()
    const admission = new AdmissionController(proofStore)

    // Store Alice's root certificate
    const certBytes = new TextEncoder().encode(canonicalizeJson(profile.certificate))
    const certHash = await sha256Base64Url(certBytes)
    await proofStore.putCertificate(certHash, profile.certificate)

    const rawWs = createWorkspaceDoc("ws_admit", "Admit Board", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)

    // Make an edit with actor binding and change proof
    const actorId = Automerge.getActorId(doc)
    const binding = await createActorBinding(profile, "ws_admit", actorId)
    const bindingBytes = new TextEncoder().encode(canonicalizeJson(binding))
    const bindingHash = await sha256Base64Url(bindingBytes)
    await proofStore.putActorBinding(bindingHash, binding)

    const metadata = {
      version: 1,
      transactionId: crypto.randomUUID(),
      action: "createItem",
      entityIds: ["item_1"],
      personId: profile.identity.personId,
      deviceId: profile.device.deviceId,
    }

    const nextDoc = Automerge.change(doc, { message: JSON.stringify(metadata) }, (draft) => {
      draft.title = "Updated Title"
    })
    const changeBytes = Automerge.getLastLocalChange(nextDoc)!
    const decoded = Automerge.decodeChange(changeBytes)
    const changeHash = decoded.hash

    const proof = await createChangeProof(profile, "ws_admit", changeHash, bindingHash)
    await proofStore.putChangeProof(changeHash, proof)

    const res = await admission.admitChange("ws_admit", changeBytes, profile.identity.publicKey)
    expect(res.admitted).toBe(true)
  })

  it("rejects forged or unauthorized changes", async () => {
    const alice = await bootstrapIdentity("Alice")
    const mallory = await bootstrapIdentity("Mallory")
    const proofStore = new ProofStore()
    const admission = new AdmissionController(proofStore)

    const rawWs = createWorkspaceDoc("ws_auth", "Auth Board", alice.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)

    // Mallory creates a change claiming Alice's personId
    const metadata = {
      version: 1,
      transactionId: crypto.randomUUID(),
      action: "createItem",
      entityIds: ["item_malicious"],
      personId: alice.identity.personId,
      deviceId: mallory.device.deviceId,
    }

    const nextDoc = Automerge.change(doc, { message: JSON.stringify(metadata) }, (draft) => {
      draft.title = "Hacked Title"
    })
    const changeBytes = Automerge.getLastLocalChange(nextDoc)!

    // Admission must reject because no valid certificate binds Mallory to Alice
    const res = await admission.admitChange("ws_auth", changeBytes, alice.identity.publicKey)
    expect(res.admitted).toBe(false)
  })

  it("holds changes with missing proofs in pending queue and admits when proof arrives", async () => {
    const profile = await bootstrapIdentity("Alice")
    const proofStore = new ProofStore()
    const admission = new AdmissionController(proofStore)

    const rawWs = createWorkspaceDoc("ws_queue", "Queue Board", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)

    const actorId = Automerge.getActorId(doc)
    const binding = await createActorBinding(profile, "ws_queue", actorId)
    const bindingBytes = new TextEncoder().encode(canonicalizeJson(binding))
    const bindingHash = await sha256Base64Url(bindingBytes)

    const metadata = {
      version: 1,
      transactionId: crypto.randomUUID(),
      action: "createItem",
      entityIds: ["item_delayed"],
      personId: profile.identity.personId,
      deviceId: profile.device.deviceId,
    }

    const nextDoc = Automerge.change(doc, { message: JSON.stringify(metadata) }, (draft) => {
      draft.title = "Delayed Proof Title"
    })
    const changeBytes = Automerge.getLastLocalChange(nextDoc)!
    const decoded = Automerge.decodeChange(changeBytes)
    const changeHash = decoded.hash

    // Submit change BEFORE storing proof
    const res1 = await admission.admitChange("ws_queue", changeBytes, profile.identity.publicKey)
    expect(res1.admitted).toBe(false)
    if (!res1.admitted) {
      expect(res1.status).toBe("pending_proof")
    }
    expect(admission.getPendingQueueSize("ws_queue")).toBe(1)

    // Now supply missing certificate, actor binding, and proof
    const certBytes = new TextEncoder().encode(canonicalizeJson(profile.certificate))
    const certHash = await sha256Base64Url(certBytes)
    await proofStore.putCertificate(certHash, profile.certificate)
    await proofStore.putActorBinding(bindingHash, binding)

    const proof = await createChangeProof(profile, "ws_queue", changeHash, bindingHash)
    await proofStore.putChangeProof(changeHash, proof)

    // Retry / drain pending queue
    const admittedCount = await admission.drainPendingQueue("ws_queue", profile.identity.publicKey)
    expect(admittedCount).toBe(1)
    expect(admission.getPendingQueueSize("ws_queue")).toBe(0)
  })
})
