import { describe, expect, it } from "vitest"
import { parseWireHistoryBaseline } from "../product-replica/historyBaselineReceiver"

const digest = "A".repeat(43)
function validWire() {
  const context = { workspaceId: "workspace-a", historyEpoch: 3, indexId: "basis-document" }
  const coverage = { payload: { kind: "blind-archive-coverage-aggregate-receipt", version: 1, serviceId: digest,
    scopeId: "scope-a", policyRevision: 1, requestId: "coverage-request-id-0001", archiveRootId: digest,
    height: 1, objectCount: 1, firstObjectId: digest, lastObjectId: digest, setDigest: digest, rootCovered: true },
    signerKeyId: digest, signature: "A".repeat(86) }
  return { version: 1, signedJson: "e30", basis: { context,
    reference: { kind: "workspace-history-bytes", version: 1,
      root: { objectId: digest, height: 0, count: 1, first: "0000000000000000", last: "0000000000000000" },
      byteLength: 4, partCount: 1 },
    locatorRoot: { kind: "workspace-history-locator-root", version: 1,
      context: { ...context, indexId: "archive-locators" },
      root: { objectId: digest, ciphertextId: digest, height: 0, count: 1,
        first: digest, last: digest } }, coverage } }
}

describe("WireHistoryBaseline", () => {
  it("Given a compact encrypted-basis locator, when read from a snapshot, then preserve exact detached routing", () => {
    const source = validWire()
    const wire = parseWireHistoryBaseline(source)
    source.basis.context.workspaceId = "mutated-after-read"
    expect(wire.basis.context.workspaceId).toBe("workspace-a")
    expect(wire.basis.reference.byteLength).toBe(4)
  })

  it.each([
    ["unknown fields", { ...validWire(), unexpected: true }],
    ["wrong index namespace", { ...validWire(), basis: { ...validWire().basis, context: { ...validWire().basis.context, indexId: "catalogue" } } }],
    ["mismatched locator context", { ...validWire(), basis: { ...validWire().basis,
      locatorRoot: { ...validWire().basis.locatorRoot, context: { ...validWire().basis.context, workspaceId: "other" } } } }],
    ["oversized compact document", { ...validWire(), basis: { ...validWire().basis,
      reference: { ...validWire().basis.reference, byteLength: 256 * 1024 * 1024 + 1 } } }],
    ["missing compact basis coverage", { ...validWire(), basis: { context: validWire().basis.context,
      reference: validWire().basis.reference, locatorRoot: validWire().basis.locatorRoot } }],
    ["batch receipt cannot prove complete compact basis coverage", { ...validWire(), basis: { ...validWire().basis,
      coverage: { ...validWire().basis.coverage, payload: { ...validWire().basis.coverage.payload,
        kind: "blind-archive-coverage-batch-receipt" } } } }],
  ])("Given %s routing, when parsing a history snapshot, then reject before remote reads", (_case, wire) => {
    expect(() => parseWireHistoryBaseline(wire)).toThrow()
  })
})
