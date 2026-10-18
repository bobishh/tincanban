import { describe, expect, it } from "vitest"
import {
  validateFieldValue,
  validateItemValues,
  resolveSelectDisplay,
  patchFieldDefinition,
} from "./fields"
import type { FieldDefinition } from "./model"

describe("Field validation and lifecycle (Requirement 1.5)", () => {
  const baseField = {
    id: "f_text",
    kind: "field" as const,
    title: "Notes",
    placement: { parentId: "b_1", rank: "0/1" },
    archivedAt: null,
    createdAt: "2026-09-09T00:00:00Z",
    updatedAt: "2026-09-09T00:00:00Z",
  }

  it("validates text, url, date, boolean, number with bounds", () => {
    const urlField: FieldDefinition = { ...baseField, id: "f_url", required: true, valueType: "url" }
    expect(validateFieldValue(urlField, "https://example.com").valid).toBe(true)
    expect(validateFieldValue(urlField, "http://localhost:3000").valid).toBe(true)
    expect(validateFieldValue(urlField, "ftp://example.com").valid).toBe(false)
    expect(validateFieldValue(urlField, "not-a-url").valid).toBe(false)
    expect(validateFieldValue(urlField, null).valid).toBe(false) // required

    const dateField: FieldDefinition = { ...baseField, id: "f_date", required: false, valueType: "date" }
    expect(validateFieldValue(dateField, "2026-09-09").valid).toBe(true)
    expect(validateFieldValue(dateField, "09-09-2026").valid).toBe(false)
    expect(validateFieldValue(dateField, null).valid).toBe(true) // optional

    const dateTimeField: FieldDefinition = { ...baseField, id: "f_datetime", required: false, valueType: "datetime" }
    expect(validateFieldValue(dateTimeField, "2026-09-09T14:30").valid).toBe(true)
    expect(validateFieldValue(dateTimeField, "2026-09-09T14:30:00").valid).toBe(true)
    expect(validateFieldValue(dateTimeField, "2026-09-09T14:30:00Z").valid).toBe(true)
    expect(validateFieldValue(dateTimeField, "2026-09-09T14:30:00+02:00").valid).toBe(true)
    expect(validateFieldValue(dateTimeField, "2026-09-09T14:30:00.123Z").valid).toBe(true)
    expect(validateFieldValue(dateTimeField, "2026-09-09").valid).toBe(false) // date only without time
    expect(validateFieldValue(dateTimeField, "2026-09-09 14:30").valid).toBe(false) // missing T
    expect(validateFieldValue(dateTimeField, "not-a-datetime").valid).toBe(false)
    expect(validateFieldValue(dateTimeField, "2026-13-45T99:99").valid).toBe(false) // invalid values
    expect(validateFieldValue(dateTimeField, null).valid).toBe(true) // optional

    const reqDateTimeField: FieldDefinition = { ...baseField, id: "f_req_datetime", required: true, valueType: "datetime" }
    expect(validateFieldValue(reqDateTimeField, null).valid).toBe(false) // required
    expect(validateFieldValue(reqDateTimeField, "").valid).toBe(false) // required
    expect(validateFieldValue(reqDateTimeField, "2026-09-09T14:30").valid).toBe(true)

    const numField: FieldDefinition = { ...baseField, id: "f_num", required: false, valueType: "number", min: 0, max: 10 }
    expect(validateFieldValue(numField, 5).valid).toBe(true)
    expect(validateFieldValue(numField, 0).valid).toBe(true)
    expect(validateFieldValue(numField, 10).valid).toBe(true)
    expect(validateFieldValue(numField, -1).valid).toBe(false)
    expect(validateFieldValue(numField, 11).valid).toBe(false)
    expect(validateFieldValue(numField, Infinity).valid).toBe(false)

    const boolField: FieldDefinition = { ...baseField, id: "f_bool", required: false, valueType: "boolean" }
    expect(validateFieldValue(boolField, true).valid).toBe(true)
    expect(validateFieldValue(boolField, false).valid).toBe(true)
    expect(validateFieldValue(boolField, "true").valid).toBe(false)
  })

  it("validates select options by ID (not label) and handles option lifecycle", () => {
    const selectField: FieldDefinition = {
      ...baseField,
      id: "f_select",
      required: true,
      valueType: "select",
      options: {
        opt_remote: { id: "opt_remote", title: "Remote", rank: "0/1", archivedAt: null },
        opt_onsite: { id: "opt_onsite", title: "Onsite", rank: "1/1", archivedAt: null },
        opt_deprecated: { id: "opt_deprecated", title: "Deprecated", rank: "2/1", archivedAt: "2026-01-01T00:00:00.000Z" },
      },
    }

    // Valid option ID
    expect(validateFieldValue(selectField, "opt_remote").valid).toBe(true)

    // Option label instead of ID must fail
    expect(validateFieldValue(selectField, "Remote").valid).toBe(false)

    // Newly selecting a soft-archived option fails
    expect(validateFieldValue(selectField, "opt_deprecated").valid).toBe(false)

    // Display helper resolves label and indicates unavailable if archived
    const activeDisplay = resolveSelectDisplay(selectField, "opt_remote")
    expect(activeDisplay).toEqual({ label: "Remote", unavailable: false })

    const archivedDisplay = resolveSelectDisplay(selectField, "opt_deprecated")
    expect(archivedDisplay).toEqual({ label: "Deprecated", unavailable: true })

    const unknownDisplay = resolveSelectDisplay(selectField, "opt_missing")
    expect(unknownDisplay).toEqual({ label: "Unknown (opt_missing)", unavailable: true })
  })

  it("ensures soft-archived required fields stop blocking item edits but preserve values", () => {
    const reqField: FieldDefinition = {
      ...baseField,
      id: "f_req",
      required: true,
      valueType: "text",
      archivedAt: null,
    }

    // Initially fails when missing
    const res1 = validateItemValues([reqField], {})
    expect(res1.ok).toBe(false)

    // Once field is soft-archived, required validation stops blocking
    const archivedReqField: FieldDefinition = { ...reqField, archivedAt: "2026-01-01T00:00:00.000Z" }
    const res2 = validateItemValues([archivedReqField], {})
    expect(res2.ok).toBe(true)

    // But if a value was previously stored, it is still valid and preserved
    const res3 = validateItemValues([archivedReqField], { f_req: "Preserved Value" })
    expect(res3.ok).toBe(true)
  })

  it("rejects field type changes non-destructively", () => {
    const field: FieldDefinition = {
      ...baseField,
      id: "f_text",
      required: false,
      valueType: "text",
    }

    // Attempting to change valueType to number
    const result = patchFieldDefinition(field, { valueType: "number" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("field_type_change")
    }

    // Original field remains intact
    expect(field.valueType).toBe("text")

    // Renaming title or changing required is allowed
    const validPatch = patchFieldDefinition(field, { title: "Updated Notes", required: true })
    expect(validPatch.ok).toBe(true)
    if (validPatch.ok) {
      expect(validPatch.value.title).toBe("Updated Notes")
      expect(validPatch.value.required).toBe(true)
      expect(validPatch.value.valueType).toBe("text")
    }
  })
})
