import type { Page } from "@playwright/test"

// Exercise the signed automation channel independently of workspace settings.
// Callers synchronize workspace evidence before invoking this helper.
export async function reviewRetainedEmail(page: Page, eventId: string, cardId?: string) {
  return page.evaluate(async ({ eventId, cardId }) => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    const { createApplicationReviewManagement } = await import("/src/app/applicationReviewManagement.ts")
    const { parseAutomationDefinition } = await import("/src/domain/automationContract.ts")
    const workspace = useTincanban()
    const entity = Object.values(workspace.getActiveDoc()!.entities).find(value => value.kind === "automation")
    if (entity?.kind !== "automation") throw new Error("Automation unavailable")
    const review = createApplicationReviewManagement({ getActiveDoc: () => workspace.getActiveDoc(),
      getCurrentProfile: () => workspace.getCurrentProfile(), owner: () => true,
      syncNow: async () => {}, changed: async () => {} })
    try {
      await review.open({ entity, definition: parseAutomationDefinition(JSON.parse(entity.definition)) }, eventId)
      if (review.failure.value) throw new Error(review.failure.value)
      if (cardId) {
        const candidate = review.review.value?.options.find(value => value.cardId === cardId)
        if (!candidate) throw new Error("Application candidate unavailable")
        review.select(candidate)
        await review.save()
      } else await review.retry()
      if (review.failure.value) throw new Error(review.failure.value)
      return { saved: review.saved.value, status: review.review.value?.status }
    } finally { review.close() }
  }, { eventId, cardId })
}
