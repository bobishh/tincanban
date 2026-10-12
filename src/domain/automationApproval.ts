import { z } from "zod"
import { parseAutomationDefinition } from "./automationContract"

const identifier = z.string().min(1).max(256)
const signature = { signerKeyId: identifier, signature: z.string().min(1).max(128) }
const approvalSchema = z.strictObject({
  definition: z.strictObject({ ...signature, payload: z.unknown().transform(parseAutomationDefinition) }),
  grant: z.strictObject({ ...signature, payload: z.strictObject({
    kind: z.literal("workspace-grant"), version: z.literal(1), grantId: identifier, workspaceId: identifier,
    personId: identifier, role: z.literal("automation"), accessEpoch: z.number().int().positive(),
    automation: z.strictObject({ version: z.literal(1), boardId: identifier,
      columns: z.strictObject({ lead: identifier, applied: identifier.optional(), interview: identifier, rejected: identifier }),
      fieldIds: z.array(identifier).min(1).max(128), expiresAt: z.number().int().positive(),
    }),
  }) }),
})

/** Public signed metadata only. Cryptographic admission remains mandatory before Worker execution. */
export function parseAutomationApproval(data: string) {
  if (data.length > 32768) throw new Error("Automation approval exceeds the size limit")
  const result = approvalSchema.parse(JSON.parse(data))
  const scope = result.definition.payload.scope
  const grant = result.grant.payload
  if (scope.workspaceId !== grant.workspaceId || scope.boardId !== grant.automation.boardId || scope.grantId !== grant.grantId ||
    result.definition.signerKeyId !== result.grant.signerKeyId) throw new Error("Automation approval does not match its signed type scope")
  return result
}

export function isAutomationApprovalData(data: string): boolean {
  try { parseAutomationApproval(data); return true } catch { return false }
}
