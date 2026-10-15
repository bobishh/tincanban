import { beforeEach, describe, expect, it } from "vitest"
import { parseAutomationApproval } from "./automationApproval"
import { automationTypes, parseAutomationDefinition } from "./automationContract"
import { automationBodyHash } from "./automationProtocol"
import { bootstrapIdentity, resetIdentityStorageForTest } from "./identity"
import { createAutomationWorkspaceGrant, verifyWorkspaceGrant } from "./proofs"

const permissionsV1 = ["workspace.read", "board.lead.create", "board.application.advance"]
const permissionsV2 = [...permissionsV1, "board.application.source.append"]

function definition(typeVersion: number, permissions = typeVersion === 2 ? permissionsV2 : permissionsV1) {
  return { kind: "automation-definition", version: 1, id: "source-intake", name: "Source intake", type: "job-intake",
    typeVersion, parameters: { sources: ["website", "email"] }, permissions,
    scope: { workspaceId: "workspace", boardId: "board", grantId: "grant" } }
}

function approval(typeVersion: number, grantVersion: number) {
  const sameSigner = "owner-device"
  return {
    definition: { signerKeyId: sameSigner, signature: "signed-definition", payload: definition(typeVersion) },
    grant: { signerKeyId: sameSigner, signature: "signed-grant", payload: {
      kind: "workspace-grant", version: 1, grantId: "grant", workspaceId: "workspace", personId: "worker",
      role: "automation", accessEpoch: 1,
      automation: { version: grantVersion, boardId: "board",
        columns: { lead: "lead", applied: "applied", interview: "interview", rejected: "rejected" },
        fieldIds: ["company", "role", "jobUrl", "sourceText"], expiresAt: 2_000_000_000_000 },
    } },
  }
}

describe("versioned application source automation contract", () => {
  beforeEach(() => resetIdentityStorageForTest())

  it("Given registered intake versions, When parsing definitions, Then keep outer v1 and exact version-specific permissions", () => {
    expect(automationTypes.map(({ type, version, permissions }) => ({ type, version, permissions }))).toContainEqual({
      type: "job-intake", version: 1, permissions: permissionsV1,
    })
    expect(automationTypes.map(({ type, version, permissions }) => ({ type, version, permissions }))).toContainEqual({
      type: "job-intake", version: 2, permissions: permissionsV2,
    })
    expect(parseAutomationDefinition(definition(1))).toMatchObject({ version: 1, typeVersion: 1, permissions: permissionsV1 })
    expect(parseAutomationDefinition(definition(2))).toMatchObject({ version: 1, typeVersion: 2, permissions: permissionsV2 })
  })

  it("Given an intake definition, When it uses an unknown version or a non-exact permission set, Then reject before approval", () => {
    expect(() => parseAutomationDefinition(definition(3))).toThrow()
    expect(() => parseAutomationDefinition(definition(2, permissionsV1))).toThrow()
    expect(() => parseAutomationDefinition(definition(2, [...permissionsV2, "workspace.admin"]))).toThrow()
    expect(() => parseAutomationDefinition(definition(1, permissionsV2))).toThrow()
  })

  it("Given signed definition metadata and an automation grant, When versions match, Then accept; when they differ, reject", () => {
    expect(parseAutomationApproval(JSON.stringify(approval(1, 1)))).toBeDefined()
    expect(parseAutomationApproval(JSON.stringify(approval(2, 2)))).toBeDefined()
    expect(() => parseAutomationApproval(JSON.stringify(approval(1, 2)))).toThrow(/version|match/i)
    expect(() => parseAutomationApproval(JSON.stringify(approval(2, 1)))).toThrow(/version|match/i)
    expect(() => parseAutomationApproval(JSON.stringify(approval(3, 3)))).toThrow()
  })

  it("Given an owner identity, When explicitly issuing v1 and v2 workspace grants, Then both signatures verify and their signed scope hashes differ", async () => {
    const owner = await bootstrapIdentity("Application owner")
    const common = { boardId: "board", columns: { lead: "lead", applied: "applied", interview: "interview", rejected: "rejected" },
      fieldIds: ["company", "role", "jobUrl", "sourceText"], expiresAt: Date.now() + 60_000 }
    const grantV1 = await createAutomationWorkspaceGrant(owner, "workspace", "automation-person",
      { ...common, version: 1 })
    const grantV2 = await createAutomationWorkspaceGrant(owner, "workspace", "automation-person",
      { ...common, version: 2 })

    expect(grantV1.payload.automation?.version).toBe(1)
    expect(grantV2.payload.automation?.version).toBe(2)
    expect(await verifyWorkspaceGrant(grantV1, owner.device.publicKey)).toBe(true)
    expect(await verifyWorkspaceGrant(grantV2, owner.device.publicKey)).toBe(true)
    expect(await automationBodyHash(grantV1)).not.toBe(await automationBodyHash(grantV2))
  })
})
