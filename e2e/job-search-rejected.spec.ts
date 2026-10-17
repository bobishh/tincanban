import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

test.describe("Job Search Rejected Column & Retrospective Notes (Gate F)", () => {
  test("Given a Job search board with a lead, when moved to Rejected and a retrospective note is added, it persists across reload", async ({ page }) => {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)

    // Verify Job search board has the Rejected column visible
    await expect(page.getByRole("region", { name: "Job search" })).toBeVisible()
    const rejectedColumn = page.getByRole("region", { name: "Rejected" })
    await expect(rejectedColumn).toBeVisible()

    // 1. Create a lead card in "lead" column
    await page.getByRole("button", { name: /Add lead to/ }).first().click()
    const leadForm = page.getByRole("dialog", { name: "Add item" })
    await leadForm.getByLabel("Company *").fill("Acme Robotics")
    await leadForm.getByLabel("Role *").fill("Autonomy Lead")
    await page.getByRole("button", { name: "Create item" }).click()

    // Creation automatically opens the detail dialog
    const detailDialog = page.getByRole("dialog", { name: "Item overview" })
    await expect(detailDialog).toBeVisible()

    // 2. Move status to "Rejected" via status strip
    const rejectedStatusBtn = detailDialog.getByRole("button", { name: "Rejected" })
    await rejectedStatusBtn.click()

    // 3. Fill in retrospective note
    const retrospectiveInput = detailDialog.getByLabel("Rejection notes")
    await expect(retrospectiveInput).toBeVisible()
    await retrospectiveInput.fill("Role closed unexpectedly due to hiring freeze. Interviewer feedback praised distributed systems experience.")

    // 4. Close detail
    await page.getByRole("button", { name: "Close detail" }).click()
    await expect(detailDialog).toHaveCount(0)

    // 5. Verify card is in the Rejected column
    await expect(rejectedColumn.getByText("Acme Robotics")).toBeVisible()

    // 6. Reload page to verify persistence in IndexedDB and Automerge
    await page.reload()
    await expect(page.getByRole("region", { name: "Job search" })).toBeVisible()
    const reloadedRejectedCol = page.getByRole("region", { name: "Rejected" })
    await expect(reloadedRejectedCol.getByText("Acme Robotics")).toBeVisible()

    // 7. Re-open detail and verify retrospective note is retained
    await reloadedRejectedCol.getByRole("button", { name: "Open Acme Robotics — Autonomy Lead" }).click()
    const reloadedDetail = page.getByRole("dialog", { name: "Item overview" })
    await expect(reloadedDetail.getByLabel("Rejection notes")).toHaveValue(
      "Role closed unexpectedly due to hiring freeze. Interviewer feedback praised distributed systems experience."
    )
    await page.getByRole("button", { name: "Close detail" }).click()
  })

  test("Given a lead created directly in Rejected status, optional rejection reason is saved upon creation", async ({ page }) => {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)

    await page.getByRole("button", { name: /Add lead to/ }).first().click()
    const leadForm = page.getByRole("dialog", { name: "Add item" })
    await leadForm.getByLabel("Company *").fill("Cyberdyne")
    await leadForm.getByLabel("Role *").fill("Security Engineer")
    await leadForm.getByLabel("Status").selectOption("rejected")

    // The rejection note field appears on the creation form when status is rejected
    const reasonField = leadForm.getByLabel("Rejection notes / retrospective")
    await expect(reasonField).toBeVisible()
    await reasonField.fill("Position required 100% on-site in Tokyo; mismatch on remote preference.")

    await page.getByRole("button", { name: "Create item" }).click()

    // Close automatically opened detail dialog
    await page.getByRole("button", { name: "Close detail" }).click()

    const rejectedColumn = page.getByRole("region", { name: "Rejected" })
    await expect(rejectedColumn.getByText("Cyberdyne")).toBeVisible()

    // Verify after reload
    await page.reload()
    const reloadedCard = page.getByRole("button", { name: "Open Cyberdyne — Security Engineer" })
    await reloadedCard.click()
    const detailDialog = page.getByRole("dialog", { name: "Item overview" })
    await expect(detailDialog.getByLabel("Rejection notes")).toHaveValue(
      "Position required 100% on-site in Tokyo; mismatch on remote preference."
    )
  })
})
