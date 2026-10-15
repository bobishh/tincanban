import { expect, it } from "vitest"
import type { BlindReplicaConfig, IdentityReplicaConfig, PrivateReplicaConfig } from "./blindReplication"
import { parsePrivateReplicaConfig, parseReplicaConfig } from "./blindReplicaConfig"
import { changeReplicaPreference, effectiveReplicaConfigs, emptyPrivateReplicaState, mergePrivateReplicaState,
  effectiveIdentityReplicaConfigs, effectivePrivateReplicaConfigs, parsePrivateReplicaWire, portableReplicaState,
  replicaPreferenceConflicts, updateReplicaProgress } from "./privateReplicaPreferences"

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const config: BlindReplicaConfig = { origin: "https://rusty.example", workspaceId: "board", scopeId: token,
  readToken: token, writeToken: token, contentKey: token, servicePublicKey: token, policyRevision: 1,
  keyEpoch: 1, cursor: 19, lastUploaded: token }
const identityConfig: IdentityReplicaConfig = { origin: config.origin, scopeId: "B".repeat(43), servicePublicKey: token,
  readToken: token, writeToken: token, contentKey: token, policyRevision: 1, keyEpoch: 1, cursor: 0, lastUploaded: "",
  purpose: "identity", personId: "owner" }

it("Given an acknowledged private connection, when another device imports it, then credentials transfer without the first device's progress", () => {
  const a = changeReplicaPreference(emptyPrivateReplicaState("owner", "device-a"), config)
  const acknowledged = updateReplicaProgress(a, { ...effectiveReplicaConfigs(a)[0], cursor: 19, lastUploaded: token })
  const b = mergePrivateReplicaState(emptyPrivateReplicaState("owner", "device-b"), portableReplicaState(acknowledged))
  expect(effectiveReplicaConfigs(acknowledged)[0].cursor).toBe(19)
  expect(effectiveReplicaConfigs(b)[0]).toMatchObject({ readToken: token, cursor: 0, lastUploaded: "" })
  expect(portableReplicaState(acknowledged)).not.toHaveProperty("progress")
})

it("Given concurrent remove and credential update, when devices merge in either order, then removal dominates until a later causal re-add", () => {
  const base = changeReplicaPreference(emptyPrivateReplicaState("owner", "device-a"), config)
  const b = mergePrivateReplicaState(emptyPrivateReplicaState("owner", "device-b"), portableReplicaState(base))
  const removed = changeReplicaPreference(base, config, true)
  const updated = changeReplicaPreference(b, { ...config, policyRevision: 2 })
  const aMerge = mergePrivateReplicaState(removed, portableReplicaState(updated))
  const bMerge = mergePrivateReplicaState(updated, portableReplicaState(removed))
  expect(effectiveReplicaConfigs(aMerge)).toEqual([])
  expect(effectiveReplicaConfigs(bMerge)).toEqual([])
  expect(portableReplicaState(aMerge)).toEqual(portableReplicaState(bMerge))
  const readded = changeReplicaPreference(aMerge, { ...config, policyRevision: 3 })
  expect(effectiveReplicaConfigs(readded)[0].policyRevision).toBe(3)
  expect(effectiveReplicaConfigs(mergePrivateReplicaState(readded, portableReplicaState(removed)))[0].policyRevision).toBe(3)
})

it("Given disagreeing physical clocks, when a device performs a causal edit, then logical revisions still advance", () => {
  const before = changeReplicaPreference(emptyPrivateReplicaState("owner", "device-a"), config)
  const after = changeReplicaPreference(before, { ...config, policyRevision: 2 })
  expect(after.clock["device-a"]).toBe(before.clock["device-a"] + 1)
  expect(JSON.stringify(portableReplicaState(after))).not.toContain("changedAt")
})

it("Given concurrent incompatible credentials, when merged, then expose a conflict instead of choosing a token by string order", () => {
  const base = changeReplicaPreference(emptyPrivateReplicaState("owner", "device-a"), config)
  const b = mergePrivateReplicaState(emptyPrivateReplicaState("owner", "device-b"), portableReplicaState(base))
  const aEdit = changeReplicaPreference(base, { ...config, writeToken: "B".repeat(43) })
  const bEdit = changeReplicaPreference(b, { ...config, writeToken: "C".repeat(43) })
  const merged = mergePrivateReplicaState(aEdit, portableReplicaState(bEdit))
  expect(effectiveReplicaConfigs(merged)).toEqual([])
  expect(replicaPreferenceConflicts(merged)).toHaveLength(1)
  const resolved = changeReplicaPreference(merged, config)
  expect(replicaPreferenceConflicts(resolved)).toEqual([])
  expect(effectiveReplicaConfigs(resolved)[0].writeToken).toBe(token)
})

