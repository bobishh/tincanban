import { z } from "zod"
import { canonicalizeJson, fromBase64Url, identitySeedFromPrivateKey, openIdentityRecoveryEnvelope,
  profileFromIdentitySeedForDevice, publicKeyId, toBase64Url, type IdentityRecoveryEnvelope } from "@meta-uber/mesh-identity"
import { decodeIdentityDeviceState, encodeIdentityDeviceState, IdentityDeviceStateUpgradeRequiredError,
  type IdentityDeviceState } from "./identityDeviceStateCodec"
import { validateIdentityRecoveryEvidence } from "./identityRecoveryState"
import { readIdentityDeviceTransfer } from "./identityDeviceTransferReader"

export const maximumIdentityRecoveryFileBytes = 2 * 1024 * 1024
const maximumCiphertextBytes = 1024 * 1024 + 16
const context = new TextEncoder().encode("tincanban/identity-device-recovery/v1")
const packageSchema = z.object({ kind: z.literal("tincanban-identity-device-recovery"), version: z.literal(1),
  personId: z.string().length(43), recovery: z.unknown(),
  cipher: z.object({ name: z.literal("AES-GCM"), kdf: z.literal("HKDF-SHA256"), salt: z.string().length(43), iv: z.string().length(16) }).strict(),
  ciphertext: z.string().min(22).max(Math.ceil(maximumCiphertextBytes * 4 / 3)),
}).strict()

export type IdentityDeviceRecoveryFile = Omit<z.infer<typeof packageSchema>, "recovery"> & { recovery: IdentityRecoveryEnvelope }
export type IdentityRecoveryFile = IdentityDeviceRecoveryFile | IdentityRecoveryEnvelope

function canonicalBytes(value: string, minimum: number, maximum = minimum): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid recovery encoding")
  const bytes = fromBase64Url(value)
  if (bytes.byteLength < minimum || bytes.byteLength > maximum || toBase64Url(bytes) !== value) throw new Error("Invalid recovery encoding")
  return new Uint8Array(bytes)
}

function readPackage(input: unknown): IdentityDeviceRecoveryFile {
  if (input && typeof input === "object" && "kind" in input && input.kind === "tincanban-identity-device-recovery" &&
    (!("version" in input) || input.version !== 1)) {
    throw new IdentityDeviceStateUpgradeRequiredError("Update tincanban to open this recovery file")
  }
  const parsed = packageSchema.parse(input)
  const [recovery] = validateIdentityRecoveryEvidence(parsed.personId, { personId: parsed.personId, envelopes: [parsed.recovery] })
  canonicalBytes(parsed.cipher.salt, 32)
  canonicalBytes(parsed.cipher.iv, 12)
  canonicalBytes(parsed.ciphertext, 17, maximumCiphertextBytes)
  return { ...parsed, recovery: recovery! }
}

/** Bound input before parsing/decryption. Older root-only files remain distinguishable. */
export function parseIdentityRecoveryFile(text: string): IdentityRecoveryFile {
  if (text.length > maximumIdentityRecoveryFileBytes || new TextEncoder().encode(text).byteLength > maximumIdentityRecoveryFileBytes) {
    throw new Error("Recovery file exceeds size limit")
  }
  const value: unknown = JSON.parse(text)
  if (value && typeof value === "object" && "kind" in value && value.kind === "mesh-identity-recovery") {
    if (!("personId" in value) || typeof value.personId !== "string") throw new Error("Invalid recovery identity")
    const [envelope] = validateIdentityRecoveryEvidence(value.personId, { personId: value.personId, envelopes: [value] })
    return envelope!
  }
  return readPackage(value)
}

async function wrappingKey(seed: Uint8Array, salt: string): Promise<CryptoKey> {
  if (seed.byteLength !== 32) throw new Error("Invalid recovery root")
  const source = await crypto.subtle.importKey("raw", new Uint8Array(seed), "HKDF", false, ["deriveKey"])
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: canonicalBytes(salt, 32), info: context },
    source, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
}

/** Device private keys never enter the manifest. Root material is used only to derive this backup's key. */
export async function sealIdentityDeviceRecovery(manifest: IdentityDeviceState, recovery: IdentityRecoveryEnvelope,
  seed: Uint8Array): Promise<IdentityDeviceRecoveryFile> {
  seed = new Uint8Array(seed)
  recovery = structuredClone(recovery)
  try {
    manifest = decodeIdentityDeviceState(encodeIdentityDeviceState(manifest), recovery.personId)
    const transfer = await readIdentityDeviceTransfer(manifest, recovery.personId)
    validateIdentityRecoveryEvidence(recovery.personId, { personId: recovery.personId, envelopes: [recovery] })
    // Bind the derived encryption key to the certified root, rather than trusting caller-supplied bytes.
    const derived = await profileFromIdentitySeedForDevice(seed)
    if (derived.identity.publicKey !== transfer.personalRoot.identity.publicKey) throw new Error("Recovery root does not match device state")
    const header = { kind: "tincanban-identity-device-recovery" as const, version: 1 as const, personId: recovery.personId,
      recovery: structuredClone(recovery), cipher: { name: "AES-GCM" as const, kdf: "HKDF-SHA256" as const,
        salt: toBase64Url(crypto.getRandomValues(new Uint8Array(32))), iv: toBase64Url(crypto.getRandomValues(new Uint8Array(12))) } }
    const key = await wrappingKey(seed, header.cipher.salt)
    const plaintext = encodeIdentityDeviceState(manifest)
    try {
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: canonicalBytes(header.cipher.iv, 12),
        additionalData: new TextEncoder().encode(canonicalizeJson(header)), tagLength: 128 }, key, new Uint8Array(plaintext))
      return readPackage({ ...header, ciphertext: toBase64Url(new Uint8Array(ciphertext)) })
    } finally { plaintext.fill(0) }
  } finally { seed.fill(0) }
}

/** Authenticate/decode every component without writing local state or adopting a device. */
export async function openIdentityDeviceRecovery(input: unknown, words: string) {
  const file = readPackage(structuredClone(input))
  const recovered = await openIdentityRecoveryEnvelope(file.recovery, words)
  const seed = await identitySeedFromPrivateKey(recovered.privateKeys.identityPrivateKey!, file.personId)
  let plaintext: Uint8Array | undefined
  try {
    const { ciphertext, ...header } = file
    const key = await wrappingKey(seed, file.cipher.salt)
    try {
      plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: canonicalBytes(file.cipher.iv, 12),
        additionalData: new TextEncoder().encode(canonicalizeJson(header)), tagLength: 128 }, key,
      canonicalBytes(ciphertext, 17, maximumCiphertextBytes)))
    } catch { throw new Error("Recovery file authentication failed. Choose its original file and matching words.") }
    const transfer = await readIdentityDeviceTransfer(decodeIdentityDeviceState(plaintext, file.personId), file.personId)
    if (transfer.personalRoot.identity.publicKey !== recovered.identity.publicKey ||
      await publicKeyId(transfer.personalRoot.identity.publicKey) !== file.personId) throw new Error("Recovery identity mismatch")
    return { transfer, identity: structuredClone(recovered.identity), recovery: file.recovery }
  } finally { seed.fill(0); plaintext?.fill(0) }
}
