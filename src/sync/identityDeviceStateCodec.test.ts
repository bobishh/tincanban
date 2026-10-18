import { expect, it } from "vitest"
import { decodeIdentityDeviceState, encodeIdentityDeviceState, IdentityDeviceStateUpgradeRequiredError,
  identityDeviceStateSchemas, type IdentityDeviceStateInput } from "./identityDeviceStateCodec"

const personId = "person_A"
const schemas = {
  identityCatalog: "identity-catalog@1",
  profileObservations: "profile-observations@1",
  workspaceReferences: "entitled-workspaces@1",
  privateConnections: "private-rusty-connections@3",
  ownerCapabilities: "owner-capabilities@2",
  recoveryEvidence: "identity-recovery-evidence@1",
} as const

function component(schema: string, value: Record<string, unknown>, required = true) {
  return { schema, required, value }
}

function state(): IdentityDeviceStateInput {
  return {
    kind: "identity-device-state",
    version: 1,
    personId,
    components: {
      identityCatalog: component(schemas.identityCatalog, { personId, rootId: "root-1", devices: [] }),
      profileObservations: component(schemas.profileObservations, { personId, observations: [{ displayName: "Ada", photo: { avatarData: "data:image/png;base64,opaque", changedAt: "2026-01-01T00:00:00Z" } }] }),
      workspaceReferences: component(schemas.workspaceReferences, { personId, workspaces: [{ workspaceId: "board-1", grantHash: "opaque-grant", role: "owner" }] }),
      privateConnections: component(schemas.privateConnections, { version: 3, personId, clock: {}, entries: [] }),
      ownerCapabilities: component(schemas.ownerCapabilities, { personId, capabilities: [{ service: "opaque-service", scope: "board-1", operations: ["manage"] }] }),
      recoveryEvidence: component(schemas.recoveryEvidence, { personId, envelopes: [{ kind: "identity-recovery-envelope", version: 1, ciphertext: "opaque-envelope", salt: "opaque-salt" }] }),
    },
  }
}

it("Given complete same-person state, when encoded and decoded, then preserves portable components and opaque recovery envelopes", () => {
  const input = state()
  const bytes = encodeIdentityDeviceState(input)
  const decoded = decodeIdentityDeviceState(bytes, personId)

  expect(decoded).toEqual(input)
  expect(new TextDecoder().decode(bytes)).not.toMatch(/identityPrivateKey|devicePrivateKey|recoveryKey/)
})

it("Given a manifest writer, when it advertises owner capabilities, then it requires schema v2", () => {
  expect(identityDeviceStateSchemas.ownerCapabilities).toBe("owner-capabilities@2")
})

it("Given legacy scope capabilities and new person capabilities, when decoding, then preserve v1 bytes and accept person only in v2", () => {
  const legacy = state()
  legacy.components.ownerCapabilities!.schema = "owner-capabilities@1"
  expect(decodeIdentityDeviceState(legacy, personId)).toEqual(legacy)

  const person = state()
  person.components.ownerCapabilities!.schema = "owner-capabilities@2"
  person.components.ownerCapabilities!.value.capabilities = [{
    binding: { origin: "https://rusty.example", resourceKind: "person", resourceId: personId },
    capability: { payload: { kind: "rusty-person-management-capability" } },
  }]
  expect(decodeIdentityDeviceState(person, personId)).toEqual(person)

  const legacyBinding = structuredClone(person)
  legacyBinding.components.ownerCapabilities!.schema = "owner-capabilities@1"
  legacyBinding.components.ownerCapabilities!.value.capabilities = [{
    binding: { origin: "https://rusty.example", resourceKind: "person", resourceId: personId },
    capability: { payload: { kind: "rusty-scope-management-capability" } },
  }]
  expect(() => decodeIdentityDeviceState(legacyBinding, personId)).toThrow(IdentityDeviceStateUpgradeRequiredError)

  const legacyDiscriminator = structuredClone(person)
  legacyDiscriminator.components.ownerCapabilities!.schema = "owner-capabilities@1"
  legacyDiscriminator.components.ownerCapabilities!.value.capabilities = [{
    binding: { origin: "https://rusty.example", resourceKind: "scope", resourceId: "scope-1" },
    capability: { payload: { kind: "rusty-person-management-capability" } },
  }]
  expect(() => decodeIdentityDeviceState(legacyDiscriminator, personId)).toThrow(IdentityDeviceStateUpgradeRequiredError)
})

it("Given tagged private connections, when transferring the new required schema, then preserve v3 and reject the retired v2 component", () => {
  const tagged = state()
  tagged.components.privateConnections.schema = "private-rusty-connections@3"
  tagged.components.privateConnections.value.version = 3
  expect(decodeIdentityDeviceState(tagged, personId)).toEqual(tagged)
  const retired = state()
  retired.components.privateConnections.schema = "private-rusty-connections@2"
  retired.components.privateConnections.value.version = 2
  expect(() => decodeIdentityDeviceState(retired, personId)).toThrow(IdentityDeviceStateUpgradeRequiredError)
})

it("Given v3 connections disguised as the legacy schema, when decoding, then require the correctly versioned component", () => {
  const disguised = state()
  disguised.components.privateConnections.schema = "private-rusty-connections@2"
  disguised.components.privateConnections.value.version = 3
  expect(() => decodeIdentityDeviceState(disguised, personId)).toThrow(/schema|version|upgrade/i)
})

