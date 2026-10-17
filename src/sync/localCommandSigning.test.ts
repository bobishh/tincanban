import { readFile } from "node:fs/promises"
import { IDBFactory } from "fake-indexeddb"
import * as Automerge from "@automerge/automerge/slim"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, toBase64Url } from "../domain/identity"
import { createWorkspaceDoc } from "../test/boardFixture"
import { executeCommand, type Command } from "../domain/commands"
import { assertWorkspaceCommand } from "../domain/permissions"
import { recordGenesisAuthority, workspaceRole } from "./changeAuthorization"
import { createWorkspaceDeviceRevocation } from "./meshRecords"
import { peerStore } from "./peerStore"
import { localCommandSigningContext } from "./localCommandSigning"
import { readLocal, writeLocal } from "../localDb"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, options: unknown, run?: () => Promise<unknown>) =>
    (run ?? options as () => Promise<unknown>)() } })
})
afterEach(() => { vi.restoreAllMocks(); resetIdentityStorageForTest() })
afterAll(() => vi.unstubAllGlobals())

async function fixture() {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Original", profile.identity.personId, "job-search"))
  await recordGenesisAuthority(doc, profile)
  const command: Command = { kind: "renameWorkspace", title: "Changed" }
  const authorize = async () => { assertWorkspaceCommand(await workspaceRole(doc, profile), doc, command) }
  const signingContext = await localCommandSigningContext(doc, profile, authorize)
  const revoke = async () => {
    const authority = await peerStore.getWorkspaceAuthority(doc.id)
    if (!authority) throw new Error("Fixture authority missing")
    const removal = await createWorkspaceDeviceRevocation(profile, doc.id, profile.identity.personId,
      profile.device.deviceId, Automerge.getHeads(doc), [profile.certificate])
    await peerStore.putWorkspaceAuthority({ ...authority, updatedAt: new Date().toISOString(),
      catalog: { ...authority.catalog as object, deviceRevocations: [removal] } })
  }
  return { profile, doc, command, signingContext, revoke }
}

it("Given real stored signed authority, when an owner authors a command, then both transaction signatures succeed", async () => {
  const f = await fixture()
  try {
    const result = await executeCommand(f.doc, f.command, f.profile, undefined, undefined, f.signingContext)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.newDoc.title).toBe("Changed")
      Automerge.free(result.value.newDoc)
    }
  } finally { Automerge.free(f.doc) }
})

it("Given a signed device revocation after transaction preparation, when signing, then native policy rejects the former owner device", async () => {
  const f = await fixture()
  try {
    await f.revoke()
    await expect(executeCommand(f.doc, f.command, f.profile, undefined, undefined, f.signingContext))
      .rejects.toThrow(/owner|editor|authority|permission/i)
    expect(f.doc.title).toBe("Original")
  } finally { Automerge.free(f.doc) }
})

it("Given real owner authority, when a signed revocation arrives during actor signing, then emit no transaction proof", async () => {
  const f = await fixture()
  const original = crypto.subtle.sign.bind(crypto.subtle)
  let revoked = false
  const proofs: unknown[] = []
  vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
    const text = new TextDecoder().decode(args[2] as Uint8Array)
    const result = await original(...args)
    if (text.includes('"change-proof"')) proofs.push(result)
    if (!revoked && text.includes('"actor-binding"')) { revoked = true; await f.revoke() }
    return result
  })
  try {
    await expect(executeCommand(f.doc, f.command, f.profile, undefined, undefined, f.signingContext))
      .rejects.toThrow(/owner|editor|authority|permission/i)
    expect(revoked).toBe(true)
    expect(proofs).toEqual([])
    expect(f.doc.title).toBe("Original")
  } finally { Automerge.free(f.doc) }
})

it("Given another tab replaces the saved device key with unchanged public fields, when the prepared command signs, then reject the stale cached signer", async () => {
  const f = await fixture()
  try {
    const original = await readLocal("tincanban.local_profile.v1")
    if (!original) throw new Error("Fixture profile missing")
    const changed = JSON.parse(original) as { privateKeys: { devicePrivateKeyPkcs8: string } }
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
    changed.privateKeys.devicePrivateKeyPkcs8 = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey)))
    await writeLocal("tincanban.local_profile.v1", JSON.stringify(changed))
    await expect(executeCommand(f.doc, f.command, f.profile, undefined, undefined, f.signingContext)).rejects.toThrow(/stale|key/i)
    expect(f.doc.title).toBe("Original")
  } finally { Automerge.free(f.doc) }
})
