import { readFile } from "node:fs/promises"
import { beforeAll, expect, test, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { admissionAuthorityIdentity, computeWorkspaceDocumentAdmission, extendAutomationAdmission,
  type WorkspaceAdmissionResult, type WorkspaceWriteAuthorityEvidence } from "./workspaceAdmission"
import type { WorkspaceChangeAuthorization } from "./workspaceAuthorizationRecords"

beforeAll(async () => { await Automerge.initializeWasm(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")) })

test.each(["unchanged", "reordered certificates", "reordered certificates for one device", "owner proof metadata", "changed proof", "changed authority"] as const)(
  "Given an admitted board and %s, when a new change arrives, then only verified unchanged history can be reused", scenario => {
    const original = Automerge.from<WorkspaceDocumentV2>({ id: "workspace", title: "Board", entities: {} } as WorkspaceDocumentV2)
    const document = Automerge.change(Automerge.clone(original), draft => { draft.title = "Edited" })
    const [oldHash] = Automerge.getHeads(original)
    const [newHash] = Automerge.getHeads(document)
    const authority = { genesisOwner: { personId: "owner" }, genesisEpoch: 1, currentEpoch: 1,
      currentOwner: { personId: "owner", certificates: [{ signature: "one", payload: { deviceId: "first" } },
        { signature: "two", payload: { deviceId: scenario === "reordered certificates for one device" ? "first" : "second" } }] },
      ownershipTransfers: [], successionClaims: [], revocations: [], deviceRevocations: [], departures: [] } as unknown as WorkspaceWriteAuthorityEvidence
    const prior = { signed: { signature: "old", payload: { hashes: [oldHash!] } }, certificates: [] } as unknown as WorkspaceChangeAuthorization
    const newProof = { ...prior, signed: { ...prior.signed, signature: "new", payload: { ...prior.signed.payload, hashes: [newHash!] } } }
    const oldDecision = { hash: oldHash!, status: { type: "admitted", role: "owner" } } as const
    const currentProof = scenario === "changed proof" ? { ...prior, publicKey: "other" } :
      scenario === "owner proof metadata" ? { ...prior, ownerPublicKey: "already-accounted-for" } : prior
    const currentAuthority = scenario === "changed authority" ? { ...authority, currentEpoch: 2 } :
      scenario.startsWith("reordered") ? { ...authority, currentOwner: { ...authority.currentOwner,
        certificates: [...authority.currentOwner.certificates].reverse() } } : authority
    const plan = { verifiedAuthorizations: [currentProof, newProof], authorizedDocument: Automerge.save(document),
      decisions: [oldDecision, { ...oldDecision, hash: newHash! }] }
    const full = vi.fn(() => plan)
    const extension = vi.fn(() => ({ plan, evaluatedChanges: 1, reusedChanges: 1 }))
    try {
      const result = computeWorkspaceDocumentAdmission({ workspaceId: "workspace", knownAuthority: authority,
        now: 0, authorization: { version: 1, authority: currentAuthority, records: [currentProof, newProof] },
        admittedBase: { document: Automerge.save(original), decisions: [oldDecision], records: [prior],
          authorityIdentity: admissionAuthorityIdentity(authority) } },
      { authorizationRecordPages: () => [[currentProof, newProof]], prepareWriteEvidence: () => currentAuthority,
        evaluateCausalAdmission: full, evaluateCausalAdmissionExtension: extension }, document)
      expect(result.admittedHashes).toEqual([oldHash, newHash])
      if (scenario === "unchanged" || scenario === "reordered certificates" || scenario === "owner proof metadata") {
        expect(extension).toHaveBeenCalledOnce()
        expect(full).not.toHaveBeenCalled()
        expect(result.profile).toMatchObject({ evaluatedChanges: 1, reusedChanges: 1 })
      } else {
        expect(full).toHaveBeenCalledOnce()
        expect(extension).not.toHaveBeenCalled()
      }
    } finally { Automerge.free(original); Automerge.free(document) }
  })

test.each(["different heads", "pending history", "quarantined history"])(
  "Given %s, when extending local automation admission, then reject the base before trusting the incremental verifier", reason => {
    const base = Automerge.from({ id: "workspace" }) as Automerge.Doc<WorkspaceDocumentV2>
    const previous: WorkspaceAdmissionResult = { authorizedDocument: Automerge.save(base), authorizedHeads: Automerge.getHeads(base),
      neededHashes: [], admittedHashes: [], verifiedAuthorizations: [], authorizationEvidence: [], decisions: [], pendingHashes: [], quarantinedHashes: [] }
    if (reason === "different heads") previous.authorizedHeads = []
    if (reason === "pending history") previous.pendingHashes = ["pending"]
    if (reason === "quarantined history") previous.quarantinedHashes = ["quarantined"]
    const validateAuthoredAutomationChange = vi.fn()
    try {
      expect(() => extendAutomationAdmission({ base, document: base, previous,
        authorization: undefined as never, authority: undefined as never }, { validateAuthoredAutomationChange }))
        .toThrow("Local Automation command requires its exact admitted base")
      expect(validateAuthoredAutomationChange).not.toHaveBeenCalled()
    } finally { Automerge.free(base) }
  })
