/** Wire objects contain only authenticated ciphertext and opaque routing data. */
export type BlindObject = { version: 1; scopeId: string; keyEpoch: number; nonce: string; ciphertext: string }
export type PurposeBoundBinding = {
  purpose: "identity-state" | "attachment" | "archive"
  subjectId: string
  scopeId: string
  keyEpoch: number
}
const encoder = new TextEncoder()
const scopePattern = /^[a-zA-Z0-9_-]{1,128}$/
const purposeValues = new Set<PurposeBoundBinding["purpose"]>(["identity-state", "attachment", "archive"])

export function encodeBlindBytes(bytes: Uint8Array): string {
  let text = ""
  for (let offset = 0; offset < bytes.length; offset += 32768) text += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function decodeBlindBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[a-zA-Z0-9_-]*$/.test(value)) throw new Error("Invalid encrypted object encoding")
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0))
  if (encodeBlindBytes(bytes) !== value) throw new Error("Non-canonical encrypted object encoding")
  return bytes
}

function binding(scopeId: string, keyEpoch: number): Uint8Array<ArrayBuffer> {
  if (!scopePattern.test(scopeId) || !Number.isSafeInteger(keyEpoch) || keyEpoch < 1) throw new Error("Invalid encrypted object scope or epoch")
  return new Uint8Array(encoder.encode(`RUSTY/2/object\0${scopeId}\0${keyEpoch}`))
}

function purposeBinding(input: PurposeBoundBinding): { value: PurposeBoundBinding; additionalData: Uint8Array<ArrayBuffer> } {
  const value = structuredClone(input)
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Object.keys(value).length !== 4 || !["purpose", "subjectId", "scopeId", "keyEpoch"].every(key => Object.hasOwn(value, key)) ||
      !purposeValues.has(value.purpose) || typeof value.subjectId !== "string" || !value.subjectId.trim() || value.subjectId.length > 512 ||
      !scopePattern.test(value.scopeId) || !Number.isSafeInteger(value.keyEpoch) || value.keyEpoch < 1) {
    throw new Error("Invalid purpose-bound encrypted object binding")
  }
  const context = JSON.stringify([value.purpose, value.subjectId, value.scopeId, value.keyEpoch])
  return { value, additionalData: new Uint8Array(encoder.encode(`RUSTY/2/purpose-bound-object\0${context}`)) }
}

async function contentKey(key: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  if (key.length !== 32) throw new Error("Content key must contain 32 bytes")
  return crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, [usage])
}

export async function encryptBlindObject(scopeId: string, keyEpoch: number, key: Uint8Array, plaintext: Uint8Array): Promise<BlindObject> {
  const additionalData = binding(scopeId, keyEpoch)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 },
    await contentKey(key, "encrypt"), new Uint8Array(plaintext))
  return { version: 1, scopeId, keyEpoch, nonce: encodeBlindBytes(nonce), ciphertext: encodeBlindBytes(new Uint8Array(ciphertext)) }
}

export async function decryptBlindObject(object: BlindObject, scopeId: string, keyEpoch: number, key: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (object.version !== 1 || object.scopeId !== scopeId || object.keyEpoch !== keyEpoch) throw new Error("Encrypted object does not match scope/epoch")
  const nonce = decodeBlindBytes(object.nonce)
  const ciphertext = decodeBlindBytes(object.ciphertext)
  if (nonce.length !== 12 || ciphertext.length < 16) throw new Error("Invalid encrypted object")
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: binding(scopeId, keyEpoch), tagLength: 128 },
    await contentKey(key, "decrypt"), ciphertext)
  return new Uint8Array(plaintext)
}

/** Encrypt with purpose and subject bound into AAD while retaining the opaque v1 wire shape. */
export async function encryptPurposeBoundObject(bindingInput: PurposeBoundBinding, key: Uint8Array,
  plaintext: Uint8Array): Promise<BlindObject> {
  const { value, additionalData } = purposeBinding(bindingInput)
  const keyBytes = new Uint8Array(key)
  const body = new Uint8Array(plaintext)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const imported = await contentKey(keyBytes, "encrypt")
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 }, imported, body)
  return { version: 1, scopeId: value.scopeId, keyEpoch: value.keyEpoch,
    nonce: encodeBlindBytes(nonce), ciphertext: encodeBlindBytes(new Uint8Array(ciphertext)) }
}

/** Decrypt only when every private application scope binding matches the authenticated AAD. */
export async function decryptPurposeBoundObject(object: BlindObject, bindingInput: PurposeBoundBinding,
  key: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const { value, additionalData } = purposeBinding(bindingInput)
  if (!object || object.version !== 1 || object.scopeId !== value.scopeId || object.keyEpoch !== value.keyEpoch) {
    throw new Error("Encrypted object does not match purpose-bound scope/epoch")
  }
  const nonce = decodeBlindBytes(object.nonce)
  const ciphertext = decodeBlindBytes(object.ciphertext)
  if (nonce.length !== 12 || ciphertext.length < 16) throw new Error("Invalid encrypted object")
  const imported = await contentKey(new Uint8Array(key), "decrypt")
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 }, imported, ciphertext)
  return new Uint8Array(plaintext)
}
