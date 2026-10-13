import { workspaceAuthorityIsInvalid } from "./sync/changeAuthorization"
import { defaultStorage } from "./storage"
import { stateRuntime } from "./stateContext"
import type { CausalReviewCallbacks } from "./stateCausalReview"

export async function refreshCausalReview(storage = defaultStorage, workspaceId = stateRuntime.activeDoc?.id): Promise<void> {
  if (stateRuntime.activeDoc && workspaceId !== stateRuntime.activeDoc.id) return
  if (!workspaceId) {
    stateRuntime.causalReview.value = []
    return
  }
  if (await workspaceAuthorityIsInvalid(workspaceId)) {
    await (await import("./stateCausalReview")).refreshCausalReview(storage, workspaceId)
    return
  }
  if (!await storage.hasUnresolvedCausalChanges(workspaceId)) {
    stateRuntime.causalReview.value = []
    stateRuntime.causalReviewError.value = ""
    return
  }
  const causalReview = await loadReviewAction()
  if (!causalReview) return
  await causalReview.refreshCausalReview(storage, workspaceId)
}

export async function loadReviewAction() {
  try { return await import("./stateCausalReview") }
  catch {
    stateRuntime.causalReviewError.value = "Workspace change review could not load. Reload to retry."
    return null
  }
}

export type { CausalReviewCallbacks }
