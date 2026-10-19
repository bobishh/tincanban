import { expect, it } from "vitest"
import { encodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { parseReplicaConfig } from "./blindReplicaConfig"
import { changeReplicaPreference, effectivePrivateReplicaConfigs, emptyPrivateReplicaState, mergePrivateReplicaState, parsePrivateReplicaWire, portableReplicaState, replicaPreferenceConflicts } from "./privateReplicaPreferences"

const key = (byte: number) => encodeBlindBytes(new Uint8Array(32).fill(byte))
const config = { origin: "https://rusty.example", workspaceId: "board", scopeId: "scope", servicePublicKey: key(9),
  readToken: key(7), writeToken: key(8), keyEpoch: 2, contentKey: key(2), historicalContentKeys: { "1": key(1) },
  policyRevision: 1, cursor: 0, lastUploaded: "" }

it("Given a rotated private connection, when parsing or exporting, then preserve every old epoch key under a required version-4 wire contract", () => {
  expect(parseReplicaConfig(JSON.stringify(config)).historicalContentKeys).toEqual(config.historicalContentKeys)
  const state = changeReplicaPreference(emptyPrivateReplicaState("person", "local"), config)
  const wire = portableReplicaState(state)
  expect(state.version).toBe(4)
  expect(wire.version).toBe(4)
  expect(wire.entries[0].operations[0].config).toMatchObject({ historicalContentKeys: config.historicalContentKeys, cursor: 0, lastUploaded: "" })
})

it("Given historical keys hidden under an older wire format, when parsing, then require an upgrade rather than silently discarding keys", () => {
  const wire = portableReplicaState(changeReplicaPreference(emptyPrivateReplicaState("person", "local"), config))
  expect(() => parsePrivateReplicaWire({ ...wire, version: 3 })).toThrow(/upgrade|version|schema/i)
  expect(() => parsePrivateReplicaWire({ ...wire, version: 2 })).toThrow()
})

it("Given a peer with no rotated connections, when importing and later removing a version-4 connection, then retain the reader floor across tombstones and old-state replay", () => {
  const source = changeReplicaPreference(emptyPrivateReplicaState("person", "source"), config)
  const imported = mergePrivateReplicaState(emptyPrivateReplicaState("person", "recipient"), portableReplicaState(source))
  const removed = changeReplicaPreference(imported, config, true)
  const replayed = mergePrivateReplicaState(removed, portableReplicaState(emptyPrivateReplicaState("person", "old")))
  expect(portableReplicaState(replayed).version).toBe(4)
})

it("Given malformed, future or missing historical key entries, when parsing a connection, then fail before returning a usable credential", () => {
  for (const historicalContentKeys of [{ "2": key(1) }, { "01": key(1) }, { "1": "invalid" }, { "1": key(2) }]) {
    expect(() => parseReplicaConfig(JSON.stringify({ ...config, historicalContentKeys }))).toThrow()
  }
})

it("Given known historical keys, when a local edit would discard them, then leave the causal state untouched", () => {
  const state = changeReplicaPreference(emptyPrivateReplicaState("person", "local"), config)
  const before = structuredClone(state)
  expect(() => changeReplicaPreference(state, { ...config, historicalContentKeys: undefined })).toThrow(/retain|key/i)
  expect(state).toEqual(before)
})

it("Given concurrent rotations of the same epoch, when merged, then retain both conflicting credentials and refuse arbitrary key selection", () => {
  const initial = { ...config, keyEpoch: 1, contentKey: key(1), historicalContentKeys: undefined }
  const base = changeReplicaPreference(emptyPrivateReplicaState("person", "base"), initial)
  const first = changeReplicaPreference(mergePrivateReplicaState(emptyPrivateReplicaState("person", "first"), portableReplicaState(base)), config)
  const otherConfig = { ...config, contentKey: key(3) }
  const second = changeReplicaPreference(mergePrivateReplicaState(emptyPrivateReplicaState("person", "second"), portableReplicaState(base)), otherConfig)
  const conflicted = mergePrivateReplicaState(first, portableReplicaState(second))
  expect(replicaPreferenceConflicts(conflicted)).toHaveLength(1)
  expect(effectivePrivateReplicaConfigs(conflicted)).toHaveLength(0)
  expect(portableReplicaState(conflicted).entries[0].operations).toHaveLength(2)
  expect(() => changeReplicaPreference(conflicted, config)).toThrow(/epoch|retain|key/i)
})

it("Given a causal successor that loses an old key, when importing without local progress, then reject before replacing the selected credentials", () => {
  const state = changeReplicaPreference(emptyPrivateReplicaState("person", "local"), config)
  const wire = portableReplicaState(state)
  const incoming = { ...wire, clock: { ...wire.clock, peer: 1 }, entries: [{ ...wire.entries[0], operations: [{
    dot: { actorId: "peer", counter: 1 }, context: wire.clock, purpose: "workspace", config: { ...config, purpose: "workspace", historicalContentKeys: undefined },
  }] }] }
  expect(() => mergePrivateReplicaState(state, incoming)).toThrow(/retain|key/i)
  expect(effectivePrivateReplicaConfigs(state)[0]?.historicalContentKeys).toEqual({ "1": key(1) })
})

it("Given a wire carries both a known key and a lossy causal successor, when parsing, then reject before pruning the superseded operation", () => {
  const wire = portableReplicaState(changeReplicaPreference(emptyPrivateReplicaState("person", "local"), config))
  const previous = wire.entries[0]!.operations[0]!
  const next = { ...previous, dot: { actorId: "peer", counter: 1 }, context: wire.clock,
    config: { ...previous.config!, historicalContentKeys: undefined } }
  expect(() => parsePrivateReplicaWire({ ...wire, clock: { ...wire.clock, peer: 1 },
    entries: [{ ...wire.entries[0], operations: [previous, next] }] })).toThrow(/retain|key/i)
})

it('Given same-epoch historical variants, when exporting private state, then use wire five and retain every candidate through causal replacement', () => {
  const resolved = { ...config, keyEpoch: 3, contentKey: key(3), historicalContentKeys: undefined,
    historicalContentKeyVariants: { '1': [key(1), key(9)], '2': [key(2), key(8)] } }
  const state = changeReplicaPreference(emptyPrivateReplicaState('person', 'owner'), resolved)
  expect(portableReplicaState(state).version).toBe(5)
  expect(effectivePrivateReplicaConfigs(state)[0]?.historicalContentKeyVariants).toEqual(resolved.historicalContentKeyVariants)
  for (const version of [3, 4]) expect(() => parsePrivateReplicaWire({ ...portableReplicaState(state), version })).toThrow(/version 5|upgrade/i)
  expect(() => parsePrivateReplicaWire({ ...portableReplicaState(state), version: 2 })).toThrow(/private replica/i)
  expect(() => changeReplicaPreference(state, { ...resolved, historicalContentKeyVariants: { '1': [key(1), key(9)] } })).toThrow(/retain/i)
})
