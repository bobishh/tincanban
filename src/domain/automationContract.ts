import { z } from "zod"

import configuredTypes from "../../workers/automation/automation-types.json" with { type: "json" }
const identifier = z.string().min(1).max(256)
type ParameterField = { valueType: string; options?: string[]; multiple?: boolean; required?: boolean; min?: number; max?: number }
type ConfiguredType = { type: string; version: number; title: string; description: string; permissions: string[]; defaults: Record<string, unknown>; parameterFields: Record<string, ParameterField> }
const templates = [{ automation: { types: configuredTypes as ConfiguredType[] } }]
export const automationTypes = Object.freeze(templates.flatMap(template => template.automation?.types ?? []).map(type => Object.freeze({ ...type,
  permissions: Object.freeze([...type.permissions]), parameters: z.strictObject(Object.fromEntries(Object.entries(type.parameterFields).map(([key, field]) => [key, parameterSchema(field)]))),
})))

function parameterSchema(field: ParameterField): z.ZodType {
  const scalar = field.valueType === "select" ? z.enum(field.options ?? [])
    : field.valueType === "number" ? z.number() : field.valueType === "boolean" ? z.boolean() : z.string()
  const value = field.multiple ? z.array(scalar).min(field.min ?? 0).max(field.max ?? 100)
    .refine(values => new Set(values).size === values.length, "Values must be unique") : scalar
  return field.required ? value : value.optional()
}

const definitionSchema = z.object({
  kind: z.literal("automation-definition"),
  version: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  name: z.string().trim().min(1).max(100),
  type: identifier,
  typeVersion: z.number().int().positive(),
  parameters: z.record(z.string(), z.unknown()),
  permissions: z.array(z.string()).min(1).max(64),
  scope: z.object({ workspaceId: identifier, boardId: identifier, grantId: identifier }).strict(),
}).strict()

export type AutomationDefinition = z.infer<typeof definitionSchema>

export function parseAutomationDefinition(value: unknown): AutomationDefinition {
  const definition = definitionSchema.parse(value)
  const type = automationTypes.find(type => type.type === definition.type && type.version === definition.typeVersion)
  if (!type) throw new Error("Unsupported automation type or version")
  definition.parameters = JSON.parse(JSON.stringify(type.parameters.parse(definition.parameters))) as Record<string, unknown>
  const permissions = type.permissions
  if (definition.permissions.length !== permissions.length || definition.permissions.some((permission, index) => permission !== permissions[index])) {
    throw new Error("Automation permissions do not match its type version")
  }
  return definition
}
