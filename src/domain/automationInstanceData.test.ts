import { describe, expect, it } from "vitest"
import { toBase64Url } from "./identity"
import { parseAutomationInstanceBody, parseAutomationInstanceDescription, parseAutomationInstanceDiscovery } from "./automationInstanceData"

const scope = { workspaceId: "workspace-1", definitionId: "typed-definition", executorPersonId: "worker-person" }

describe("automation instance wire DTOs", () => {
  it("Given instance actions, When parsing bodies, Then accept only each exact required shape and detach nested packet", () => {
    expect(parseAutomationInstanceBody("discover", scope)).toEqual(scope)
    expect(parseAutomationInstanceBody("identity", { ...scope, integrationId: "legacy-route" })).toEqual({
      ...scope, integrationId: "legacy-route",
    })
    const packet = { grant: { value: 1 } }
    const activation = { ...scope, integrationId: "legacy-route", packet, adoptLegacy: false }
    const parsed = parseAutomationInstanceBody("activate", activation)
    packet.grant.value = 2
    expect(parsed).toMatchObject({ integrationId: "legacy-route", adoptLegacy: false, packet: { grant: { value: 1 } } })
    for (const [action, body] of [
      ["discover", { ...scope, integrationId: "route" }],
      ["identity", scope],
      ["activate", { ...scope, integrationId: "route", packet }],
      ["activate", { ...scope, integrationId: "route", packet, adoptLegacy: false, extra: true }],
    ] as const) expect(() => parseAutomationInstanceBody(action, body)).toThrow()
  })

  it("Given malformed identifiers or oversized DTO data, When parsing, Then reject before use", () => {
    for (const body of [
      { ...scope, workspaceId: " " }, { ...scope, workspaceId: "w".repeat(257) },
      { ...scope, definitionId: "bad/id" }, { ...scope, executorPersonId: "e".repeat(257) },
    ]) expect(() => parseAutomationInstanceBody("discover", body)).toThrow()
    expect(() => parseAutomationInstanceBody("activate", { ...scope, integrationId: "r", packet: "x".repeat(24 * 1024 * 1024 + 1), adoptLegacy: true }))
      .toThrow(/size/i)
  })

  it("Given instance descriptions, When parsing, Then enforce adoption and definition identity consistency", () => {
    const valid = { workspaceId: "workspace-1", boardId: "board-1", definitionId: "typed-definition",
      executorPersonId: "worker-person", grantId: "grant-1", expiresAt: 1_900_000_000_000,
      state: "paused", adoptionRequired: false }
    expect(parseAutomationInstanceDescription(valid)).toEqual(valid)
    const legacy = { ...valid, definitionId: null, adoptionRequired: true }
    expect(parseAutomationInstanceDescription(legacy)).toEqual(legacy)
    for (const invalid of [
      { ...valid, definitionId: null }, { ...legacy, definitionId: "typed-definition" },
      { ...valid, expiresAt: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, state: "pending" },
      { ...valid, extra: true },
    ]) expect(() => parseAutomationInstanceDescription(invalid)).toThrow()
  })

  it("Given an optional confirmed public storage binding, When parsing descriptions, Then retain it but reject credentials", () => {
    const valid = { workspaceId: "workspace-1", boardId: "board-1", definitionId: "typed-definition",
      executorPersonId: "worker-person", grantId: "grant-1", expiresAt: 1_900_000_000_000,
      state: "active", adoptionRequired: false }
    const storage = { origin: "https://rusty.example.test", scopeId: "scope-1", keyEpoch: 3,
      servicePublicKey: toBase64Url(new Uint8Array(32).fill(12)), policyRevision: 4 }
    expect(parseAutomationInstanceDescription({ ...valid, storage })).toMatchObject({ ...valid, storage })
    const upgraded = { ...storage, minimumWriterVersion: 2 as const }
    expect(parseAutomationInstanceDescription({ ...valid, storage: upgraded })).toMatchObject({ ...valid, storage: upgraded })
    for (const invalidStorage of [
      { ...storage, readToken: "secret" }, { ...storage, writeToken: "secret" },
      { ...storage, contentKey: "secret" }, { ...storage, privateKey: "secret" },
      { ...storage, minimumWriterVersion: 1 }, { ...storage, minimumWriterVersion: 3 },
      { ...storage, policyRevision: 0 }, { ...storage, servicePublicKey: "bad" },
    ]) expect(() => parseAutomationInstanceDescription({ ...valid, storage: invalidStorage })).toThrow()
    expect(parseAutomationInstanceDescription(valid)).toEqual(valid)
  })

  it("Given a Worker active-history budget, When reading its current status, Then preserve bounded progress and reject forged counters", () => {
    const valid = { workspaceId: "workspace-1", boardId: "board-1", definitionId: "typed-definition",
      executorPersonId: "worker-person", grantId: "grant-1", expiresAt: 1_900_000_000_000,
      state: "active", adoptionRequired: false }
    const historyUsage = { baselineId: null, admittedChanges: 511, encodedBytes: 3_999_999, archiveRequired: false }
    expect(parseAutomationInstanceDescription({ ...valid, historyUsage })).toMatchObject({ ...valid, historyUsage })
    expect(parseAutomationInstanceDescription({ ...valid, historyUsage: { ...historyUsage, admittedChanges: 512, archiveRequired: true } }))
      .toMatchObject({ historyUsage: { admittedChanges: 512, archiveRequired: true } })
    for (const invalid of [
      { ...historyUsage, admittedChanges: 513, archiveRequired: true },
      { ...historyUsage, encodedBytes: 4 * 1024 * 1024 + 1, archiveRequired: true },
      { ...historyUsage, admittedChanges: 512, archiveRequired: false },
      { ...historyUsage, encodedBytes: 4 * 1024 * 1024, archiveRequired: false },
      { ...historyUsage, encodedBytes: 10, extra: true },
    ]) expect(() => parseAutomationInstanceDescription({ ...valid, historyUsage: invalid })).toThrow()
  })

  it("Given discovery responses, When matching the expected route, Then reject duplicates and foreign scope", () => {
    const expected = { origin: "https://automation.example.test", workspaceId: "workspace-1",
      definitionId: "typed-definition", executorPersonId: "worker-person" }
    const value = { ...expected, integrations: [{ integrationId: "legacy-route" }, { integrationId: "other-route" }] }
    expect(parseAutomationInstanceDiscovery(value, expected)).toEqual(value)
    expect(() => parseAutomationInstanceDiscovery({ ...value, integrations: [{ integrationId: "legacy-route" },
      { integrationId: "legacy-route" }] }, expected)).toThrow(/duplicate/i)
    for (const mismatch of [{ ...expected, workspaceId: "other-workspace" }, { ...expected, executorPersonId: "other-person" },
      { ...expected, origin: "https://other.example.test" }]) {
      expect(() => parseAutomationInstanceDiscovery({ ...value, ...mismatch }, expected)).toThrow()
    }
    expect(() => parseAutomationInstanceDiscovery({ ...value, extra: true }, expected)).toThrow()
  })

  it("Given a storage rotation request, When parsing, Then bind exact transition and old storage without accepting renewal fields", () => {
    const storage = { origin: "https://rusty.example.test", scopeId: "scope-1", keyEpoch: 1,
      servicePublicKey: toBase64Url(new Uint8Array(32).fill(9)) }
    const body = { ...scope, integrationId: "worker-route", storage, transitionId: crypto.randomUUID() }
    expect(parseAutomationInstanceBody("prepare-storage-rotation", body)).toEqual(body)
    for (const invalid of [{ ...body, packet: {} }, { ...body, transitionId: "" }, { ...body, extra: true },
      { ...body, credentials: {} }, { ...body, storage: { ...storage, contentKey: "secret" } }]) {
      expect(() => parseAutomationInstanceBody("prepare-storage-rotation", invalid)).toThrow()
    }
    const credentials = { workspaceId: scope.workspaceId, origin: storage.origin, scopeId: storage.scopeId,
      servicePublicKey: storage.servicePublicKey, keyEpoch: 2, contentKey: toBase64Url(new Uint8Array(32).fill(2)),
      historicalContentKeys: { "1": toBase64Url(new Uint8Array(32).fill(1)) },
      readToken: toBase64Url(new Uint8Array(32).fill(3)), writeToken: toBase64Url(new Uint8Array(32).fill(4)),
      policyRevision: 2, minimumWriterVersion: 2, cursor: 0, lastUploaded: "" }
    expect(parseAutomationInstanceBody("rotate-storage", { ...body, credentials, receipt: { signed: true } })).toMatchObject({ credentials })
    expect(() => parseAutomationInstanceBody("rotate-storage", { ...body, credentials: { ...credentials, extra: true }, receipt: {} })).toThrow()
  })

  it("Given a current public scope receipt, When parsing refresh-access, Then preserve bounded receipt data and reject activation or secret fields", () => {
    const parseBody = parseAutomationInstanceBody as (action: string, value: unknown) => unknown
    const receipt = { signed: { payload: { policyRevision: 2 }, signature: "proof" } }
    const body = { ...scope, integrationId: "worker-route", storage: {
      origin: "https://rusty.example.test", scopeId: "scope-1", keyEpoch: 2,
      servicePublicKey: toBase64Url(new Uint8Array(32).fill(9)),
    }, receipt }
    const parsed = parseBody("refresh-access", body) as typeof body
    receipt.signed.payload.policyRevision = 99
    expect(parsed.receipt).toEqual({ signed: { payload: { policyRevision: 2 }, signature: "proof" } })
    expect(parsed).toEqual({ ...body, receipt: { signed: { payload: { policyRevision: 2 }, signature: "proof" } } })
    for (const invalid of [
      { ...body, packet: {} }, { ...body, adoptLegacy: true }, { ...body, contentKey: "secret" },
      { ...body, readToken: "secret" }, { ...body, writeToken: "secret" },
      { ...body, storage: { ...body.storage, origin: "http://rusty.example.test" } },
      { ...body, storage: { ...body.storage, scopeId: "bad/scope" } },
      { ...body, storage: { ...body.storage, keyEpoch: 0 } },
      { ...body, storage: { ...body.storage, servicePublicKey: `${"A".repeat(42)}B` } },
      { ...body, receipt: { signed: "x".repeat(129 * 1024) } },
      { ...body, extra: true },
    ]) expect(() => parseBody("refresh-access", invalid)).toThrow()
  })
})

it('Given history maintenance, when parsing Owner requests, then bind storage, transition, explicit trust anchor and exact target baseline without credentials', () => {
  const base = { workspaceId: 'board', definitionId: 'definition', executorPersonId: 'executor', integrationId: 'integration',
    storage: { origin: 'https://rusty.example', scopeId: 'scope', keyEpoch: 1, servicePublicKey: toBase64Url(new Uint8Array(32).fill(1)) }, transitionId: crypto.randomUUID() }
  expect(parseAutomationInstanceBody('prepare-history-baseline', { ...base, scopeAuthoritySnapshot: { genesis: 'opaque signed evidence' } })).toMatchObject(base)
  expect(parseAutomationInstanceBody('activate-history-baseline', { ...base, baselineId: 'A'.repeat(43) })).toMatchObject({ ...base, baselineId: 'A'.repeat(43) })
  expect(() => parseAutomationInstanceBody('activate-history-baseline', { ...base, baselineId: 'a'.repeat(43), credentials: 'forbidden' })).toThrow()
})
