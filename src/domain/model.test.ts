import { describe, expect, it } from "vitest"
import {
  validateWorkspaceDoc,
  validateEntity,
  validatePlacementParent,
  isValidRank,
  type WorkspaceDocumentV2,
  type Board,
  type Column,
  type Item,
  type FieldDefinition,
  type AttachedDocument,
  type DocumentTemplate,
  type PdfArtifact,
} from "./model"

describe("model runtime types and validators (Requirement 1.1)", () => {
  const validPlacement = { parentId: null, rank: "0/1" }

  it("validates Board structure and retains opaque JSON metadata", () => {
    const validBoard: Board = {
      id: "board_1",
      kind: "board",
      title: "My Board",
      placement: validPlacement,
      archivedAt: null,
      createdAt: "2026-09-09T10:00:00.000Z",
      updatedAt: "2026-09-09T10:00:00.000Z",
      preset: {
        key: "blank",
        version: 1,
        bindings: {},
      },
    }

    expect(validateEntity(validBoard).ok).toBe(true)

    const withUnknown = { ...validBoard, extraKey: "not_allowed" }
    const result = validateEntity(withUnknown)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_input")
      expect(result.error.message).toContain("extraKey")
    }
  })

  it("validates Column archive role", () => {
    const validColumn: Column = {
      id: "col_1",
      kind: "column",
      title: "To do",
      placement: { parentId: "board_1", rank: "0/1" },
      archivedAt: null,
      createdAt: "2026-09-09T10:00:00.000Z",
      updatedAt: "2026-09-09T10:00:00.000Z",
    }

    expect(validateEntity(validColumn).ok).toBe(true)

    expect(validateEntity({ ...validColumn, archive: true }).ok).toBe(true)
    expect(validateEntity({ ...validColumn, archive: false }).ok).toBe(false)
  })

  it("validates Item entity and custom values map", () => {
    const validItem: Item = {
      id: "item_1",
      title: "Item 1",
      body: "Body text",
      placement: { parentId: "col_1", rank: "0/1" },
      archivedAt: null,
      createdAt: "2026-09-09T10:00:00.000Z",
      updatedAt: "2026-09-09T10:00:00.000Z",
      values: {
        field_author: "Alice",
        field_count: 5,
        field_active: true,
        field_cleared: null,
      },
    }

    expect(validateEntity(validItem).ok).toBe(true)

    // Values must be scalar or null, not arbitrary objects
    const invalidValues = {
      ...validItem,
      values: { field_bad: { complex: "object" } },
    }
    expect(validateEntity(invalidValues).ok).toBe(false)
  })

  it("validates all FieldDefinition types and option constraints", () => {
    const textField: FieldDefinition = {
      id: "field_text",
      kind: "field",
      title: "Text field",
      placement: { parentId: "board_1", rank: "0/1" },
      archivedAt: null,
      createdAt: "2026-09-09T10:00:00.000Z",
      updatedAt: "2026-09-09T10:00:00.000Z",
      required: false,
      valueType: "text",
    }
    expect(validateEntity(textField).ok).toBe(true)

    const numberField: FieldDefinition = {
      id: "field_num",
      kind: "field",
      title: "Score",
      placement: { parentId: "board_1", rank: "1/1" },
      archivedAt: null,
      createdAt: "2026-09-09T10:00:00.000Z",
      updatedAt: "2026-09-09T10:00:00.000Z",
      required: true,
      valueType: "number",
      min: 0,
      max: 10,
    }
    expect(validateEntity(numberField).ok).toBe(true)

    const selectField: FieldDefinition = {
      id: "field_select",
      kind: "field",
      title: "Priority",
      placement: { parentId: "board_1", rank: "2/1" },
      archivedAt: null,
      createdAt: "2026-09-09T10:00:00.000Z",
      updatedAt: "2026-09-09T10:00:00.000Z",
      required: false,
      valueType: "select",
      options: {
        opt_1: { id: "opt_1", title: "High", rank: "0/1", archivedAt: null },
        opt_2: { id: "opt_2", title: "Low", rank: "1/1", archivedAt: null },
      },
    }
    expect(validateEntity(selectField).ok).toBe(true)

    const datetimeField: FieldDefinition = {
      id: "field_datetime",
      kind: "field",
      title: "Due Date & Time",
      placement: { parentId: "board_1", rank: "3/1" },
      archivedAt: null,
      createdAt: "2026-09-09T10:00:00.000Z",
      updatedAt: "2026-09-09T10:00:00.000Z",
      required: false,
      valueType: "datetime",
    }
    expect(validateEntity(datetimeField).ok).toBe(true)

    const invalidNumberField = { ...numberField, min: "invalid" }
    expect(validateEntity(invalidNumberField).ok).toBe(false)
  })

  it("validates AttachedDocument, DocumentTemplate, and PdfArtifact", () => {
    const doc: AttachedDocument = {
      id: "doc_1",
      kind: "document",
      title: "Notes",
      placement: { parentId: "item_1", rank: "0/1" },
      archivedAt: null,
      createdAt: "2026-09-09T10:00:00.000Z",
      updatedAt: "2026-09-09T10:00:00.000Z",
      documentKind: "note",
      format: "markdown",
      content: "Important note",
      file: null,
    }
    expect(validateEntity(doc).ok).toBe(true)

    const tpl: DocumentTemplate = {
      id: "tpl_1",
      kind: "document_template",
      title: "Standard CV",
      placement: { parentId: null, rank: "0/1" },
      archivedAt: null,
      createdAt: "2026-09-09T10:00:00.000Z",
      updatedAt: "2026-09-09T10:00:00.000Z",
      markdown: "# CV",
    }
    expect(validateEntity(tpl).ok).toBe(true)

    const art: PdfArtifact = {
      id: "art_1",
      kind: "artifact",
      title: "CV.pdf",
      placement: { parentId: "item_1", rank: "0/1" },
      archivedAt: null,
      createdAt: "2026-09-09T10:00:00.000Z",
      updatedAt: "2026-09-09T10:00:00.000Z",
      artifactKind: "cv",
      templateId: "tpl_1",
      pdf: {
        type: "blob",
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        byteLength: 1024,
        mimeType: "application/pdf",
        fileName: "cv.pdf",
      },
      sourceMarkdown: null,
    }
    expect(validateEntity(art).ok).toBe(true)
  })

  it("validates allowed and invalid parent kinds according to design table", () => {
    // board -> null
    expect(validatePlacementParent("board", null).ok).toBe(true)
    expect(validatePlacementParent("board", "some_parent").ok).toBe(false)

    // column -> board
    expect(validatePlacementParent("column", "board").ok).toBe(true)
    expect(validatePlacementParent("column", "column").ok).toBe(false)
    expect(validatePlacementParent("column", null).ok).toBe(false)

    // item -> column or item
    expect(validatePlacementParent("item", "column").ok).toBe(true)
    expect(validatePlacementParent("item", "item").ok).toBe(true)
    expect(validatePlacementParent("item", "board").ok).toBe(false)
    expect(validatePlacementParent("item", null).ok).toBe(false)

    // field -> board
    expect(validatePlacementParent("field", "board").ok).toBe(true)
    expect(validatePlacementParent("field", "column").ok).toBe(false)

    // document -> item
    expect(validatePlacementParent("document", "item").ok).toBe(true)
    expect(validatePlacementParent("document", "column").ok).toBe(false)

    // template -> null
    expect(validatePlacementParent("template", null).ok).toBe(true)
    expect(validatePlacementParent("template", "board").ok).toBe(false)

    // artifact -> item
    expect(validatePlacementParent("artifact", "item").ok).toBe(true)
    expect(validatePlacementParent("artifact", "board").ok).toBe(false)
  })

  it("validates canonical reduced rational ranks", () => {
    expect(isValidRank("0/1")).toBe(true)
    expect(isValidRank("1/1")).toBe(true)
    expect(isValidRank("-1/2")).toBe(true)
    expect(isValidRank("3/4")).toBe(true)

    // Not reduced or invalid denominator
    expect(isValidRank("2/4")).toBe(false)
    expect(isValidRank("1/-2")).toBe(false)
    expect(isValidRank("1/0")).toBe(false)
    expect(isValidRank("abc")).toBe(false)
    expect(isValidRank("1.5")).toBe(false)
  })

  it("validates complete WorkspaceDocumentV2 and rejects unsupported formatVersion", () => {
    const validDoc: WorkspaceDocumentV2 = {
      kind: "workspace",
      formatVersion: 3,
      id: "ws_1",
      title: "Primary Workspace",
      archivedAt: null,
      ownerPersonId: "person_1",
      entities: {},
      migration: null,
    }

    expect(validateWorkspaceDoc(validDoc).ok).toBe(true)

    const unsupportedVersion = { ...validDoc, formatVersion: 4 }
    const result = validateWorkspaceDoc(unsupportedVersion)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("unsupported_format")
    }
  })
})