it("Given a removed then re-added identical credential, when old replication progress commits, then reject its obsolete revision", () => {
  const before = changeReplicaPreference(emptyPrivateReplicaState("owner", "device-a"), config)
  const oldPass = { ...effectiveReplicaConfigs(before)[0], cursor: 100 }
  const readded = changeReplicaPreference(changeReplicaPreference(before, config, true), config)
  expect(() => updateReplicaProgress(readded, oldPass)).toThrow(/revision|changed/i)
  expect(effectiveReplicaConfigs(readded)[0].cursor).toBe(0)
})

it("Given invalid or conflicting dots, when private state is imported, then reject it without mutating the current state", () => {
  const before = changeReplicaPreference(emptyPrivateReplicaState("owner", "device-a"), config)
  const wire = portableReplicaState(before)
  const forged = structuredClone(wire)
  forged.entries[0].operations[0].config!.policyRevision = 999
  expect(() => mergePrivateReplicaState(before, forged)).toThrow(/conflicting|equivocation/i)
  expect(effectiveReplicaConfigs(before)[0].policyRevision).toBe(1)
  expect(() => mergePrivateReplicaState(before, { ...wire, personId: "someone-else" })).toThrow(/identity|person/i)
})

it("Given duplicate operation dots across scopes, when private state is imported, then reject the cross-entry reuse", () => {
  const base = changeReplicaPreference(emptyPrivateReplicaState("owner", "device-a"), config)
  const wire = structuredClone(portableReplicaState(base))
  wire.entries.push({ origin: "https://other.example", scopeId: "other", operations: [
    { ...structuredClone(wire.entries[0].operations[0]), config: null },
  ] })

  expect(() => mergePrivateReplicaState(base, wire)).toThrow(/duplicate|dot/i)
  expect(effectiveReplicaConfigs(base)[0].policyRevision).toBe(1)
})

it("Given cyclic causal contexts across retained operations, when private state is imported, then reject the cycle", () => {
  const wire = structuredClone(portableReplicaState(changeReplicaPreference(emptyPrivateReplicaState("owner", "device-a"), config)))
  wire.clock["device-b"] = 1
  wire.entries[0].operations = [
    { dot: { actorId: "device-a", counter: 2 }, context: { "device-b": 1 }, purpose: "workspace", config: null },
    { dot: { actorId: "device-b", counter: 1 }, context: { "device-a": 2 }, purpose: "workspace", config: null },
  ]
  wire.clock["device-a"] = 2

  expect(() => mergePrivateReplicaState(emptyPrivateReplicaState("owner", "device-a"), wire)).toThrow(/cyclic|causal/i)
})

it("Given a cyclic subset and an independent survivor, when parsing, then validate before removing dominated operations", () => {
  const wire = structuredClone(portableReplicaState(changeReplicaPreference(emptyPrivateReplicaState("owner", "device-a"), config)))
  wire.clock = { "device-a": 1, "device-b": 1, "device-c": 1 }
  wire.entries[0].operations = [
    { dot: { actorId: "device-a", counter: 1 }, context: { "device-b": 1 }, purpose: "workspace", config: null },
    { dot: { actorId: "device-b", counter: 1 }, context: { "device-a": 1 }, purpose: "workspace", config: null },
    { dot: { actorId: "device-c", counter: 1 }, context: {}, purpose: "workspace", config: null },
  ]

  expect(() => parsePrivateReplicaWire(wire)).toThrow(/cyclic|causal/i)
})

it("Given a cross-scope operation that omits a dependency's causal context, when parsing, then reject the contradiction", () => {
  const wire = structuredClone(portableReplicaState(changeReplicaPreference(emptyPrivateReplicaState("owner", "device-a"), config)))
  wire.clock = { "device-a": 1, "device-b": 1, "device-c": 1 }
  wire.entries[0].operations = [
    { dot: { actorId: "device-a", counter: 1 }, context: { "device-c": 1 }, purpose: "workspace", config: null },
  ]
  wire.entries.push({ origin: "https://other.example", scopeId: "other", operations: [
    { dot: { actorId: "device-b", counter: 1 }, context: { "device-a": 1 }, purpose: "workspace", config: null },
  ] })

  expect(() => parsePrivateReplicaWire(wire)).toThrow(/causal|context/i)
})

