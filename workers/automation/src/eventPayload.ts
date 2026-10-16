import type { AutomationEvent } from "./pipeline";

/** Encrypt an intake event using the existing event-storage wire format. */
export async function encryptEventPayload(secret: string, eventId: string, event: AutomationEvent): Promise<string> {
  return encryptJson(secret, `TIN/event-payload/v1/${eventId}`, event);
}

/** Decrypt an intake event using the existing event-storage wire format. */
export async function decryptEventPayload(secret: string, eventId: string, value: string): Promise<AutomationEvent> {
  const event = await decryptJson(secret, `TIN/event-payload/v1/${eventId}`, value);
  if (!isRecord(event) || (event.source !== "website" && event.source !== "email")) throw new Error("Stored event payload is invalid");
  return event as AutomationEvent;
}

/** Store a classification beside intake without reusing the intake ciphertext or AAD. */
export async function encryptEventClassification(secret: string, eventId: string, classification: unknown): Promise<string> {
  return encryptJson(secret, `TIN/event-classification/v1/${eventId}`, classification);
}

/** Read a classification stored with its own authenticated-encryption context. */
export function decryptEventClassification(secret: string, eventId: string, value: string): Promise<unknown> {
  return decryptJson(secret, `TIN/event-classification/v1/${eventId}`, value);
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function encryptJson(secret: string, additionalData: string, value: unknown): Promise<string> {
  const key = await eventStorageKey(secret, "encrypt");
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce,
    additionalData: new TextEncoder().encode(additionalData), tagLength: 128 }, key, plaintext);
  return `${encodeBase64Url(nonce)}.${encodeBase64Url(new Uint8Array(ciphertext))}`;
}

async function decryptJson(secret: string, additionalData: string, value: string): Promise<unknown> {
  const [nonceValue, ciphertextValue, extra] = value.split(".");
  if (!nonceValue || !ciphertextValue || extra !== undefined) throw new Error("Stored event payload is invalid");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64Url(nonceValue),
    additionalData: new TextEncoder().encode(additionalData), tagLength: 128 }, await eventStorageKey(secret, "decrypt"), decodeBase64Url(ciphertextValue));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as unknown;
}

async function eventStorageKey(secret: string, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  if (new TextEncoder().encode(secret).byteLength < 32) throw new Error("Event storage secret must contain at least 32 bytes");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`TIN/event-key/v1/${secret}`));
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [usage]);
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Stored event payload is invalid");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
