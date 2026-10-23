import { expect, test } from "./support/coverage"

test.use({ trace: "off", video: "off", screenshot: "off" })

const identityOrigin = process.env.IDENTITY_E2E_ORIGIN
test.skip(!identityOrigin, "Set IDENTITY_E2E_ORIGIN to a running Identity portal preview")

function safeDiagnostic(value: string): string {
  return value.replace(/https?:\/\/\S+/gu, "<url>")
    .replace(/\b[a-f0-9]{32,}\b/giu, "<identifier>")
    .replace(/(?:\b[a-z]{3,}\b\s+){11,23}\b[a-z]{3,}\b/giu, "<recovery-words>").slice(0, 200)
}

test("Given local identity P and board, when replacing P with portal identity Q, then P's board rights do not transfer", async ({ browser, page }) => {
  test.setTimeout(120_000)
  const portalContext = await browser.newContext({ acceptDownloads: true })
  const portal = await portalContext.newPage()
  const appUrl = process.env.TINCANBAN_E2E_ORIGIN ?? "http://127.0.0.1:4244"

  async function createPortalIdentity() {
    await portal.goto(identityOrigin!)
    await portal.getByRole("button", { name: "Create identity", exact: true }).click()
    await portal.locator('#create-form input[name="displayName"]').fill("Portal Sign-in Q")
    await portal.locator("#create-form").getByRole("button", { name: "Create identity", exact: true }).click()
    await portal.getByRole("heading", { name: "Save your recovery" }).waitFor()
    const downloadEvent = portal.waitForEvent("download")
    await portal.getByRole("button", { name: "Download encrypted identity file", exact: true }).click()
    const download = await downloadEvent
    expect(download.suggestedFilename()).toMatch(/\.identity\.json$/u)
    await portal.locator('input[name="saved-words"]').check()
    await portal.getByRole("button", { name: "Continue to identity", exact: true }).click()
    await portal.getByRole("heading", { name: "Portal Sign-in Q" }).waitFor()
    return (await portal.locator(".identity-id-badge").getAttribute("data-identity-id")) ?? ""
  }

  async function issueInvite() {
    await portal.getByRole("tab", { name: "Devices", exact: true }).click()
    await portal.getByRole("button", { name: "Add a device", exact: true }).click()
    const invitation = portal.locator(".identity-invite-url")
    await invitation.waitFor()
    const value = (await invitation.textContent())?.trim() ?? ""
    expect(value).toContain("#")
    return value
  }

  async function openAddDevice(invite: string) {
    await page.getByRole("button", { name: "Identity", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Identity profile", exact: true })
    await dialog.getByRole("button", { name: "Add another device", exact: true }).click()
    await dialog.getByLabel("Identity invitation").fill(invite)
    const samePerson = dialog.locator('input[name="replace-same-person"]')
    if (await samePerson.count()) await samePerson.check()
    const recovery = dialog.getByLabel(/Allow an optional full-Identity recovery transfer/)
    expect(await recovery.isChecked()).toBe(false)
    await dialog.getByRole("button", { name: "Connect this device", exact: true }).click()
    return dialog
  }

  async function approveWithoutRecovery() {
    await portal.getByRole("heading", { name: "Review device request" }).waitFor()
    const transfer = portal.locator('input[name="recovery-transfer"]')
    await expect(transfer).toHaveCount(1)
    expect(await transfer.isChecked()).toBe(false)
    await portal.getByRole("button", { name: "Approve device", exact: true }).click()
  }

  async function localIdentity() {
    return page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("tincanban-local-state-v1")
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        const request = db.transaction("kv", "readonly").objectStore("kv").get("tincanban.local_profile.v1")
        const raw = await new Promise<unknown>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        if (typeof raw !== "string") throw new Error("Local profile record missing")
        const profile = JSON.parse(raw) as { identity: { personId: string }; privateKeys: { identityPrivateKey?: string } }
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))
        return { personId: profile.identity.personId,
          profileHash: btoa(String.fromCharCode(...new Uint8Array(digest))),
          identityRootKeyPresent: Boolean(profile.privateKeys.identityPrivateKey) }
      } finally { db.close() }
    })
  }

  async function boardStorageHash(workspaceId: string) {
    return page.evaluate(async id => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("tincanban-workspace-state")
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        const entries: Array<[string, string, string]> = []
        for (const name of [...db.objectStoreNames].sort()) {
          const transaction = db.transaction(name, "readonly")
          const store = transaction.objectStore(name)
          const [keys, values] = await Promise.all([
            new Promise<IDBValidKey[]>((resolve, reject) => {
              const request = store.getAllKeys()
              request.onsuccess = () => resolve(request.result)
              request.onerror = () => reject(request.error)
            }),
            new Promise<unknown[]>((resolve, reject) => {
              const request = store.getAll()
              request.onsuccess = () => resolve(request.result)
              request.onerror = () => reject(request.error)
            }),
          ])
          for (let index = 0; index < values.length; index++) {
            const key = keys[index]
            const serialized = JSON.stringify(values[index])
            if (String(key) !== id && !serialized?.includes(id)) continue
            const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized ?? "undefined"))
            entries.push([name, String(key), btoa(String.fromCharCode(...new Uint8Array(digest)))])
          }
          await new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => resolve()
            transaction.onerror = () => reject(transaction.error)
          })
        }
        const content = entries.filter(([name]) => name !== "revisions" && name !== "frontiers")
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(content)))
        return { count: content.length, hash: btoa(String.fromCharCode(...new Uint8Array(digest))) }
      } finally { db.close() }
    }, workspaceId)
  }

  async function createPrivateBoard() {
    await page.goto(appUrl)
    await page.getByRole("button", { name: "Open workspaces", exact: true }).waitFor({ state: "visible" })
    await page.getByRole("button", { name: "Open workspaces", exact: true }).click()
    await page.getByRole("button", { name: "New workspace", exact: true }).click()
    const create = page.getByRole("dialog", { name: "Create workspace" })
    await create.getByLabel("Title", { exact: true }).fill("Guest private board")
    await create.getByRole("button", { name: "Create", exact: true }).click()
    await page.getByRole("region", { name: "Guest private board", exact: true }).waitFor()
    await page.getByRole("button", { name: "Add item to To do", exact: true }).click()
    const item = page.getByRole("dialog", { name: "Item details" })
    await item.getByLabel("Title *").fill("Guest-only private card")
    await item.getByRole("button", { name: "Save item", exact: true }).click()
    await page.getByRole("button", { name: "Open Guest-only private card", exact: true }).waitFor()
    await page.getByRole("button", { name: "Open workspaces", exact: true }).click()
    const workspaceId = await page.locator("[data-workspace-id]").filter({ hasText: "Guest private board" })
      .getAttribute("data-workspace-id")
    expect(workspaceId).toBeTruthy()
    await page.getByRole("button", { name: "Open workspaces", exact: true }).click()
    return workspaceId!
  }

  async function replacementPrompt(qId: string) {
    const prompt = page.getByRole("region", { name: "Replace local Identity confirmation" })
    await prompt.waitFor()
    await expect(prompt.getByRole("heading", { name: "Join Portal Sign-in Q?" })).toBeVisible()
    await expect(prompt.locator("code")).toHaveText(qId)
    await expect(prompt.getByText("Guest private board", { exact: false })).toBeVisible()
    return prompt
  }

  try {
    const qId = await createPortalIdentity()
    expect(qId).not.toBe("")
    const workspaceId = await createPrivateBoard()
    const guestBefore = await localIdentity()
    expect(guestBefore.personId).not.toBe(qId)
    const boardBefore = await boardStorageHash(workspaceId)
    expect(boardBefore.count).toBeGreaterThan(0)

    const firstDialog = await openAddDevice(await issueInvite())
    await approveWithoutRecovery()
    const firstPrompt = await replacementPrompt(qId)
    await firstPrompt.getByRole("button", { name: "Keep current Identity", exact: true }).click()
    await expect(firstDialog.getByRole("status")).toHaveText("Kept the current Identity. No local data changed.")
    await expect(firstDialog.getByRole("button", { name: "Connect this device", exact: true })).toBeVisible()
    await firstDialog.locator('button[aria-label="Close"]').click()
    const afterCancel = await localIdentity()
    expect(afterCancel).toEqual(guestBefore)
    expect(await boardStorageHash(workspaceId)).toEqual(boardBefore)
    await expect(page.getByRole("button", { name: "Open Guest-only private card", exact: true })).toBeVisible()

    const secondDialog = await openAddDevice(await issueInvite())
    await approveWithoutRecovery()
    const prompt = await replacementPrompt(qId)
    await prompt.locator('input[type="checkbox"]').check()
    await prompt.getByRole("button", { name: "Continue with this Identity", exact: true }).click()
    await expect(secondDialog).not.toBeVisible({ timeout: 25000 })
    const adopted = await localIdentity()
    expect(adopted.personId).toBe(qId)
    expect(adopted.identityRootKeyPresent).toBe(false)

    const previousProfile = await page.evaluate(async personId => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("tincanban-local-state-v1")
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        const request = db.transaction("kv", "readonly").objectStore("kv").get(`tincanban.local_profile.v1.backup.${personId}`)
        return await new Promise<{ hash: string; personId: string }>((resolve, reject) => {
          request.onsuccess = async () => {
            try {
              if (typeof request.result !== "string") throw new Error("Previous profile backup missing")
              const parsed = JSON.parse(request.result) as { identity: { personId: string } }
              const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.result))
              resolve({ hash: btoa(String.fromCharCode(...new Uint8Array(digest))), personId: parsed.identity.personId })
            } catch (error) { reject(error) }
          }
          request.onerror = () => reject(request.error)
        })
      } finally { db.close() }
    }, guestBefore.personId)
    expect(previousProfile).toEqual({ hash: guestBefore.profileHash, personId: guestBefore.personId })
    expect(await boardStorageHash(workspaceId)).toEqual(boardBefore)
    await expect(page.getByRole("button", { name: "Open Guest-only private card", exact: true })).toBeVisible()

    await expect(page.getByLabel("Workspace role: visitor")).toBeVisible()
    await expect(page.getByRole("button", { name: "Edit board", exact: true })).toHaveCount(0)
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const sync = page.getByRole("dialog", { name: "Device sync" })
    await expect(sync.getByRole("button", { name: "Add someone", exact: true })).toHaveCount(0)
    await page.keyboard.press("Escape")
  } catch (error) {
    throw new Error(safeDiagnostic(error instanceof Error ? error.message : String(error)))
  } finally {
    await portalContext.close()
  }
})
