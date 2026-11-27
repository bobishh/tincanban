import { z } from "zod"
import { parseAutomationDefinition } from "./automationContract"

const identifier = z.string().min(1).max(256)
const signature = { signerKeyId: identifier, signature: z.string().min(1).max(128) }
const grantFields = {
  kind: z.literal("workspace-grant"), version: z.literal(1), grantId: identifier, workspaceId: identifier,
  personId: identifier, role: z.literal("automation"), accessEpoch: z.number().int().positive(),
}
const scopeFields = {
  version: z.union([z.literal(1), z.literal(2)]), boardId: identifier,
  columns: z.strictObject({ lead: identifier, applied: identifier.optional(), interview: identifier, rejected: identifier }),
  fieldIds: z.array(identifier).min(1).max(128),
}
const service = z.strictObject({ version: z.literal(1), definitionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
  issuerKeyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) })
const grantSchema = z.strictObject({ ...signature, payload: z.strictObject({ ...grantFields,
  automation: z.strictObject({ ...scopeFields, expiresAt: z.number().int().positive().optional(), service: service.optional() })
    .refine(scope => (scope.expiresAt === undefined) !== (scope.service === undefined)),
}) })
const approvalSchema = z.strictObject({
  definition: z.strictObject({ ...signature, payload: z.unknown().transform(parseAutomationDefinition) }),
  grant: grantSchema,
})

type GrantMetadata = z.infer<typeof grantSchema>
type BoardScope = Omit<GrantMetadata["payload"]["automation"], "expiresAt" | "service">
type ScopedGrant<T> = GrantMetadata & { payload: { automation: BoardScope & T } }
export type LegacyAutomationGrant = ScopedGrant<{ expiresAt: number }>
type StandingAutomationGrant = ScopedGrant<{ service: z.infer<typeof service> }>
type Approval = { definition: z.infer<typeof approvalSchema>["definition"]; grant: LegacyAutomationGrant | StandingAutomationGrant }

export function isLegacyAutomationGrant(grant: Approval["grant"]): grant is LegacyAutomationGrant {
  return grant.payload.automation.expiresAt !== undefined
}

/** Public signed metadata only. Cryptographic admission remains mandatory before Worker execution. */
export function parseAutomationApproval(data: string): Approval {
  if (data.length > 32768) throw new Error("Automation approval exceeds the size limit")
  const result = approvalSchema.parse(JSON.parse(data))
  const scope = result.definition.payload.scope
  const grant = result.grant.payload
  if (grant.automation.service && grant.automation.service.definitionId !== result.definition.payload.id) {
    throw new Error("Service approval does not match the automation definition")
  }
  if (result.definition.payload.typeVersion !== grant.automation.version) throw new Error("Automation approval version does not match its signed grant")
  if (scope.workspaceId !== grant.workspaceId || scope.boardId !== grant.automation.boardId || scope.grantId !== grant.grantId ||
    result.definition.signerKeyId !== result.grant.signerKeyId) throw new Error("Automation approval does not match its signed type scope")
  return result as Approval
}

export function isAutomationApprovalData(data: string): boolean {
  try { parseAutomationApproval(data); return true } catch { return false }
}
