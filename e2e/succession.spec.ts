import { expect, test, type Browser, type Page } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

async function inviteEditor(host: Page, guest: Page) {
  await host.getByRole("button", { name: "Sync", exact: true }).click()
  const hostDialog = host.getByRole("dialog", { name: "Device sync" })
  await hostDialog.getByRole("button", { name: "Add someone" }).click()
  await hostDialog.getByRole("button", { name: "Generate link" }).click()
  await guest.goto(await hostDialog.getByLabel("Pairing link").inputValue())
  const guestDialog = guest.getByRole("dialog", { name: "Device sync" })
  await guestDialog.getByRole("button", { name: "Accept and join" }).click()
  await hostDialog.getByLabel("Participant role").selectOption("editor")
  await hostDialog.getByRole("button", { name: "Approve access" }).click()
  await expect(guestDialog.getByText(/Connected to/)).toBeVisible({ timeout: 30_000 })
  await guestDialog.getByRole("button", { name: "Close", exact: true }).first().click()
  await hostDialog.getByRole("button", { name: "Close", exact: true }).first().click()
}

async function selectMember(dialog: ReturnType<Page["getByRole"]>, text: string) {
  const member = dialog.getByRole("list", { name: "Mesh members" }).getByRole("button").filter({ hasText: text }).first()
  await expect(member).toBeVisible({ timeout: 30_000 })
  await member.click()
}

async function addLead(page: Page, company: string) {
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  await page.getByLabel("Company *").fill(company)
  await page.getByLabel("Role *").fill("Engineer")
  await page.getByRole("button", { name: "Create item" }).click()
  await page.getByRole("button", { name: "Close detail" }).click()
}

test("Given an owner names an editor successor, when the editor claims succession, then every peer accepts the new owner", async ({ page, browser }) => {
  test.setTimeout(150_000)
  const context = await browser.newContext()
  const successor = await context.newPage()
  const ownerContext = page.context()
  try {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    await successor.goto("/")
    await inviteEditor(page, successor)

    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const ownerDialog = page.getByRole("dialog", { name: "Device sync" })
    await selectMember(ownerDialog, "editor")
    await ownerDialog.getByRole("tab", { name: "Participants", exact: true }).click()
    await ownerDialog.getByRole("tab", { name: "Advanced", exact: true }).click()
    await ownerDialog.getByRole("button", { name: "Name successor" }).click()
    await expect(ownerDialog.getByText(/Named successor:/)).toBeVisible()

    await successor.getByRole("button", { name: "Sync", exact: true }).click()
    const successorDialog = successor.getByRole("dialog", { name: "Device sync" })
    await successorDialog.getByRole("tab", { name: "Participants", exact: true }).click()
    await successorDialog.getByRole("tab", { name: "Advanced", exact: true }).click()
    await expect(successorDialog.getByRole("button", { name: "Claim ownership" })).toBeVisible({ timeout: 30_000 })
    await page.close()
    await successorDialog.getByRole("button", { name: "Claim ownership" }).click()
    await expect(successor.getByLabel("Workspace role: owner")).toBeVisible({ timeout: 15_000 })
    const returningOwner = await ownerContext.newPage()
    await returningOwner.goto("/")
    await expect(returningOwner.getByLabel("Workspace role: editor")).toBeVisible({ timeout: 40_000 })
  } finally { await context.close() }
})

test("Given editor quorum recovery, when a majority votes, then one vote stays pending and quorum elects the candidate", async ({ page, browser }) => {
  test.setTimeout(180_000)
  const firstContext = await browser.newContext()
  const secondContext = await browser.newContext()
  const first = await firstContext.newPage()
  const second = await secondContext.newPage()
  const ownerContext = page.context()
  try {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    await Promise.all([first.goto("/"), second.goto("/")])
    await inviteEditor(page, first)
    await inviteEditor(page, second)

    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const ownerDialog = page.getByRole("dialog", { name: "Device sync" })
    await ownerDialog.getByRole("tab", { name: "Participants", exact: true }).click()
    await ownerDialog.getByRole("tab", { name: "Advanced", exact: true }).click()
    await ownerDialog.getByRole("button", { name: "Enable editor quorum" }).click()
    await expect(ownerDialog.getByText("Editor quorum: 2 of 2.")).toBeVisible()

    await first.getByRole("button", { name: "Sync", exact: true }).click()
    const firstDialog = first.getByRole("dialog", { name: "Device sync" })
    await firstDialog.getByRole("tab", { name: "Participants", exact: true }).click()
    await firstDialog.getByRole("tab", { name: "Advanced", exact: true }).click()
    await expect(firstDialog.getByText("Editor quorum: 2 of 2.")).toBeVisible({ timeout: 30_000 })
    await second.getByRole("button", { name: "Sync", exact: true }).click()
    const secondDialog = second.getByRole("dialog", { name: "Device sync" })
    await secondDialog.getByRole("tab", { name: "Participants", exact: true }).click()
    await secondDialog.getByRole("tab", { name: "Advanced", exact: true }).click()
    await expect(secondDialog.getByText("Editor quorum: 2 of 2.")).toBeVisible({ timeout: 30_000 })
    for (const dialog of [firstDialog, secondDialog]) {
      await dialog.getByRole("tab", { name: "Participants", exact: true }).click()
      const otherEditor = dialog.getByRole("list", { name: "Mesh members" }).getByRole("button")
        .filter({ hasText: "editor", hasNotText: "You" }).first()
      await expect(otherEditor).toBeVisible({ timeout: 30_000 })
      await otherEditor.click()
      await expect(dialog.getByLabel("Selected mesh member").getByText("Connected to this tab")).toBeVisible({ timeout: 30_000 })
    }
    await page.close()

    await selectMember(firstDialog, "You")
    await firstDialog.getByRole("tab", { name: "Participants", exact: true }).click()
    await firstDialog.getByRole("tab", { name: "Advanced", exact: true }).click()
    await firstDialog.getByRole("button", { name: "Vote for yourself" }).click()
    await expect(firstDialog.getByRole("button", { name: "Claim ownership" })).toHaveCount(0)
    await expect(firstDialog.getByText(/^Vote recorded for /)).toBeVisible()
    await expect(firstDialog.getByRole("button", { name: /^Vote for / })).toHaveCount(0)

    const candidate = secondDialog.getByRole("list", { name: "Mesh members" }).getByRole("button")
      .filter({ hasText: "editor", hasNotText: "You" }).first()
    await expect(candidate).toBeVisible({ timeout: 30_000 })
    await candidate.click()
    await secondDialog.getByRole("tab", { name: "Participants", exact: true }).click()
    await secondDialog.getByRole("tab", { name: "Advanced", exact: true }).click()
    await secondDialog.getByRole("button", { name: /^Vote for / }).click()

    await expect(firstDialog.getByRole("button", { name: "Claim ownership" })).toBeVisible({ timeout: 30_000 })
    await firstDialog.getByRole("button", { name: "Claim ownership" }).click()
    await expect(first.getByLabel("Workspace role: owner")).toBeVisible({ timeout: 15_000 })
    const returningOwner = await ownerContext.newPage()
    await returningOwner.goto("/")
    await expect(returningOwner.getByLabel("Workspace role: editor")).toBeVisible({ timeout: 40_000 })
  } finally {
    await firstContext.close()
    await secondContext.close()
  }
})
