import { canonicalizeJson, sha256Base64Url } from "../domain/identity"
import type { ApplicationReviewResponse, ApplicationReviewOption } from "../domain/applicationReviewData"
import { assertApplicationSourceRecord, type ApplicationSourceData } from "../domain/applicationSourceData"
import type { AutomationDefinition } from "../domain/automationContract"
import { hasEntityKind, isItem, type WorkspaceDocumentV2 } from "../domain/model"
import { getAncestryPath } from "../domain/ancestry"
import { isItemArchived, itemWorkflow, workflowColumnId, type ItemWorkflow } from "../domain/archive"

/** Validate the retained original against current local state; editable labels never identify an application. */
export async function validateApplicationReviewSelection(reviewValue: ApplicationReviewResponse, optionValue: ApplicationReviewOption,
  doc: WorkspaceDocumentV2, definitionValue: AutomationDefinition): Promise<{ source: ApplicationSourceData; workflow: ItemWorkflow }> {
  const review = structuredClone(reviewValue), option = structuredClone(optionValue), definition = structuredClone(definitionValue)
  assertReviewApproval(review, doc, definition)
  if (!review.options.some(value => canonicalizeJson(value) === canonicalizeJson(option)) ||
    !option.sourceRecordId || !option.sourceHash || !option.workflow) throw new Error("Choose original evidence from the current review page")
  const entity = doc.entities[`application-source:${option.sourceRecordId}`]
  if (!hasEntityKind(entity, "application_source")) throw new Error("Original application evidence is missing")
  const encodedSource = entity.data
  const source = assertApplicationSourceRecord(entity, doc.entities, doc.id)
  if (source.recordId !== option.sourceRecordId || source.cardId !== option.cardId || source.observation.phase === "refresh" ||
    source.observation.status !== option.sourceStatus) throw new Error("Selected original evidence does not match the application")
  const assertWorkflow = () => {
    const item = doc.entities[option.cardId]
    const workflow = isItem(item) ? itemWorkflow(item) : undefined
    if (!isItem(item) || isItemArchived(item) || !workflow ||
      canonicalizeJson(workflow) !== canonicalizeJson(option.workflow) || workflowColumnId(doc.entities, item.id) !== workflow.columnId) {
      throw new Error("Application workflow changed; reload review")
    }
    const ancestry = getAncestryPath(doc.entities, item.id)
    const board = doc.entities[definition.scope.boardId], column = doc.entities[workflow.columnId]
    if (!hasEntityKind(board, "board") || board.archivedAt || !hasEntityKind(column, "column") || column.archivedAt ||
      !ancestry.path.includes(board.id) || ancestry.path.some(id => Boolean(doc.entities[id]?.archivedAt))) {
      throw new Error("Application board or column is unavailable")
    }
    return structuredClone(workflow)
  }
  assertWorkflow()
  const digest = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(source)))
  const latest = doc.entities[entity.id]
  if (digest !== option.sourceHash || !hasEntityKind(latest, "application_source") || latest.data !== encodedSource) {
    throw new Error("Original application evidence changed")
  }
  return { source, workflow: assertWorkflow() }
}

function assertReviewApproval(review: ApplicationReviewResponse, doc: WorkspaceDocumentV2, definition: AutomationDefinition) {
  if (review.workspaceId !== doc.id || definition.scope.workspaceId !== doc.id || review.definitionId !== definition.id ||
    review.grantId !== definition.scope.grantId || !review.decisionHash || review.automationState !== "active" ||
    !definition.parameters.sources.includes("email")) throw new Error("Application review approval or decision changed")
}
