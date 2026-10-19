import { expect, it } from "vitest"
import { encodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { assertRetainsReplicaContentKeys, contentKeyForEpoch, parseReplicaContentKeys, rotateReplicaContentKeys, type ReplicaContentKeys } from "./replicaContentKeys"

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const key = (byte: number) => encodeBlindBytes(new Uint8Array(32).fill(byte))
const numberedKey = (number: number) => {
  const bytes = new Uint8Array(32)
  bytes[0] = number >>> 8
  bytes[1] = number & 255
  return encodeBlindBytes(bytes)
}
function alternateFinalBits(value: string): string {
  const index = alphabet.indexOf(value.at(-1)!)
  return value.slice(0, -1) + alphabet[(index & 48) | ((index + 1) & 15)]
}
function keys(overrides: Partial<ReplicaContentKeys> = {}): ReplicaContentKeys {
  return { keyEpoch: 3, contentKey: key(3), ...overrides }
}

it("Given a full replica config, when key history is parsed, then select only key fields and detach history", () => {
  const history = { "1": key(1), "2": key(2) }
  const parsed = parseReplicaContentKeys({ keyEpoch: 3, contentKey: key(3), historicalContentKeys: history,
    origin: "https://rusty.example", readToken: "secret", cursor: 19 })
  history["1"] = key(9)
  expect(parsed).toEqual({ keyEpoch: 3, contentKey: key(3), historicalContentKeys: { "1": key(1), "2": key(2) } })
})

it("Given noncanonical base64url spelling has unused final bits, when parsed, then retain the original decoder's rejection", () => {
  const canonical = key(7)
  const legacy = alternateFinalBits(canonical)
  expect(() => parseReplicaContentKeys({ keyEpoch: 1, contentKey: legacy })).toThrow(/key/i)
  expect(() => contentKeyForEpoch({ keyEpoch: 1, contentKey: legacy }, 1)).toThrow(/key/i)
})

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
  "Given invalid active epoch %s, when parsing key history, then reject it", invalidEpoch => {
    expect(() => parseReplicaContentKeys({ keyEpoch: invalidEpoch, contentKey: key(1) })).toThrow()
  })

it.each(["", "!", key(1).slice(1), encodeBlindBytes(new Uint8Array(31))])(
  "Given invalid active content key %s, when parsing key history, then reject it", invalidKey => {
    expect(() => parseReplicaContentKeys({ keyEpoch: 1, contentKey: invalidKey })).toThrow()
  })

it("Given invalid history shape, count, or epoch labels, when parsing, then reject unsafe records", () => {
  expect(() => parseReplicaContentKeys({ ...keys(), historicalContentKeys: [] })).toThrow()
  expect(() => parseReplicaContentKeys({ ...keys(), historicalContentKeys: Object.create({ "1": key(1) }) })).toThrow()
  expect(() => parseReplicaContentKeys({ ...keys(), historicalContentKeys: Object.fromEntries(
    Array.from({ length: 257 }, (_, index) => [`${index + 1}`, key((index % 255) + 1)])) })).toThrow()
  for (const epoch of ["0", "01", "+1", "1.0", " 1", "3", "4", "9007199254740992"]) {
    expect(() => parseReplicaContentKeys({ ...keys(), historicalContentKeys: { [epoch]: key(1) } })).toThrow()
  }
})

it("Given active and historical keys decode to identical bytes, when parsing, then reject the duplicate", () => {
  const canonical = key(11)
  expect(() => parseReplicaContentKeys({ keyEpoch: 2, contentKey: canonical,
    historicalContentKeys: { "1": canonical } })).toThrow(/duplicate|same|key/i)
  expect(() => parseReplicaContentKeys({ keyEpoch: 2, contentKey: canonical,
    historicalContentKeys: { "1": alternateFinalBits(canonical) } })).toThrow(/duplicate|same|key/i)
})

