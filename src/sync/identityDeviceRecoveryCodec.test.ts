import { beforeEach, expect, it } from "vitest"
import { generateIdentityRecovery, identitySeedFromPrivateKey, sealIdentitySeed } from "@meta-uber/mesh-identity"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault } from "../domain/proofs"
import { createIdentityDeviceTransfer } from "./identityDeviceTransfer"
import { openIdentityDeviceRecovery, parseIdentityRecoveryFile, sealIdentityDeviceRecovery } from "./identityDeviceRecoveryCodec"

beforeEach(() => resetIdentityStorageForTest())

async function backup() {
  const owner = await bootstrapIdentity("Recovery owner")
  const words = generateIdentityRecovery("better")
  const seed = await identitySeedFromPrivateKey(owner.privateKeys.identityPrivateKey!, owner.identity.personId)
  const recovery = await sealIdentitySeed(seed, owner.identity.personId, words, "better")
  const manifest = await createIdentityDeviceTransfer(createPersonalRoot(owner, await certHashDefault(owner.certificate)), [owner.certificate])
  const file = await sealIdentityDeviceRecovery(manifest, recovery, seed)
  seed.fill(0)
  return { owner, words, manifest, file }
}

it("Given a complete identity state, when opening its encrypted recovery file with matching words, then recover the exact manifest and matching root without exporting device keys", async () => {
  const { owner, words, manifest, file } = await backup()
  const opened = await openIdentityDeviceRecovery(parseIdentityRecoveryFile(JSON.stringify(file)), words)
  expect(opened.transfer.manifest).toEqual(manifest)
  expect(opened.identity.personId).toBe(owner.identity.personId)
  const serialized = JSON.stringify(file)
  expect(serialized).not.toContain("identityCatalog")
  expect(serialized).not.toContain("privateConnections")
  expect(serialized).not.toContain("privateKeys")
  expect(serialized).not.toContain(words)
})

it("Given an authenticated recovery file, when ciphertext, metadata or wrapped root is substituted, then reject before importing state", async () => {
  const { words, file } = await backup()
  const another = await backup()
  for (const changed of [
    { ...file, recovery: another.file.recovery },
    { ...file, cipher: { ...file.cipher, salt: "A".repeat(43) } },
    { ...file, ciphertext: (file.ciphertext[0] === "A" ? "B" : "A") + file.ciphertext.slice(1) },
  ]) await expect(openIdentityDeviceRecovery(changed, words)).rejects.toThrow()
  await expect(openIdentityDeviceRecovery(file, another.words)).rejects.toThrow(/words|identity/i)
})

it("Given an older seed-only file, when reading it, then identify its limited scope explicitly while rejecting unsupported or oversized files", async () => {
  const { file } = await backup()
  expect(parseIdentityRecoveryFile(JSON.stringify(file.recovery)).kind).toBe("mesh-identity-recovery")
  expect(() => parseIdentityRecoveryFile(JSON.stringify({ ...file, version: 2 }))).toThrow(/update|upgrade/i)
  expect(() => parseIdentityRecoveryFile(" ".repeat(2 * 1024 * 1024 + 1))).toThrow(/large|limit/i)
  expect(() => parseIdentityRecoveryFile(JSON.stringify({ ...file, unexpected: true }))).toThrow()
})
