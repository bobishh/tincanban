import { expect, it } from "vitest"
import { admissionInputHash, createAdmissionCheckpoint, matchesAdmissionCheckpoint } from "./workspaceAdmissionCheckpoint"

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