it("Given a key-history-capable connection schema, when decoding, then require version 5 while retaining older readers only for older wire shapes", () => {
  expect(identityDeviceStateSchemas.privateConnections).toBe("private-rusty-connections@5")
  const current = state()
  current.components.privateConnections.schema = identityDeviceStateSchemas.privateConnections
  current.components.privateConnections.value.version = 5
  expect(decodeIdentityDeviceState(current, personId)).toEqual(current)
  current.components.privateConnections.value.version = 3
  expect(() => decodeIdentityDeviceState(current, personId)).toThrow(/version|schema|upgrade/i)
})

it("Given historical reading keys hidden outside private connections, when decoding, then reject the credential disclosure", () => {
  const input = state()
  input.components.extra = component("future@1", { historicalContentKeys: { "1": "A".repeat(43) } }, false)
  expect(() => decodeIdentityDeviceState(input, personId)).toThrow(/private connection|credentials/i)
})

it("Given a missing portable component, when decoding, then fail closed instead of silently dropping device state", () => {
  const input = state()
  delete input.components.ownerCapabilities
  expect(() => decodeIdentityDeviceState(input, personId)).toThrow(/required|component/i)
})

it("Given an unknown required component or unsupported known schema, when decoding, then report upgrade-required distinctly", () => {
  const unknown = state() as IdentityDeviceStateInput & { components: Record<string, { schema: string; required: boolean; value: unknown }> }
  unknown.components.futureKeyMaterial = component("future-key-material@1", { personId, envelope: "opaque" })
  expect(() => decodeIdentityDeviceState(unknown, personId)).toThrow(IdentityDeviceStateUpgradeRequiredError)

  const unsupported = state()
  unsupported.components.profileObservations!.schema = "profile-observations@9"
  expect(() => decodeIdentityDeviceState(unsupported, personId)).toThrow(IdentityDeviceStateUpgradeRequiredError)
  expect(() => decodeIdentityDeviceState({ ...state(), version: 9 }, personId)).toThrow(IdentityDeviceStateUpgradeRequiredError)
})

it("Given state or any required component bound to another person, when decoding, then reject before returning private data", () => {
  expect(() => decodeIdentityDeviceState({ ...state(), personId: "person_B" }, personId)).toThrow(/identity|person/i)
  const nested = state()
  nested.components.privateConnections!.value = { version: 3, personId: "person_B", clock: {}, entries: [] }
  expect(() => decodeIdentityDeviceState(nested, personId)).toThrow(/identity|person/i)
})

it("Given a portable connection carrying another device's cursor or acknowledgment, when decoding, then reject it", () => {
  const input = state()
  input.components.privateConnections!.value = {
    version: 2,
    personId,
    clock: {},
    entries: [{ origin: "https://rusty.example", scopeId: "scope-1", operations: [{
      dot: { actorId: "actor-a", counter: 1 }, context: {},
      config: { origin: "https://rusty.example", scopeId: "scope-1", workspaceId: "board-1", servicePublicKey: "key",
        readToken: "read", writeToken: "write", contentKey: "content-key", policyRevision: 1, keyEpoch: 1,
        cursor: 9, lastUploaded: "device-local-ack" },
    }] }],
  }
  expect(() => decodeIdentityDeviceState(input, personId)).toThrow(/cursor|progress|portable/i)
})

it("Given a private key field in a portable component, when decoding, then reject the export while retaining opaque key envelopes", () => {
  const input = state()
  input.components.identityCatalog!.value = { personId, rootId: "root-1", identityPrivateKey: "must-not-export" }
  expect(() => decodeIdentityDeviceState(input, personId)).toThrow(/private key|secret|key material/i)
})

it("Given serialized PKCS8 or JWK private keys hidden in nested optional state, when decoding, then reject instead of forwarding key material", () => {
  for (const field of ["identityPrivateKeyPkcs8", "devicePrivateKeyPkcs8", "private_key_pkcs8", "privateKeyJwk", "identityPrivateKeyJwk"]) {
    const input = state()
    input.components.future = component("future@1", { personId, nested: [{ [field]: "must-not-export" }] }, false)
    expect(() => decodeIdentityDeviceState(input, personId)).toThrow(/private key|secret|key material/i)
  }
})

it("Given a non-ASCII manifest larger than one MiB in UTF-8, when encoding or decoding, then enforce the same byte limit", () => {
  const input = state()
  input.components.profileObservations!.value.observations = ["é".repeat(550_000)]
  expect(() => encodeIdentityDeviceState(input)).toThrow(/size limit/i)
  expect(() => decodeIdentityDeviceState(input, personId)).toThrow(/size limit/i)
})

it("Given an optional future component named __proto__, when decoding JSON, then preserve it as data without changing the component map prototype", () => {
  const base = state()
  const components = JSON.stringify(base.components).replace(/^\{/, `{"__proto__":${JSON.stringify(component("future-extension@1", { personId, marker: "kept" }, false))},`)
  const wire = JSON.parse(`{"kind":"identity-device-state","version":1,"personId":${JSON.stringify(personId)},"components":${components}}`) as unknown

  const decoded = decodeIdentityDeviceState(wire, personId)

  expect(Object.getPrototypeOf(decoded.components)).toBe(Object.prototype)
  expect(Object.hasOwn(decoded.components, "__proto__")).toBe(true)
  expect(decoded.components["__proto__"]?.value).toEqual({ personId, marker: "kept" })
})

it('Given an older private connection schema with variant history, when decoding, then fail closed instead of ignoring candidates', () => {
  const input = state()
  input.components.privateConnections = component('private-rusty-connections@4', { personId: input.personId, version: 5, clock: {}, entries: [] }, true)
  expect(() => decodeIdentityDeviceState(input, input.personId)).toThrow(/schema|version|upgrade/i)
})
