import { cloneJsonData } from "./jsonData"
import { hasEntityKind } from "./model"
import type { Board, FieldDefinition, FieldValue, PriorityPolicy, PriorityRule, Item, WorkspaceDocumentV2 } from "./model"
import { canonicalizeJson } from "./identityCrypto"

function priorityOptionForScore(score: number, bands: Array<{ optionId: string; minScore: number }>): string | null {
  return [...bands].sort((a, b) => b.minScore - a.minScore).find(band => score >= band.minScore)?.optionId ?? null
}
import { compareRanks } from "./ancestry"

export type PriorityEvaluation = {
  score: number
  optionId: string | null
  matchedRuleIds: string[]
}

function matches(rule: PriorityRule, value: FieldValue | undefined): boolean {
  switch (rule.operator) {
    case "is_set": return value !== undefined && value !== null && value !== ""
    case "equals": return value === rule.value
    case "contains": return typeof value === "string" && typeof rule.value === "string"
      && value.toLowerCase().includes(rule.value.toLowerCase())
    case "at_least": return typeof value === "number" && typeof rule.value === "number" && value >= rule.value
    case "at_most": return typeof value === "number" && typeof rule.value === "number" && value <= rule.value
  }
}

export function evaluatePriority(policy: PriorityPolicy, values: Record<string, FieldValue>): PriorityEvaluation {
  const matched = policy.rules.filter(rule => matches(rule, values[rule.fieldId]))
  const score = Math.round(Math.max(0, Math.min(10, matched.reduce((sum, rule) => sum + rule.weight, 0))) * 10) / 10
  return { score, optionId: priorityOptionForScore(score, policy.bands), matchedRuleIds: matched.map(rule => rule.id) }
}

export function projectItemPriority(board: Board | null | undefined, item: Item, notesFieldId?: string): Item {
  const policy = board?.priorityPolicy
  if (!policy || policy.evaluator !== "weighted-rules-v1") return item
  const evaluation = evaluatePriority(policy, priorityValues(item, notesFieldId))
  return {
    ...item,
    values: {
      ...item.values,
      [policy.priorityFieldId]: evaluation.optionId,
      ...(policy.fitFieldId ? { [policy.fitFieldId]: evaluation.score } : {}),
    },
  }
}

export function orderItemsByPriority(board: Board | null | undefined, items: Item[], notesFieldId?: string): Item[] {
  const policy = board?.priorityPolicy
  const order = policy?.sort ?? "fit_desc"
  if (!policy || policy.evaluator !== "weighted-rules-v1" || order === "manual") return items
  const direction = order === "fit_desc" ? -1 : 1
  return items.map((item, index) => ({ item, index, score: evaluatePriority(policy, priorityValues(item, notesFieldId)).score }))
    .sort((a, b) => direction * (a.score - b.score) || a.index - b.index)
    .map(item => item.item)
}

function priorityValues(item: Item, notesFieldId?: string): Record<string, FieldValue> {
  const notes = notesFieldId ? item.values[notesFieldId] : undefined
  if (!notesFieldId) return item.values
  const narrative = [item.body, typeof notes === "string" ? notes : ""].filter(value => value.length > 0)
  return { ...item.values, [notesFieldId]: [...new Set(narrative)].join("\n\n") }
}

export function createDefaultPriorityPolicy(board: Board, fields: FieldDefinition[]): PriorityPolicy | null {
  if (board.priorityPolicy?.evaluator === "weighted-rules-v1") return cloneJsonData(board.priorityPolicy)
  const priority = fields.find(field => field.valueType === "select" && !field.archivedAt)
  if (!priority || priority.valueType !== "select") return null
  const options = Object.values(priority.options).filter(option => !option.archivedAt).sort((a, b) => compareRanks(a.rank, b.rank))
  const bands = options.map((option, index) => ({ optionId: option.id, minScore: Math.round((options.length - index - 1) * 10 / options.length) }))
  return { version: 1, evaluator: "weighted-rules-v1", sort: "fit_desc", priorityFieldId: priority.id,
    fitFieldId: fields.find(field => field.valueType === "number" && !field.archivedAt)?.id ?? null, rules: [], bands }

}

export function validatePriorityPolicy(
  policy: PriorityPolicy | null | undefined,
  doc: WorkspaceDocumentV2 | undefined,
  boardId: string,
  options: { preserveExistingUnsupported?: boolean } = {},
): Array<{ path: string; message: string }> {
  if (!policy) return []
  const errors: Array<{ path: string; message: string }> = []
  const preserveUnsupported = options.preserveExistingUnsupported === true && isUnchangedUnsupportedPolicy(policy, doc, boardId)
  if (policy.evaluator !== "weighted-rules-v1" && !preserveUnsupported) errors.push({ path: "/priorityPolicy/evaluator", message: "Unsupported priority evaluator. Configure field rules or disable automatic priority." })
  if (policy.evaluator === "weighted-rules-v1" && !policy.rules.length) errors.push({ path: "/priorityPolicy/rules", message: "Add at least one priority rule" })
  if (!policy.bands.length) errors.push({ path: "/priorityPolicy/bands", message: "Add at least one priority band" })
  const ids = new Set<string>()
  policy.rules.forEach((rule, index) => validatePriorityRule(rule, index, ids, policy, doc, boardId, errors))
  validatePriorityOutputs(policy, doc, boardId, errors)
  validatePriorityBands(policy, errors)
  return errors
}