it("Given more than 32 concurrent preference operations, when merging, then reject atomically", () => {
  const base = changeReplicaPreference(emptyPrivateReplicaState("owner", "device-a"), config)
  const incoming = structuredClone(portableReplicaState(base))
  const operations = Array.from({ length: 32 }, (_, index) => {
    const actorId = `remote-${index}`
    incoming.clock[actorId] = 1
    return { dot: { actorId, counter: 1 }, context: {}, purpose: "workspace" as const, config: null }
  })
  incoming.entries[0].operations = operations
  const before = structuredClone(base)

  expect(() => mergePrivateReplicaState(base, incoming)).toThrow(/concurrent|operation|limit/i)
  expect(base).toEqual(before)
})

it("Given a local preference revision, when parsing, then preserve a valid value and reject malformed values", () => {
  const revision = "device-a:1|device-b:2"
  expect(parseReplicaConfig(JSON.stringify({ ...config, preferenceRevision: revision }))).toMatchObject({ preferenceRevision: revision })
  for (const preferenceRevision of ["", 12, "x".repeat(8_193), "contains spaces"]) {
    expect(() => parseReplicaConfig(JSON.stringify({ ...config, preferenceRevision }))).toThrow(/revision|settings/i)
  }
  const state = changeReplicaPreference(emptyPrivateReplicaState("owner", "device-a"), { ...config, preferenceRevision: revision })
  expect(portableReplicaState(state).entries[0].operations[0].config).not.toHaveProperty("preferenceRevision")
})

it("Given a workspace writer-v2 marker, when parsing, then retain only the supported explicit version", () => {
  expect(parseReplicaConfig(JSON.stringify({ ...config, minimumWriterVersion: 2 })))
    .toMatchObject({ minimumWriterVersion: 2 })
  for (const minimumWriterVersion of [null, 1, 3, "2", { version: 2 }]) {
    expect(() => parseReplicaConfig(JSON.stringify({ ...config, minimumWriterVersion })))
      .toThrow(/writer|settings|version/i)
  }
  expect(() => parsePrivateReplicaConfig(JSON.stringify({ ...identityConfig, minimumWriterVersion: 2 }), "owner"))
    .toThrow(/writer|identity|settings/i)
})

it("Given a confirmed writer-v2 workspace connection, when preferences transfer, then keep the marker without transferring progress", () => {
  const writerV2 = JSON.parse(JSON.stringify({ ...config, minimumWriterVersion: 2 })) as BlindReplicaConfig
  const base = changeReplicaPreference(emptyPrivateReplicaState("owner", "device-a"), writerV2)
  const acknowledged = updateReplicaProgress(base, { ...effectiveReplicaConfigs(base)[0], cursor: 19, lastUploaded: token })
  const wire = portableReplicaState(acknowledged)
  expect(wire.entries[0].operations[0].config).toMatchObject({ minimumWriterVersion: 2, cursor: 0, lastUploaded: "" })
  expect(wire).not.toHaveProperty("progress")
  const imported = mergePrivateReplicaState(emptyPrivateReplicaState("owner", "device-b"), wire)
  expect(effectiveReplicaConfigs(imported)[0]).toMatchObject({ minimumWriterVersion: 2, cursor: 0, lastUploaded: "" })
  expect(JSON.stringify(wire)).not.toContain('"pending"')
})

it("Given malformed person, actor, clock or operation bounds, when parsing, then reject the private state", () => {
  const base = portableReplicaState(changeReplicaPreference(emptyPrivateReplicaState("owner", "device-a"), config))
  expect(() => emptyPrivateReplicaState("x".repeat(129), "device-a")).toThrow(/person/i)
  expect(() => parsePrivateReplicaWire({ ...base, personId: 12 })).toThrow(/person/i)
  const invalidActor = structuredClone(base)
  invalidActor.entries[0].operations[0].dot.actorId = 12 as unknown as string
  expect(() => parsePrivateReplicaWire(invalidActor)).toThrow(/actor/i)
  const excessiveClock = structuredClone(base)
  excessiveClock.clock = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`device-${index}`, 1]))
  expect(() => parsePrivateReplicaWire(excessiveClock)).toThrow(/clock/i)
  const excessiveOperations = structuredClone(base)
  excessiveOperations.entries[0].operations = Array.from({ length: 33 }, (_, index) => ({
    dot: { actorId: `device-${index}`, counter: 1 }, context: {}, purpose: "workspace", config: null,
  }))
  excessiveOperations.clock = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`device-${index}`, 1]))
  expect(() => parsePrivateReplicaWire(excessiveOperations)).toThrow(/entry|operation/i)
})

