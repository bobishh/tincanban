import { expect, it, vi } from "vitest"
import { admissionInputHash, createAdmissionCheckpoint, matchesAdmissionCheckpoint } from "./workspaceAdmissionCheckpoint"
import { bindAdmittedBase, retainedAdmissionBase } from "./workspaceAdmissionReuse"
import type { WorkspaceChangeAuthorization } from "../product-replica"

it("Given identical admission rules, when the frontend build changes, then its saved checkpoint is still current", async () => {
  const heads = ["head"]
  const decisions = [{ hash: "head", status: { type: "admitted", role: "owner" } }]
  try {
    vi.stubGlobal("__TINCANBAN_BUILD_COMMIT__", "a".repeat(40))
    const checkpoint = await createAdmissionCheckpoint("input", heads, decisions)
    vi.stubGlobal("__TINCANBAN_BUILD_COMMIT__", "b".repeat(40))
    await expect(matchesAdmissionCheckpoint(checkpoint, "input", heads, decisions)).resolves.toBe(true)
  } finally { vi.unstubAllGlobals() }
})

it("Given committed admission metadata, When history, rights, proofs, projection, decisions or policy differ, Then the stored result cannot be reused", async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const context = { workspaceId: "board", authority: "owner-epoch-1", proofs: ["signed-proof"] }
  const decisions = [{ hash: "change", status: { type: "admitted", role: "owner" } }]
  const inputHash = await admissionInputHash(bytes, context)
  const checkpoint = await createAdmissionCheckpoint(inputHash, ["head"], decisions)
  await expect(matchesAdmissionCheckpoint(checkpoint, inputHash, ["head"], decisions)).resolves.toBe(true)
  for (const changedHash of [
    await admissionInputHash(new Uint8Array([1, 2, 4]), context),
    await admissionInputHash(bytes, { ...context, authority: "owner-epoch-2" }),
    await admissionInputHash(bytes, { ...context, proofs: ["different-proof"] }),
  ]) await expect(matchesAdmissionCheckpoint(checkpoint, changedHash, ["head"], decisions)).resolves.toBe(false)
  await expect(matchesAdmissionCheckpoint(checkpoint, inputHash, ["other-head"], decisions)).resolves.toBe(false)
  await expect(matchesAdmissionCheckpoint(checkpoint, inputHash, ["head"], [])).resolves.toBe(false)
  await expect(matchesAdmissionCheckpoint({ ...checkpoint, policy: "older-policy" }, inputHash, ["head"], decisions)).resolves.toBe(false)
  await expect(matchesAdmissionCheckpoint(undefined, inputHash, ["head"], decisions)).resolves.toBe(false)
})

it("Given a committed admitted base, when the next sync offers a new head, then reuse only the exact local history, proofs, and authority", async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const records = [{ signed: { signature: "proof" } }] as WorkspaceChangeAuthorization[]
  const decisions = [{ hash: "head", status: { type: "admitted", role: "owner" } }] as const
  const baseDecisions = [...decisions]
  const checkpoint = await createAdmissionCheckpoint("received-input", ["head"], baseDecisions)
  const admissionCheckpoint = await bindAdmittedBase(checkpoint, bytes, records, "effective-authority")
  const evidence = { bytes, decisions: baseDecisions, authorizationEvidence: records, admissionCheckpoint }

  await expect(retainedAdmissionBase(["head"], evidence, "current-credential")).resolves.toEqual({
    document: bytes, decisions: baseDecisions, records, authorityIdentity: "effective-authority",
  })
  await expect(retainedAdmissionBase(["other"], evidence, "current-credential")).resolves.toBeUndefined()
  await expect(retainedAdmissionBase(["head"], { ...evidence, bytes: Uint8Array.of(4) }, "current-credential")).resolves.toBeUndefined()
  await expect(retainedAdmissionBase(["head"], { ...evidence, authorizationEvidence: [{ signed: { signature: "other" } }] },
    "current-credential")).resolves.toBeUndefined()
})