it("Given an epoch-bound object, when selecting its active or retained key, then return the matching original spelling", () => {
  const current = keys({ contentKey: key(3), historicalContentKeys: { "1": key(1), "2": key(2) } })
  expect(contentKeyForEpoch(current, 3)).toBe(key(3))
  expect(contentKeyForEpoch(current, 1)).toBe(key(1))
  expect(contentKeyForEpoch(current, 2)).toBe(key(2))
  expect(() => contentKeyForEpoch(current, 4)).toThrow(/update required/i)
  expect(() => contentKeyForEpoch(current, 0)).toThrow(/update required/i)
  expect(() => contentKeyForEpoch(current, 99)).toThrow(/update required/i)
})

it("Given the first rotation, when the active key changes, then retain the old key and omit empty history beforehand", () => {
  const initial = keys({ contentKey: key(20), historicalContentKeys: {} })
  expect(parseReplicaContentKeys(initial)).toEqual({ keyEpoch: 3, contentKey: key(20) })
  const rotated = rotateReplicaContentKeys(initial, key(21))
  expect(initial).toEqual({ keyEpoch: 3, contentKey: key(20), historicalContentKeys: {} })
  expect(rotated).toEqual({ keyEpoch: 4, contentKey: key(21), historicalContentKeys: { "3": key(20) } })
  expect(rotateReplicaContentKeys(keys({ contentKey: key(22) }), key(23))).toEqual({
    keyEpoch: 4, contentKey: key(23), historicalContentKeys: { "3": key(22) },
  })
})

it("Given existing history, when rotating more than once, then retain every prior epoch without mutating inputs", () => {
  const first = keys({ contentKey: key(30), historicalContentKeys: { "1": key(10), "2": key(20) } })
  const once = rotateReplicaContentKeys(first, key(31))
  const twice = rotateReplicaContentKeys(once, key(32))
  expect(twice).toEqual({ keyEpoch: 5, contentKey: key(32), historicalContentKeys: { "1": key(10), "2": key(20), "3": key(30), "4": key(31) } })
  expect(first).toEqual({ keyEpoch: 3, contentKey: key(30), historicalContentKeys: { "1": key(10), "2": key(20) } })
  expect(contentKeyForEpoch(twice, 1)).toBe(key(10))
})

it("Given a new key reuses any active or historical key bytes, when rotating, then reject it", () => {
  expect(() => rotateReplicaContentKeys(keys({ contentKey: key(40), historicalContentKeys: { "1": key(41) } }), key(40))).toThrow(/reuse|duplicate|key/i)
  expect(() => rotateReplicaContentKeys(keys({ contentKey: key(40), historicalContentKeys: { "1": key(41) } }), key(41))).toThrow(/reuse|duplicate|key/i)
  const alias = alternateFinalBits(key(41))
  expect(() => rotateReplicaContentKeys(keys({ contentKey: key(40), historicalContentKeys: { "1": key(41) } }), alias)).toThrow(/reuse|duplicate|key/i)
})

it("Given a full retained-key history or maximum epoch, when rotating, then refuse loss or overflow", () => {
  const fullHistory = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`${index + 1}`, numberedKey(index + 1)]))
  expect(() => rotateReplicaContentKeys(keys({ keyEpoch: 257, contentKey: key(0), historicalContentKeys: fullHistory }), key(250))).toThrow(/history|limit/i)
  expect(() => rotateReplicaContentKeys(keys({ keyEpoch: Number.MAX_SAFE_INTEGER, contentKey: key(250) }), key(251))).toThrow(/epoch|safe|overflow/i)
})

it("Given retained ciphertext keys, when adopting the same epoch or a later complete rotation, then preserve access to every known epoch", () => {
  const previous = keys({ historicalContentKeys: { "1": key(1), "2": key(2) } })
  expect(() => assertRetainsReplicaContentKeys(previous, structuredClone(previous))).not.toThrow()
  expect(() => assertRetainsReplicaContentKeys(previous, rotateReplicaContentKeys(previous, key(4)))).not.toThrow()
  expect(() => assertRetainsReplicaContentKeys(previous, { keyEpoch: 5, contentKey: key(5),
    historicalContentKeys: { "1": key(1), "2": key(2), "3": key(3), "4": key(4) } })).not.toThrow()
})

