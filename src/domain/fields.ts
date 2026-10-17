import { textFormatSchema } from "./entitySchemas"
import type {
  CommandResult,
  FieldDefinition,
  FieldValue,
} from "./model"

export function validateFieldValue(
  field: FieldDefinition,
  value: FieldValue | undefined,
  allowDeprecatedOptions = false
): { valid: boolean; issue?: string } {
  if (value === undefined || value === null || value === "") {
    if (field.required && !field.archivedAt) {
      return { valid: false, issue: `${field.title} is required` }
    }
    return { valid: true }
  }

  if (field.valueType === "text" && field.format === "json" && typeof value === "string") {
    try { JSON.parse(value) } catch { return invalid(`${field.title} must be valid JSON`) }
  }
  return field.valueType === "number" ? validateNumber(field, value)
    : field.valueType === "select" ? validateSelect(field, value, allowDeprecatedOptions)
      : validateScalar(field.valueType, field.title, value)
}

type FieldValidation = { valid: boolean; issue?: string }
const valid = (): FieldValidation => ({ valid: true })
const invalid = (issue: string): FieldValidation => ({ valid: false, issue })

function validateScalar(type: Exclude<FieldDefinition["valueType"], "number" | "select">, title: string, value: FieldValue): FieldValidation {
  if (type === "text") return typeof value === "string" ? valid() : invalid(`${title} must be text`)
  if (type === "boolean") return typeof value === "boolean" ? valid() : invalid(`${title} must be true or false`)
  if (type === "url") return typeof value === "string" && /https?:\/\//.test(value) ? valid() : invalid(`${title} must be a valid URL starting with http:// or https://`)
  if (type === "date") return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? valid() : invalid(`${title} must be a date formatted as YYYY-MM-DD`)
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/.test(value) && !Number.isNaN(Date.parse(value)) ? valid() : invalid(`${title} must be a valid datetime`)
}

function validateNumber(field: Extract<FieldDefinition, { valueType: "number" }>, value: FieldValue): FieldValidation {
  if (typeof value !== "number" || !Number.isFinite(value)) return invalid(`${field.title} must be a valid finite number`)
  if (field.min !== null && value < field.min) return invalid(`${field.title} must be at least ${field.min}`)
  return field.max !== null && value > field.max ? invalid(`${field.title} must be at most ${field.max}`) : valid()
}

function validateSelect(field: Extract<FieldDefinition, { valueType: "select" }>, value: FieldValue, allowDeprecated: boolean): FieldValidation {
  if (typeof value !== "string") return invalid(`${field.title} must be an option ID`)
  const option = field.options[value]
  if (!option) return invalid(`${field.title} has an invalid option selected`)
  return option.archivedAt && !allowDeprecated ? invalid(`${field.title} option "${option.title}" is no longer available`) : valid()
}

export function validateItemValues(
  boardFields: FieldDefinition[],
  values: Record<string, FieldValue>,
  allowDeprecatedOptions = false
): { ok: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {}

  for (const field of boardFields) {
    const val = values[field.id]
    const res = validateFieldValue(field, val, allowDeprecatedOptions)
    if (!res.valid) {
      errors[field.id] = res.issue || "Invalid value"
    }
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
  }
}

export function resolveSelectDisplay(
  field: FieldDefinition,
  value: FieldValue
): { label: string; unavailable: boolean } {
  if (field.valueType !== "select") {
    return { label: String(value ?? ""), unavailable: false }
  }
  if (!value) {
    return { label: "", unavailable: false }
  }

  const optionId = String(value)
  const option = field.options[optionId]
  if (!option) {
    return { label: `Unknown (${optionId})`, unavailable: true }
  }
  if (option.archivedAt) {
    return { label: option.title, unavailable: true }
  }
  return { label: option.title, unavailable: false }
}

export function patchFieldDefinition(
  field: FieldDefinition,
  patch: {
    title?: string
    required?: boolean
    min?: number | null
    max?: number | null
    valueType?: string
    format?: "plain" | "markdown" | "json" | "code" | null
  }
): CommandResult<FieldDefinition> {
  if (patch.valueType && patch.valueType !== field.valueType) {
    return {
      ok: false,
      error: {
        code: "field_type_change",
        message: "Cannot change field valueType. Create a replacement field instead.",
      },
    }
  }

  if (patch.format !== undefined && (field.valueType !== "text" || patch.format !== null && !textFormatSchema.safeParse(patch.format).success)) return { ok: false, error: { code: "invalid_input", message: "Invalid text field format" } }

  const updated: FieldDefinition = {
    ...field,
    title: patch.title !== undefined ? patch.title.trim() : field.title,
    required: patch.required !== undefined ? patch.required : field.required,
    updatedAt: new Date().toISOString(),
  }

  if (updated.valueType === "text" && patch.format !== undefined) {
    if (patch.format === null) delete updated.format
    else updated.format = patch.format
  }

  if (field.valueType === "number") {
    const numField = updated as FieldDefinition & { valueType: "number" }
    if (patch.min !== undefined) numField.min = patch.min
    if (patch.max !== undefined) numField.max = patch.max
  }

  return { ok: true, value: updated }
}
