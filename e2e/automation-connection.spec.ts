import { expect, test } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

test("Given an existing owned board, when a Reflux connection lookup fails then retry preserves its intent, consent shows its scope and decline leaves the board unchanged", async ({ page }) => {
  await page.goto("/")
  await createJobSearchWorkspace(page, "Existing automation board")
  const before = await page.evaluate(async () => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    const state = useTincanban()
    return { owner: state.getCurrentProfile()!.identity.personId, workspaceId: state.getActiveDoc()!.id }
  })
  const id = "ae160d39-4cb8-4f0d-8e7c-5fa0e5bac2f5"
  const expires = Date.now() + 60_000
  const returnTo = `https://reflux.example/workflows/job-search-automation?automation_connection=${id}`
  let lookups = 0
  await page.route("https://reflux.example/**", async route => {
    if (route.request().url().includes("/resolve")) {
      if (++lookups === 1) return route.fulfill({ status: 503, json: { error: "Connection temporarily unavailable" } })
      return route.fulfill({ json: { integrationId: id,
      automationOrigin: "https://reflux.example", workflowSlug: "job-search-automation", workflowTitle: "Job search automation",
      ownerPersonId: before.owner, expiresAt: expires, returnTo,
      configuration: { name: "Job search", type: "job-intake", typeVersion: 2, parameters: { sources: ["website", "email"] } } } })
    }
    if (route.request().url().includes("/denial")) return route.fulfill({ json: { state: "denied" } })
    return route.fulfill({ contentType: "text/html", body: "<h1>Workflow unchanged</h1>" })
  })
  const request = { kind: "mesh-reflux-automation-request", version: 1, reflux_origin: "https://reflux.example",
    workflow_slug: "job-search-automation", intent_id: id, owner_person_id: before.owner, expires_at: expires,
    handoff_code: "a".repeat(43), return_to: returnTo }
  await page.goto(`/automation/connect#request=${Buffer.from(JSON.stringify(request)).toString("base64url")}`)
  const approval = page.getByRole("dialog", { name: "Connect automation", exact: true })
  await expect(approval.getByRole("alert")).toContainText("Connection temporarily unavailable")
  await approval.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(approval).toContainText("Job search automation")
  await expect(approval).toContainText("Entire workspace, including its documents")
  await expect(approval).toContainText("Sources: website, email")
  await expect(approval.getByLabel("Board", { exact: true })).toHaveValue(before.workspaceId)
  expect(page.url()).not.toContain("request=")
  await approval.getByRole("button", { name: "Decline", exact: true }).click()
  await expect(page).toHaveURL(returnTo)
  await page.goto("/")
  await expect(page.getByRole("region", { name: "Existing automation board", exact: true })).toBeVisible()
})
