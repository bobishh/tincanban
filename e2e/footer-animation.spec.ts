import { expect, test } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

for (const unavailable of [false, true]) test(`Given workspace permissions ${unavailable ? "fail" : "load"}, when footer animation replays, then it completes without blocking controls`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto("/")
  if (unavailable) {
    await createJobSearchWorkspace(page, "Unavailable permissions")
    const workspaceId = await page.evaluate(async () => (await import("/src/state.ts")).useTincanban().activeWorkspace.id)
    await page.evaluate(async id => {
      const { STORE_AUTHORITY } = await import("/src/sync/peerStore.ts")
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("tincanban-peer-catalog-v1")
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const transaction = database.transaction(STORE_AUTHORITY, "readwrite")
      transaction.objectStore(STORE_AUTHORITY).put({ workspaceId: id, ownerPublicKey: "invalid-key" })
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error)
        transaction.onerror = () => reject(transaction.error)
      })
      database.close()
    }, workspaceId)
    await page.reload()
  }
  const replay = page.getByRole("button", { name: "Replay tower animation", exact: true })
  await expect(replay).toBeVisible()
  if (unavailable) await expect(page.getByRole("alert").filter({ hasText: "permissions could not be verified" })).toBeVisible()
  else await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  await replay.click()
  await page.getByRole("button", { name: "Open workspaces", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Workspaces", exact: true })).toBeVisible()
  const tower = page.locator("berlin-tower")
  await expect(tower.locator("[data-tower-ball]")).toBeAttached()
  await expect.poll(() => tower.evaluate(element => element.shadowRoot!.querySelector("svg")!
    .getAnimations({ subtree: true }).every(animation => animation.playState === "finished"))).toBe(true)
  if (unavailable) await expect(page.getByRole("button", { name: /Add item to/ })).toHaveCount(0)
})
