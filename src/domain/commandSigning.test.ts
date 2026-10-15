import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { initializeAutomerge } from "../crdt"
import { adoptEnrolledIdentity, bootstrapIdentity, resetIdentityStorageForTest, verifyEnvelope, type LocalProfile } from "./identity"
import { certHashDefault, createDelegatedCertificate, defaultProofStore } from "./proofs"
import { executeCommand, executeReviewedWorkspaceChange } from "./commands"
import { createWorkspaceDoc } from "./seeds"
import { resolveSigningContext } from "./signingContext"
import type { WorkspaceDocumentV2 } from "./model"
import { createActorBinding } from "./transactionProofs"

let profile: LocalProfile
const documents: Automerge.Doc<WorkspaceDocumentV2>[] = []
vi.mock("@automerge/automerge/slim", async () => {
  const actual = await vi.importActual<typeof Automerge>("@automerge/automerge/slim")
  return { ...actual, clone: vi.fn(actual.clone), change: vi.fn(actual.change),
    getLastLocalChange: vi.fn(actual.getLastLocalChange), free: vi.fn(actual.free) }
})
beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})
beforeEach(async () => { resetIdentityStorageForTest(); profile = await bootstrapIdentity("Owner") })
afterEach(() => {
  documents.splice(0).forEach(doc => Automerge.free(doc))
  vi.restoreAllMocks(); resetIdentityStorageForTest()
})
function document() {
  const doc = Automerge.from(createWorkspaceDoc("command-signer", "Original", profile.identity.personId, "job-search"))
  documents.push(doc)
  return doc
}
async function delegated(retainIssuer: boolean) {
  const issuer = profile
  resetIdentityStorageForTest()
  const temporary = await bootstrapIdentity("Second device")
  const certificate = await createDelegatedCertificate(issuer.privateKeys.devicePrivateKey, issuer.device.deviceId,
    issuer.identity.personId, temporary.device.deviceId, temporary.device.publicKey, await certHashDefault(issuer.certificate))
  profile = await adoptEnrolledIdentity(issuer.identity, certificate) as LocalProfile
  if (retainIssuer) await defaultProofStore.putCertificate(await certHashDefault(issuer.certificate), issuer.certificate)
}

it("Given another device's private key, when authoring a local command, then reject before returning a signed transaction", async () => {
  const key = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
  const doc = document()
  await expect(executeCommand(doc, { kind: "renameWorkspace", title: "Changed" },
    { ...profile, privateKeys: { devicePrivateKey: key.privateKey } })).rejects.toThrow(/key|signer/i)
  expect(doc.title).toBe("Original")
})

it("Given a delegated device without its issuer, when authoring, then reject incomplete evidence", async () => {
  await delegated(false)
  await expect(executeCommand(document(), { kind: "renameWorkspace", title: "Changed" }, profile))
    .rejects.toThrow(/ancestor|certificate|chain/i)
})

it("Given an enrolled device with its full chain, when authoring, then retain the existing transaction proof wire and signer", async () => {
  await delegated(true)
  const result = await executeCommand(document(), { kind: "renameWorkspace", title: "Changed" }, profile)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  documents.push(result.value.newDoc)
  expect(result.value.proof.payload).toEqual({ kind: "change-proof", version: 1,
    documentId: "command-signer", changeHash: result.value.receipt.changeHash,
    actorBindingHash: expect.any(String) })
  expect(result.value.proof.signerKeyId).toBe(profile.device.deviceId)
  expect(await verifyEnvelope(result.value.proof, profile.device.publicKey)).toBe(true)
})

it("Given live workspace authority, when rights change during the transaction signature, then reject the command", async () => {
  const doc = document()
  let revision = "approved"
  const original = crypto.subtle.sign.bind(crypto.subtle)
  vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
    const result = await original(...args)
    if (new TextDecoder().decode(args[2] as Uint8Array).includes('"actor-binding"')) revision = "revoked"
    return result
  })
  const signingContext = (purpose: string, binding: Record<string, string | number>) => resolveSigningContext({
    profile, purpose, binding, certificates: [profile.certificate], authorityRevision: "approved",
    current: async () => ({ personId: profile.identity.personId, deviceId: profile.device.deviceId, authorityRevision: revision }),
  })
  await expect(executeCommand(doc, { kind: "renameWorkspace", title: "Changed" }, profile,
    undefined, undefined, signingContext)).rejects.toThrow(/stale|authority/i)
  expect(doc.title).toBe("Original")
})

it("Given a caller-owned profile, when it mutates after actor binding starts, then the signed author remains the captured device", async () => {
  const detached = { ...profile, identity: structuredClone(profile.identity), device: structuredClone(profile.device) }
  const context = await resolveSigningContext({ profile, certificates: [profile.certificate], purpose: "actor-binding",
    binding: { documentId: "command-signer", actorId: "actor" }, authorityRevision: "captured",
    current: async () => ({ personId: profile.identity.personId, deviceId: profile.device.deviceId, authorityRevision: "captured" }),
  })
  const pending = createActorBinding(detached, "command-signer", "actor", context)
  detached.identity.personId = "substituted-person"
  detached.device.deviceId = "substituted-device"
  const signed = await pending
  expect(signed.payload.personId).toBe(profile.identity.personId)
  expect(signed.payload.deviceId).toBe(profile.device.deviceId)
  expect(await verifyEnvelope(signed, profile.device.publicKey)).toBe(true)
})

it.each(["command", "review"])("Given a private %s clone, when mutation throws, then release the clone and preserve the input", async mode => {
  const doc = document()
  const cloned = vi.mocked(Automerge.clone)
  cloned.mockClear()
  vi.mocked(Automerge.change).mockImplementationOnce(() => { throw new Error("Injected mutation failure") })
  try {
    const operation = mode === "command" ? executeCommand(doc, { kind: "renameWorkspace", title: "Changed" }, profile)
      : executeReviewedWorkspaceChange(doc, "quarantined-hash", { root: { title: "Changed" }, entities: [] }, profile)
    await expect(operation).rejects.toThrow("Injected mutation failure")
    expect(Automerge.free).toHaveBeenCalledWith(cloned.mock.results[0]!.value)
    expect(doc.title).toBe("Original")
  } finally {
    const handle = cloned.mock.results[0]?.value as Automerge.Doc<WorkspaceDocumentV2> | undefined
    if (handle && !vi.mocked(Automerge.free).mock.calls.some(([freed]) => freed === handle)) Automerge.free(handle)
  }
})

it("Given an unexpected empty change, when authoring a command, then release the private clone before returning failure", async () => {
  const doc = document()
  vi.mocked(Automerge.getLastLocalChange).mockReturnValueOnce(undefined)
  const free = vi.mocked(Automerge.free)
  free.mockClear()
  const result = await executeCommand(doc, { kind: "renameWorkspace", title: "Changed" }, profile)
  expect(result.ok).toBe(false)
  expect(free).toHaveBeenCalledTimes(1)
  expect(doc.title).toBe("Original")
})