it("Given legacy and tagged private credentials, when reading or writing preferences, then only v3 writes carry explicit purpose", () => {
  const state = changeReplicaPreference(emptyPrivateReplicaState("owner", "device-a"), config)
  const wire = portableReplicaState(state)
  expect(wire.version).toBe(3)
  expect(wire.entries[0].operations[0].config?.purpose).toBe("workspace")

  const legacy = structuredClone(wire) as unknown as { version: number; entries: Array<{ operations: Array<{ config: Record<string, unknown> | null }> }> }
  legacy.version = 2
  delete (legacy.entries[0].operations[0] as { purpose?: string }).purpose
  delete legacy.entries[0].operations[0].config!.purpose
  const readLegacy = parsePrivateReplicaWire(legacy)
  expect(readLegacy.version).toBe(3)
  expect(readLegacy.entries[0].operations[0].config?.purpose).toBe("workspace")
  expect(parseReplicaConfig(JSON.stringify({ ...config, purpose: "workspace" }))).toMatchObject({ purpose: "workspace" })
  expect(parsePrivateReplicaConfig(JSON.stringify(identityConfig))).toEqual(identityConfig)

  const hiddenIdentity = { ...identityConfig, workspaceId: "board" }
  expect(() => parseReplicaConfig(JSON.stringify(hiddenIdentity))).toThrow(/purpose|identity|settings/i)
  expect(() => parsePrivateReplicaConfig(JSON.stringify({ ...identityConfig, personId: "other" }), "owner"))
    .toThrow(/person|identity/i)
  expect(() => parsePrivateReplicaConfig(JSON.stringify({ ...identityConfig, purpose: "unknown" })))
    .toThrow(/purpose|settings/i)

  const disguisedV2 = structuredClone(wire) as unknown as { version: number; entries: Array<{ operations: Array<{ config: Record<string, unknown> | null }> }> }
  disguisedV2.version = 2
  disguisedV2.entries[0].operations[0].config = identityConfig
  expect(() => parsePrivateReplicaWire(disguisedV2)).toThrow(/purpose|legacy|private replica/i)
})

it("Given workspace and identity preferences sharing one opaque Rusty scope concurrently, when merged, then expose conflict and choose neither", () => {
  const base = emptyPrivateReplicaState("owner", "device-a")
  const workspace = changeReplicaPreference(base, { ...config, scopeId: identityConfig.scopeId })
  const identity = changeReplicaPreference({ ...base, actorId: "device-b" }, identityConfig)
  const merged = mergePrivateReplicaState(workspace, portableReplicaState(identity))
  expect(effectivePrivateReplicaConfigs(merged)).toEqual([])
  expect(replicaPreferenceConflicts(merged)).toEqual([{ origin: config.origin, scopeId: identityConfig.scopeId }])

  const separate = changeReplicaPreference(workspace, { ...identityConfig, scopeId: "C".repeat(43) })
  expect(effectiveReplicaConfigs(separate)).toHaveLength(1)
  expect(effectiveIdentityReplicaConfigs(separate, "owner")).toHaveLength(1)
})

it("Given an identity preference in a transferred v3 wire, when another person reads it, then reject before exposing that config", () => {
  const wire = portableReplicaState(changeReplicaPreference(emptyPrivateReplicaState("owner", "device-a"), identityConfig as PrivateReplicaConfig))
  const transferred = parsePrivateReplicaWire(wire).entries[0].operations[0].config
  expect(transferred?.purpose).toBe("identity")
  if (transferred?.purpose !== "identity") throw new Error("Identity config was not retained")
  expect(transferred.personId).toBe("owner")
  expect(() => parsePrivateReplicaWire({ ...wire, personId: "other" })).toThrow(/identity|person/i)
})
