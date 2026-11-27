import { expect, it } from "vitest"
import { parseAutomationApproval } from "./automationApproval"

function approval() {
  const grant = { payload: { kind: "workspace-grant", version: 1, grantId: "grant", workspaceId: "workspace", personId: "worker",
    role: "automation", accessEpoch: 1, automation: { version: 1, boardId: "board", columns: { lead: "lead", interview: "interview", rejected: "rejected" },
      fieldIds: ["company", "role"], expiresAt: 2000000000000 } }, signerKeyId: "owner-device", signature: "grant-signature" }
  const definition = { payload: { kind: "automation-definition", version: 1, id: "intake", name: "Intake", type: "job-intake", typeVersion: 1,
    parameters: { sources: ["website"] }, permissions: ["workspace.read", "board.lead.create", "board.application.advance"],
    scope: { workspaceId: "workspace", boardId: "board", grantId: "grant" } }, signerKeyId: "owner-device", signature: "definition-signature" }
  return { grant, definition }
}

it("Given public approval metadata, when restored, then it retains the exact signed grant and contains no storage credentials", () => {
  expect(parseAutomationApproval(JSON.stringify(approval()))).toEqual(approval())
  expect(() => parseAutomationApproval(JSON.stringify({ ...approval(), contentKey: "private" }))).toThrow()
})

it("Given mismatched grant, signer or board, when restoring public approval, then type authority cannot be rebound", () => {
  for (const patch of [{ signerKeyId: "other-device" }, { payload: { ...approval().grant.payload, grantId: "other-grant" } },
    { payload: { ...approval().grant.payload, workspaceId: "other-workspace" } },
    { payload: { ...approval().grant.payload, automation: { ...approval().grant.payload.automation, boardId: "other-board" } } }]) {
    expect(() => parseAutomationApproval(JSON.stringify({ ...approval(), grant: { ...approval().grant, ...patch } }))).toThrow()
  }
})

it("Given a standing approval, when restoring its metadata, then preserve scope and pin it to the same definition", () => {
  const original = approval()
  const { expiresAt, ...scope } = original.grant.payload.automation
  expect(expiresAt).toBeGreaterThan(0)
  const service = { version: 1, definitionId: original.definition.payload.id, issuerKeyId: "A".repeat(43) }
  const withScope = (automation: unknown) => ({
    ...original, grant: { ...original.grant, payload: { ...original.grant.payload, automation } },
  })

  const standing = withScope({ ...scope, service })
  expect(parseAutomationApproval(JSON.stringify(standing))).toEqual(standing)
  expect(() => parseAutomationApproval(JSON.stringify(withScope({ ...scope, service: { ...service, definitionId: "other" } })))).toThrow()
  expect(() => parseAutomationApproval(JSON.stringify(withScope({ ...scope, service, expiresAt: 2000000000000 })))).toThrow()
})
