import { expect, it } from "vitest"
import { automationTypes, parseAutomationDefinition } from "./automationContract"

const definition = () => ({
  kind: "automation-definition", version: 1, id: "applications", name: "Job intake", type: "job-intake", typeVersion: 1,
  parameters: { sources: ["website", "email"] },
  permissions: ["workspace.read", "board.lead.create", "board.application.advance"],
  scope: { workspaceId: "workspace", boardId: "board", grantId: "grant" },
})

it("Given the supported type registry, when creating a definition, then its version, parameters, rights and scope are explicit", () => {
  expect(automationTypes.map(type => [type.type, type.version])).toEqual([["job-intake", 1], ["job-intake", 2]])
  expect(parseAutomationDefinition(definition())).toEqual(definition())
})

it.each([
  { type: "arbitrary-code" }, { typeVersion: 2 }, { version: 2 },
  { parameters: { sources: ["website"], script: "execute this" } },
  { parameters: { sources: ["timer"] } }, { parameters: { sources: [] } },
  { parameters: { sources: ["email", "email"] } },
  { permissions: ["workspace.admin"] },
  { scope: { workspaceId: "workspace", boardId: "board" } },
  { scope: { workspaceId: "workspace", boardId: "board", grantId: "grant", allBoards: true } },
])("Given unsupported automation data %j, when validated, then it is rejected before execution", invalid => {
  expect(() => parseAutomationDefinition({ ...definition(), ...invalid })).toThrow()
})

it("Given a parsed definition, when callers mutate their input, then the validated contract does not change", () => {
  const input = definition()
  const parsed = parseAutomationDefinition(input)
  input.parameters.sources.push("timer")
  input.permissions.push("workspace.admin")
  expect(parsed.parameters.sources).toEqual(["website", "email"])
  expect(parsed.permissions).toHaveLength(3)
})
