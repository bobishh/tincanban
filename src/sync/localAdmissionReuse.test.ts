import { describe, expect, it } from "vitest"
import type { WorkspaceAdmissionResult } from "../product-replica/workspaceAdmission"
import { canReuseAdmittedDocument } from "./localAdmissionReuse"

function admission(overrides: Partial<WorkspaceAdmissionResult> = {}): WorkspaceAdmissionResult {
  return { neededHashes: ["change-a", "change-b"], admittedHashes: ["change-a", "change-b"],
    verifiedAuthorizations: [], authorizationEvidence: [], quarantinedHashes: [], pendingHashes: [],
    decisions: [
      { hash: "change-a", status: { type: "admitted", role: "owner" } },
      { hash: "change-b", status: { type: "admitted", role: "owner" } },
    ], authorizedDocument: new Uint8Array(), authorizedHeads: ["head-b"], ...overrides }
}

describe("local admission document reuse", () => {
  it("reuses handle only when all admitted changes produce same heads", () => {
    expect(canReuseAdmittedDocument(admission(), ["head-b"])).toBe(true)
    expect(canReuseAdmittedDocument(admission(), ["head-b", "head-a"])).toBe(false)
  })

  it.each(["pending", "quarantined"] as const)("keeps authorized projection path for %s changes", type => {
    const value = admission({ decisions: [
      { hash: "change-a", status: { type, reason: "untrusted change" } },
      { hash: "change-b", status: { type: "admitted", role: "owner" } },
    ], admittedHashes: ["change-b"] })
    expect(canReuseAdmittedDocument(value, ["head-b"])).toBe(false)
  })

  it("keeps authorized projection path when admission omitted a known change", () => {
    const value = admission({ decisions: [{ hash: "change-a", status: { type: "admitted", role: "owner" } }] })
    expect(canReuseAdmittedDocument(value, ["head-b"])).toBe(false)
  })

  it("keeps newly admitted history when its head is absent from the local candidate", () => {
    const value = admission({ authorizedHeads: ["newly-admitted-branch"] })
    expect(canReuseAdmittedDocument(value, ["head-b"])).toBe(false)
  })
})
