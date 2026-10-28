import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

test("Given clipboard access is denied, when Sync opens, then its pairing link remains selectable for manual copy", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new DOMException("Clipboard denied", "NotAllowedError") } },
    })
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Sync", exact: true }).click()

  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await dialog.getByRole("button", { name: "Add someone" }).click()
  await dialog.getByRole("button", { name: "Add my device", exact: true }).click()
  const pairingLink = dialog.getByRole("textbox", { name: "Pairing link", exact: true })
  await expect(pairingLink).toHaveValue(/\/pair#/)
  await dialog.getByRole("button", { name: "Copy enrollment link" }).click()
  await expect(dialog.getByText("Clipboard unavailable. Select the pairing link and copy it manually.")).toBeVisible()
})

test("Given a malformed pairing link, when tincanban opens it, then it fails without claiming a sync", async ({ page }) => {
  await page.goto("/pair#v=0.0.1&endpoint=peer-without-secret")

  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog.getByRole("heading", { name: "Couldn’t sync" })).toBeVisible()
  await expect(dialog.getByRole("alert")).toHaveText("This pairing link is invalid.")
  await expect(dialog.getByText("Workspace synced.")).toHaveCount(0)
  await expect(page).toHaveURL(/\/pair#v=0\.0\.1&endpoint=peer-without-secret$/)
  await page.reload()
  await expect(dialog.getByRole("alert")).toHaveText("This pairing link is invalid.")
})

