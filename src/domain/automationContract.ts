import { z } from "zod"

const jobIntakePermissions = ["workspace.read", "board.lead.create", "board.application.advance"] as const
const sourceIntakePermissions = [...jobIntakePermissions, "board.application.source.append"] as const
const identifier = z.string().min(1).max(256)
const jobIntakeParameters = z.object({
  sources: z.array(z.enum(["website", "email"])).min(1).max(2)
    .refine(sources => new Set(sources).size === sources.length, "Event sources must be unique"),
}).strict()

/** Register only types with an implemented, version-matched Worker handler. */
export const automationTypes = Object.freeze([Object.freeze({
  type: "job-intake" as const,
  version: 1 as const,
  title: "Job intake",
  description: "Create Leads from submissions; advance matched applications from forwarded email.",
  permissions: Object.freeze([...jobIntakePermissions]),
  parameters: jobIntakeParameters,
}), Object.freeze({
  type: "job-intake" as const,
  version: 2 as const,
  title: "Job intake",
  description: "Retain vacancy evidence when creating Leads; advance matched applications from forwarded email.",
  permissions: Object.freeze([...sourceIntakePermissions]),
  parameters: jobIntakeParameters,
})])

const definitionSchema = z.object({
  kind: z.literal("automation-definition"),
  version: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  name: z.string().trim().min(1).max(100),
  type: z.literal("job-intake"),
  typeVersion: z.union([z.literal(1), z.literal(2)]),
  parameters: jobIntakeParameters,
  permissions: z.array(z.string()).min(3).max(4),
  scope: z.object({ workspaceId: identifier, boardId: identifier, grantId: identifier }).strict(),
}).strict()

export type AutomationDefinition = z.infer<typeof definitionSchema>

export function parseAutomationDefinition(value: unknown): AutomationDefinition {
  const definition = definitionSchema.parse(value)
  const permissions = definition.typeVersion === 1 ? jobIntakePermissions : sourceIntakePermissions
  if (definition.permissions.length !== permissions.length || definition.permissions.some((permission, index) => permission !== permissions[index])) {
    throw new Error("Automation permissions do not match its type version")
  }
  return definition
}
