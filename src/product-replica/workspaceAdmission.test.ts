import { readFile } from "node:fs/promises"
import { beforeAll, expect, test, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { extendAutomationAdmission, type WorkspaceAdmissionResult } from "./workspaceAdmission"

beforeAll(async () => { await Automerge.initializeWasm(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")) })

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