test("Given a QR invitation opened in a scanner, when its current URL opens in another browser then the invitation survives", async ({ page, browser }) => {
  const invite = "/pair#v=1&kind=workspace-join&invitationId=handoff-test&issuerPersonId=p1&issuerDeviceId=d1&issuerPublicKey=pk1&endpoint=ep1&createdAt=2026-01-01T00:00:00.000Z&expiresAt=2099-01-01T00:00:00.000Z&secret=handoff-secret&workspaceId=ws1&workspaceTitle=Handoff+board&role=editor"
  await page.goto(invite)
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog.getByText("You have been invited to join Handoff board", { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/pair#/)
  const handoffUrl = page.url()
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect(page).toHaveURL(handoffUrl)
  await page.reload()
  await expect(dialog.getByText("You have been invited to join Handoff board", { exact: true })).toBeVisible()
  const otherContext = await browser.newContext()
  try {
    const other = await otherContext.newPage()
    await other.goto(handoffUrl)
    await expect(other.getByRole("dialog", { name: "Device sync" }).getByText("You have been invited to join Handoff board", { exact: true })).toBeVisible()
    await expect(other).toHaveURL(handoffUrl)
  } finally {
    await otherContext.close()
  }
})

for (const exit of ["Dismiss", "Close", "Escape"]) {
  test(`Given an expired invitation, when its error is closed with ${exit}, then the URL returns to the board and reload stays there`, async ({ page }) => {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    const boardLabel = await page.locator(".workspace-heading").textContent()
    const boardAddress = new URL(page.url())
    const invite = await page.evaluate(async () => {
      const state = (await import("/src/test/stateFixture.ts")).useTincanban()
      const profile = state.getCurrentProfile()
      if (!profile) throw new Error("Expected a local profile for invitation fixture")
      const params = new URLSearchParams({
        v: "1",
        kind: "workspace-join",
        invitationId: "expired",
        issuerPersonId: profile.identity.personId,
        issuerDeviceId: profile.device.deviceId,
        issuerPublicKey: profile.device.publicKey,
        endpoint: "peer1",
        createdAt: "2019-01-01T00:00:00.000Z",
        expiresAt: "2020-01-01T00:00:00.000Z",
        secret: "abc",
        workspaceId: "expired-ws",
        workspaceTitle: "Expired board",
        role: "visitor",
      })
      return `/pair?view=board#${params}`
    })
    await page.goto(invite)
    const dialog = page.getByRole("dialog", { name: "Device sync" })
    await expect(dialog.getByRole("alert")).toHaveText("This invitation has expired.")
    if (exit === "Escape") await page.keyboard.press("Escape")
    else await dialog.getByRole("button", { name: exit, exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(url => url.pathname === boardAddress.pathname && url.search === "?view=board" && !url.hash)
    await page.reload()
    await expect(page).toHaveURL(url => url.pathname === boardAddress.pathname && url.search === "?view=board" && !url.hash)
    await expect(page.locator(".workspace-heading")).toHaveText(boardLabel ?? "")
    await expect(dialog).toBeHidden()
  })
}

test("Given paired browser profiles, when either peer changes a card, then the other board updates without another QR", async ({ browser, page }) => {
  test.setTimeout(90_000)
  const peerContext = await browser.newContext()
  const peer = await peerContext.newPage()

  try {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    await page.getByRole("button", { name: /Add lead to/ }).first().click()
    await page.getByLabel("Company *").fill("Cleo")
    await page.getByLabel("Role *").fill("Senior Ruby Engineer")
    await page.getByRole("button", { name: "Create item" }).click()
    await expect(page.getByText("1 card · 0 docs")).toBeVisible()
    await page.getByRole("button", { name: "Close detail" }).click()

    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const hostDialog = page.getByRole("dialog", { name: "Device sync" })
    await hostDialog.getByRole("button", { name: "Add someone" }).click()
    await hostDialog.getByRole("button", { name: "Add my device", exact: true }).click()
    await expect(hostDialog.getByLabel("Pairing QR code")).toBeVisible({ timeout: 10_000 })
    const invite = await hostDialog.getByLabel("Pairing link").inputValue()

    await peer.goto(invite)
    const peerDialog = peer.getByRole("dialog", { name: "Device sync" })
    await expect(peerDialog.getByRole("button", { name: "Connect to mesh" })).toHaveCount(0)
    await peerDialog.getByRole("button", { name: "Add this device" }).waitFor({ state: "visible" })
    if (await peerDialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).count()) await peerDialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).check()
    await peerDialog.getByRole("button", { name: "Add this device" }).click()
    await hostDialog.getByRole("button", { name: "Approve device" }).click()
    await expect(peerDialog.getByText("Device enrolled", { exact: true })).toBeVisible({ timeout: 25_000 })
    await expect(hostDialog.getByText("Device enrolled", { exact: true })).toBeVisible({ timeout: 25_000 })
    await expect(peer.getByText("1 card · 0 docs")).toBeVisible()
    await peerDialog.getByRole("button", { name: "Close", exact: true }).first().click()
    await hostDialog.getByRole("button", { name: "Close", exact: true }).first().click()
    await expect(page.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(peer.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })

    // When the peer makes a later visible change, the already-paired host receives it.
    await peer.getByRole("button", { name: /Add lead to/ }).first().click()
    await peer.getByLabel("Company *").fill("Intercom")
    await peer.getByLabel("Role *").fill("Software Engineer")
    await peer.getByRole("button", { name: "Create item" }).click()

    // Then no second QR or import is needed for the host board to converge.
    await expect(page.getByText("2 cards · 0 docs")).toBeVisible({ timeout: 20_000 })
  } finally {
    await peerContext.close()
  }
})

test("Given a shared board and no Rusty, when an Identity photo arrives on another board and its first shared write fails, then retry delivers the photo through P2P without switching boards", async ({ page, browser }) => {
  test.setTimeout(90_000)
  const participantContext = await browser.newContext()
  const participant = await participantContext.newPage()
  try {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const host = page.getByRole("dialog", { name: "Device sync" })
    await host.getByRole("button", { name: "Add someone", exact: true }).click()
    await host.getByRole("button", { name: "Generate link", exact: true }).click()
    await participant.goto(await host.getByLabel("Pairing link").inputValue())
    const join = participant.getByRole("dialog", { name: "Device sync" })
    await join.getByRole("button", { name: "Accept and join", exact: true }).click()
    await host.getByRole("button", { name: "Approve access", exact: true }).click()
    await expect(join.getByText(/Connected to/)).toBeVisible({ timeout: 30_000 })
    await join.getByRole("button", { name: "Close", exact: true }).click()
    if (await host.getByRole("button", { name: "Close", exact: true }).isVisible()) {
      await host.getByRole("button", { name: "Close", exact: true }).click()
    }
    await participant.evaluate(async () => {
      const { useTincanban } = await import("/src/test/stateFixture.ts")
      const { defaultStorage } = await import("/src/storage.ts")
      const app = useTincanban()
      const sharedId = app.activeWorkspace.id
      await app.createWorkspaceAsync("Other board", "blank")
      const original = defaultStorage.withWorkspaceTransaction.bind(defaultStorage)
      let failNext = true
      defaultStorage.withWorkspaceTransaction = async (id, operation) => {
        if (id === sharedId && failNext) {
          failNext = false
          throw new Error("Temporary shared profile write failure")
        }
        return original(id, operation)
      }
    })
    await expect(participant.getByRole("region", { name: "Other board", exact: true })).toBeVisible()
    const source = await participant.evaluate(async () => {
      const { useTincanban } = await import("/src/test/stateFixture.ts")
      const { saveIdentityPhoto } = await import("/src/app/identityPhoto.ts")
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 128
      const paint = canvas.getContext("2d")!
      paint.fillStyle = "#2563eb"
      paint.fillRect(0, 0, 128, 128)
      const image = canvas.toDataURL("image/jpeg", 0.8)
      await saveIdentityPhoto(useTincanban().getCurrentProfile()!, image)
      return image
    })
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    await expect(page.getByRole("region", { name: "Rusty", exact: true })).toContainText("P2P only")
    await expect(page.locator(".mesh-member .participant-avatar-photo")).toHaveCount(0)
    await expect(page.locator(".mesh-member .participant-avatar-photo")).toHaveAttribute("src", source, { timeout: 30_000 })
    await expect(participant.getByRole("region", { name: "Other board", exact: true })).toBeVisible()
  } finally { await participantContext.close() }
})