function isUnchangedUnsupportedPolicy(policy: PriorityPolicy, doc: WorkspaceDocumentV2 | undefined, boardId: string): boolean {
  if (policy.evaluator === "weighted-rules-v1" || !doc) return false
  const board = doc.entities[boardId]
  if (!hasEntityKind(board, "board") || !board.priorityPolicy || board.priorityPolicy.evaluator === "weighted-rules-v1") return false
  const proposed = { ...cloneJsonData(policy), sort: policy.sort ?? "fit_desc" }
  const current = { ...cloneJsonData(board.priorityPolicy), sort: board.priorityPolicy.sort ?? "fit_desc" }
  return canonicalizeJson(proposed) === canonicalizeJson(current)
}

function validatePriorityOutputs(policy: PriorityPolicy, doc: WorkspaceDocumentV2 | undefined, boardId: string, errors: Array<{ path: string; message: string }>): void {
  if (!doc) return
  const priority = doc.entities[policy.priorityFieldId]
  if (!priority || !hasEntityKind(priority, "field") || priority.archivedAt || priority.valueType !== "select" || priority.placement.parentId !== boardId) {
    errors.push({ path: "/priorityPolicy/priorityFieldId", message: "Priority output must be an active select field" })
  } else policy.bands.forEach((band, index) => {
    const option = priority.options[band.optionId]
    if (!option || option.archivedAt) errors.push({ path: `/priorityPolicy/bands/${index}/optionId`, message: "Priority band must target an active option" })
  })
  if (!policy.fitFieldId) return
  const fit = doc.entities[policy.fitFieldId]
  if (!fit || !hasEntityKind(fit, "field") || fit.archivedAt || fit.valueType !== "number" || fit.placement.parentId !== boardId) errors.push({ path: "/priorityPolicy/fitFieldId", message: "Fit output must be an active number field" })
}

function validatePriorityBands(policy: PriorityPolicy, errors: Array<{ path: string; message: string }>): void {
  const options = new Set<string>()
  policy.bands.forEach((band, index) => {
    const path = `/priorityPolicy/bands/${index}`
    if (!Number.isFinite(band.minScore) || band.minScore < 0 || band.minScore > 10) errors.push({ path: `${path}/minScore`, message: "Priority threshold must be between 0 and 10" })
    if (options.has(band.optionId)) errors.push({ path: `${path}/optionId`, message: "Priority band option is duplicated" })
    options.add(band.optionId)
  })
  if (policy.bands.length && !policy.bands.some(band => band.minScore === 0)) errors.push({ path: "/priorityPolicy/bands", message: "Priority bands need a fallback at score 0" })
}

function validatePriorityRule(rule: PriorityRule, index: number, ids: Set<string>, policy: PriorityPolicy, doc: WorkspaceDocumentV2 | undefined, boardId: string, errors: Array<{ path: string; message: string }>): void {
  if (ids.has(rule.id)) errors.push({ path: `/priorityPolicy/rules/${index}/id`, message: "Rule id is duplicated" })
  ids.add(rule.id)
  if (!Number.isFinite(rule.weight) || rule.weight < -10 || rule.weight > 10) errors.push({ path: `/priorityPolicy/rules/${index}/weight`, message: "Rule weight must be between -10 and 10" })
  if (!doc) return
  if (rule.fieldId === policy.priorityFieldId || rule.fieldId === policy.fitFieldId) {
    errors.push({ path: `/priorityPolicy/rules/${index}/fieldId`, message: "A rule cannot read its own output field" })
    return
  }
  const field = doc.entities[rule.fieldId]
  if (!field || !hasEntityKind(field, "field") || field.archivedAt || field.placement.parentId !== boardId) {
    errors.push({ path: `/priorityPolicy/rules/${index}/fieldId`, message: "Rule field must be active on this board" })
    return
  }
  validateRuleOperator(rule, field, index, errors)
}

function validateRuleOperator(rule: PriorityRule, field: FieldDefinition, index: number, errors: Array<{ path: string; message: string }>): void {
  const base = `/priorityPolicy/rules/${index}`
  if ((rule.operator === "at_least" || rule.operator === "at_most") && field.valueType !== "number") errors.push({ path: `${base}/operator`, message: "Numeric comparison requires a number field" })
  if (rule.operator === "contains" && field.valueType !== "text" && field.valueType !== "url") errors.push({ path: `${base}/operator`, message: "Contains requires a text or URL field" })
  if (field.valueType === "select" && rule.operator === "equals" && (!field.options[String(rule.value)] || field.options[String(rule.value)].archivedAt)) errors.push({ path: `${base}/value`, message: "Rule value must be an active option" })
  if (rule.operator === "equals" && !matchesFieldValue(field.valueType, rule.value)) errors.push({ path: `${base}/value`, message: "Rule value must match the field type" })
}

function matchesFieldValue(type: FieldDefinition["valueType"], value: FieldValue): boolean {
  return type === "number" ? typeof value === "number" : type === "boolean" ? typeof value === "boolean" : typeof value === "string"
}