it("Given known ciphertext epochs, when a preference would roll back, replace or discard a key, then refuse the transition", () => {
  const previous = keys({ historicalContentKeys: { "1": key(1), "2": key(2) } })
  const invalid = [
    { keyEpoch: 2, contentKey: key(2), historicalContentKeys: { "1": key(1) } },
    { ...previous, contentKey: key(4) },
    { ...previous, historicalContentKeys: { "1": key(1) } },
    { ...previous, historicalContentKeys: { "1": key(8), "2": key(2) } },
    { keyEpoch: 4, contentKey: key(4), historicalContentKeys: { "1": key(1), "2": key(2) } },
    { keyEpoch: 4, contentKey: key(4), historicalContentKeys: { "1": key(1), "2": key(2), "3": key(8) } },
  ]
  for (const next of invalid) expect(() => assertRetainsReplicaContentKeys(previous, next)).toThrow(/epoch|retain|key/i)
})

it('Given incompatible content keys at the same historical epoch, when parsing, then preserve bounded canonical candidates without choosing a winner', () => {
  const parsed = parseReplicaContentKeys({ keyEpoch: 4, contentKey: key(4), historicalContentKeyVariants: { '2': [key(2), key(1)] } })
  expect(parsed.historicalContentKeyVariants?.['2']).toEqual([key(1), key(2)].sort())
})
it('Given ambiguous historical epoch keys, when using the single-key API, then fail closed and require candidate decryption', async () => {
  const { contentKeysForEpoch, openWithReplicaContentKeys } = await import('./replicaContentKeys')
  const input = { keyEpoch: 4, contentKey: key(4), historicalContentKeyVariants: { '2': [key(1), key(2)] } }
  expect(() => contentKeyForEpoch(input, 2)).toThrow(/candidate|ambiguous/i)
  expect(contentKeysForEpoch(input, 2)).toEqual([key(1), key(2)].sort())
  const seen: string[] = []
  const opened = await openWithReplicaContentKeys(input, 2, async candidate => {
    seen.push(candidate)
    if (candidate !== key(2)) throw new Error('Authentication failed')
    return 'authenticated plaintext'
  })
  expect(opened).toBe('authenticated plaintext')
  expect(seen).toContain(key(2))
})
it('Given a conflict with two active keys at epoch two, when proposing a fresh epoch, then every old key remains usable and no timestamp selects authority', async () => {
  const { mergeReplicaContentKeyVariants, contentKeysForEpoch } = await import('./replicaContentKeys')
  const result = mergeReplicaContentKeyVariants([
    { keyEpoch: 2, contentKey: key(2), historicalContentKeys: { '1': key(1) } },
    { keyEpoch: 2, contentKey: key(3), historicalContentKeys: { '1': key(9) } },
  ], key(4))
  expect(result.keyEpoch).toBe(3)
  expect(contentKeysForEpoch(result, 1)).toEqual([key(1), key(9)].sort())
  expect(contentKeysForEpoch(result, 2)).toEqual([key(2), key(3)].sort())
  for (const previous of [{ keyEpoch: 2, contentKey: key(2) }, { keyEpoch: 2, contentKey: key(3) }]) {
    expect(() => assertRetainsReplicaContentKeys(previous, result)).not.toThrow()
  }
  expect(() => assertRetainsReplicaContentKeys(result, { ...result, historicalContentKeyVariants: { '1': [key(1), key(9)] } })).toThrow(/retain/i)
})
it('Given duplicate aliases, overlapping unique and variant maps, or oversized variants, when parsing, then reject before producing credentials', () => {
  for (const historicalContentKeyVariants of [{ '2': [key(1)] }, { '2': [key(1), key(1)] }, { '4': [key(1), key(2)] },
    { '2': [key(1), alternateFinalBits(key(1))] }, { '2': Array.from({ length: 33 }, (_, index) => key(index)) }]) {
    expect(() => parseReplicaContentKeys({ keyEpoch: 4, contentKey: key(4), historicalContentKeyVariants })).toThrow()
  }
  expect(() => parseReplicaContentKeys({ keyEpoch: 4, contentKey: key(4), historicalContentKeys: { '2': key(1) },
    historicalContentKeyVariants: { '2': [key(1), key(2)] } })).toThrow()
})
