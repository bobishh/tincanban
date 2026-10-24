import type { HistoryPreparationPersistence } from "@meta-uber/mesh-replication/history-preparation-journal"
import { canonicalizeJson, fromBase64Url, toBase64Url } from "@meta-uber/mesh-identity"

const MAX_RECORD_BYTES = 360 * 1024
const MAX_ENCODED_BYTES = Math.ceil((MAX_RECORD_BYTES + 16) / 3) * 4 + 17
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true })
function fail(): never { throw new Error("Invalid Worker history preparation storage") }
function key(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,512}$/.test(value)) fail()
}
function value(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > MAX_RECORD_BYTES || encoder.encode(value).length > MAX_RECORD_BYTES ||
      [...value].some(char => { const code = char.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff })) fail()
}

/** Encrypted records with synchronous SQL CAS. Cursors are consumed before crypto awaits. */
export function createHistoryPreparationStorage(storage: DurableObjectStorage, secret: string,
  contextId: string): HistoryPreparationPersistence {
  if (typeof secret !== "string" || secret.length > 4096 || encoder.encode(secret).length < 32 ||
      typeof contextId !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(contextId)) fail()
  value(secret)
  storage.sql.exec("CREATE TABLE IF NOT EXISTS history_preparation_records (record_key TEXT PRIMARY KEY, encrypted_value TEXT NOT NULL)")
  let storageKey: CryptoKey | undefined
  const cryptoKey = async () => {
    if (storageKey) return storageKey
    const bytes = await crypto.subtle.digest("SHA-256", encoder.encode("TIN/history-preparation/key/v1\0" + secret))
    const imported = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"])
    storageKey = imported
    return imported
  }
  const aad = (recordKey: string) => encoder.encode(canonicalizeJson(["TIN/history-preparation/record/v1", contextId, recordKey]))
  const encrypt = async (recordKey: string, plaintext: string) => {
    value(plaintext)
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(recordKey) }, await cryptoKey(), encoder.encode(plaintext))
    return toBase64Url(nonce) + "." + toBase64Url(new Uint8Array(ciphertext))
  }
  const decrypt = async (recordKey: string, encrypted: string) => {
    if (typeof encrypted !== "string" || encrypted.length > MAX_ENCODED_BYTES) fail()
    const parts = encrypted.split(".")
    if (parts.length !== 2) fail()
    const nonce = fromBase64Url(parts[0]!), ciphertext = fromBase64Url(parts[1]!)
    if (nonce.length !== 12 || ciphertext.length < 16 || ciphertext.length > MAX_RECORD_BYTES + 16 ||
        toBase64Url(nonce) !== parts[0] || toBase64Url(ciphertext) !== parts[1]) fail()
    const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(recordKey) }, await cryptoKey(), ciphertext)
    const plaintext = decoder.decode(bytes)
    value(plaintext)
    return plaintext
  }
  const row = (recordKey: string) => storage.sql.exec<{ encrypted_value: string }>(
    "SELECT encrypted_value FROM history_preparation_records WHERE record_key = ?", recordKey).toArray()[0]?.encrypted_value
  return {
    async read(recordKey) {
      key(recordKey)
      const encrypted = row(recordKey)
      return encrypted === undefined ? undefined : decrypt(recordKey, encrypted)
    },
    async scan(prefix, after, limit) {
      key(prefix)
      if (!Number.isInteger(limit) || limit < 1 || limit > 128 || after !== undefined &&
          (typeof after !== "string" || !after.startsWith(prefix))) fail()
      if (after !== undefined) key(after)
      // Journal keys are ASCII, so the final code unit always has a successor.
      const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
      const rows = storage.sql.exec<{ record_key: string }>(
        "SELECT record_key FROM history_preparation_records WHERE record_key >= ? AND record_key < ? AND (? IS NULL OR record_key > ?) ORDER BY record_key LIMIT ?",
        prefix, upper, after ?? null, after ?? null, limit + 1).toArray()
      const entries: Array<{ key: string; value: string }> = []
      for (const item of rows.slice(0, limit)) {
        const encrypted = row(item.record_key)
        if (encrypted === undefined) fail()
        entries.push({ key: item.record_key, value: await decrypt(item.record_key, encrypted) })
      }
      return { entries, nextAfter: rows.length > limit ? entries.at(-1)!.key : null }
    },
    async compareAndSwap(conditionsInput, writesInput, guard) {
      if (!Array.isArray(conditionsInput) || conditionsInput.length < 1 || conditionsInput.length > 8 ||
          !Array.isArray(writesInput) || writesInput.length < 1 || writesInput.length > 8 || typeof guard !== "function") fail()
      const conditions = conditionsInput.map(item => {
        key(item.key); if (item.expected !== undefined) value(item.expected)
        return { key: item.key, expected: item.expected }
      })
      const writes = writesInput.map(item => { key(item.key); value(item.value); return { key: item.key, value: item.value } })
      if (new Set(conditions.map(item => item.key)).size !== conditions.length || new Set(writes.map(item => item.key)).size !== writes.length ||
          writes.some(write => !conditions.some(condition => condition.key === write.key))) fail()
      const runGuard = () => {
        const result: unknown = guard()
        if (result !== undefined) {
          if (result && (typeof result === "object" || typeof result === "function") && "then" in result) {
            void Promise.resolve(result).catch(() => {})
          }
          throw new Error("History preparation guard must be synchronous and return no value")
        }
      }
      runGuard()
      const snapshots = conditions.map(condition => ({ ...condition, encrypted: row(condition.key) }))
      for (const snapshot of snapshots) {
        const plaintext = snapshot.encrypted === undefined ? undefined : await decrypt(snapshot.key, snapshot.encrypted)
        if (plaintext !== snapshot.expected) return false
      }
      const encryptedWrites: Array<{ key: string; value: string }> = []
      for (const write of writes) encryptedWrites.push({ key: write.key, value: await encrypt(write.key, write.value) })
      const applied = storage.transactionSync(() => {
        if (snapshots.some(snapshot => row(snapshot.key) !== snapshot.encrypted)) return false
        runGuard()
        for (const write of encryptedWrites) storage.sql.exec(
          "INSERT INTO history_preparation_records (record_key, encrypted_value) VALUES (?, ?) ON CONFLICT(record_key) DO UPDATE SET encrypted_value = excluded.encrypted_value",
          write.key, write.value)
        return true
      })
      if (applied) await storage.sync()
      return applied
    },
  }
}
