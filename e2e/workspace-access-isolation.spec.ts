import { expect, test } from "./support/coverage"
import { faviconRole } from "./support/favicon"
import { createJobSearchWorkspace } from "./support/workspaces"

test("Given an unreadable authority on one board, when creating and importing another board, then its owner access survives", async ({ page }) => {
  await page.goto("/")
  await createJobSearchWorkspace(page, "Broken authority")
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  const brokenWorkspaceId = await page.evaluate(async () => (await import("/src/state.ts")).useTincanban().activeWorkspace.id)
  await createJobSearchWorkspace(page, "Healthy sibling")
  await page.evaluate(async workspaceId => {
    const { peerStore } = await import("/src/sync/peerStore.ts")
    const authority = await peerStore.getWorkspaceAuthority(workspaceId)
    if (!authority) throw new Error("Missing workspace authority")
    // A broken board must not block a different active board after reload.
    await peerStore.putWorkspaceAuthority({ ...authority, ownerPublicKey: "invalid-key",
      updatedAt: new Date(Date.parse(authority.updatedAt) + 1_000).toISOString(),
    })
    const stored = await peerStore.getWorkspaceAuthority(workspaceId)
    if (stored?.ownerPublicKey !== "invalid-key") throw new Error("Malformed authority was not stored")
  }, brokenWorkspaceId)
  await page.reload()
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  await expect(page.getByRole("button", { name: /Add lead to/ }).first()).toBeVisible()
  await expect.poll(() => faviconRole(page)).toEqual({ role: "owner", body: "#d5b16d" })
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const sync = page.getByRole("dialog", { name: "Device sync" })
  await sync.getByRole("tab", { name: "Backups", exact: true }).click()
  const downloadEvent = page.waitForEvent("download")
  await sync.getByRole("button", { name: "Export .tincanban", exact: true }).click()
  const bundle = await (await downloadEvent).path()
  await sync.getByRole("button", { name: "Close", exact: true }).first().click()
  await page.getByRole("button", { name: "Open workspaces", exact: true }).click()
  const workspaces = page.getByRole("dialog", { name: "Workspaces", exact: true })
  const chooserEvent = page.waitForEvent("filechooser")
  await workspaces.getByRole("button", { name: "Import as new board", exact: true }).click()
  await (await chooserEvent).setFiles(bundle!)
  await expect(workspaces).toBeHidden()
  await expect(page.getByRole("status").filter({ hasText: "Imported as a new board" })).toBeVisible()
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  await page.reload()
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
})
