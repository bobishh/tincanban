import { expect, test } from "./support/coverage"

for (const width of [1280, 390]) test(`Given a board at ${width}px, when Sync opens, then participants and persistent storage share one screen and backups live in Settings`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 })
  await page.goto("/")
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  if (width < 640) {
    await page.getByRole("button", { name: "Menu", exact: true }).click()
    await page.getByRole("button", { name: "Sync", exact: true }).click()
  } else await page.getByRole("button", { name: "Sync", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(page.locator(".mobile-drawer-root")).toHaveCount(0)
  await expect(dialog.getByRole("tab")).toHaveCount(0)
  await expect(dialog.getByRole("list", { name: "Mesh members" })).toBeVisible()
  const members = dialog.getByRole("list", { name: "Mesh members" })
  const storage = dialog.getByRole("region", { name: "Persistent storage", exact: true })
  if (width >= 1000) await dialog.getByRole("button", { name: "Maximize window", exact: true }).click()
  await expect.poll(async () => {
    const peopleBox = await members.boundingBox(), storageBox = await storage.boundingBox()
    if (!peopleBox || !storageBox) return false
    return width >= 1000 ? peopleBox.x + peopleBox.width <= storageBox.x
      : storageBox.y >= peopleBox.y + peopleBox.height
  }).toBe(true)
  await expect(dialog.getByRole("button", { name: "Add Rusty", exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: /(?:Start|Stop) live sync/ })).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Export .tincanban", exact: true })).toHaveCount(0)
  await expect(dialog.getByRole("region", { name: "Ownership succession" })).toHaveCount(0)
  await expect(dialog.getByRole("region", { name: "Selected mesh member" })).toHaveCount(0)
  await dialog.locator(".mesh-member").filter({ hasText: "You" }).click()
  await expect(dialog.getByText("This device", { exact: true })).toBeVisible()
  const selected = dialog.getByRole("region", { name: "Selected mesh member", exact: true })
  await expect(selected.locator("details.mesh-device-details")).toHaveCount(0)
  await expect(selected.locator(".mesh-device-details code")).toBeVisible()
  await expect(selected.locator(".mesh-device-details")).toContainText(/Likely (Chrome|Safari|Firefox|Browser)|Browser \/ OS unknown/)
  await expect(selected.locator(".mesh-device-status")).toHaveText("Open in this tab")
  expect(await selected.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.screenshot({ animations: "disabled", path: info.outputPath(`sync-selected-${width}.png`) })
  await expect.poll(async () => {
    const detailBox = await selected.boundingBox(), storageBox = await storage.boundingBox()
    if (!detailBox || !storageBox) return false
    return width >= 1000 ? detailBox.x + detailBox.width <= storageBox.x
      : storageBox.y >= detailBox.y + detailBox.height
  }).toBe(true)
  await expect(dialog.locator(".mesh-member").filter({ hasText: "You" })).toHaveAttribute("aria-expanded", "true")
  await dialog.locator(".mesh-member").filter({ hasText: "You" }).click()
  await expect(dialog.getByRole("region", { name: "Selected mesh member" })).toHaveCount(0)
  await expect(dialog.locator(".mesh-member").filter({ hasText: "You" })).toHaveAttribute("aria-expanded", "false")
  await expect(dialog.getByRole("button", { name: "Remove my device", exact: true })).toHaveCount(0)
  await page.screenshot({ animations: "disabled", path: info.outputPath(`sync-${width}.png`) })
  if (width >= 1000) {
    await dialog.getByRole("button", { name: "Restore window size", exact: true }).click()
    await expect.poll(async () => {
      const peopleBox = await members.boundingBox(), storageBox = await storage.boundingBox()
      return Boolean(peopleBox && storageBox && storageBox.y >= peopleBox.y + peopleBox.height)
    }).toBe(true)
  }
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  if (width < 640) await page.getByRole("button", { name: "Menu", exact: true }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await settings.getByRole("tab", { name: "Workspace", exact: true }).click()
  await expect(settings.getByRole("button", { name: "Export .tincanban", exact: true })).toBeVisible()
  await expect(settings.getByRole("button", { name: "Import as new board", exact: true })).toBeVisible()
  await settings.getByRole("tab", { name: "Identity", exact: true }).click()
  await expect(settings.getByRole("region", { name: "Private workspace recovery" })).toBeVisible()
})

for (const width of [1280, 390]) test(`Given Rusty is unavailable at ${width}px, when connecting, then pending and failure preserve participants on the same screen`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 })
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.goto("/")
  if (width < 640) await page.getByRole("button", { name: "Menu", exact: true }).click()
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await dialog.locator(".mesh-member").filter({ hasText: "You" }).click()
  await expect(dialog.locator(".mesh-device-details code")).toBeVisible()
  const panel = dialog.getByRole("region", { name: "Rusty", exact: true })
  await panel.getByRole("button", { name: "Add Rusty", exact: true }).click()
  await panel.getByLabel("Address", { exact: true }).fill("https://rusty.invalid")
  // Scope the network fault to connecting, after the local board is ready.
  await page.route("https://rusty.invalid/**", async route => { await gate; await route.abort() })
  await panel.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(panel.getByRole("button", { name: "Connect", exact: true })).toBeDisabled()
  await page.screenshot({ animations: "disabled", path: info.outputPath("sync-pending.png") })
  release()
  await expect(panel.getByRole("alert")).toBeVisible()
  await expect(panel.getByRole("button", { name: "Connect", exact: true })).toBeEnabled()
  await expect(dialog.getByRole("list", { name: "Mesh members" })).toBeVisible()
  await expect(dialog.locator(".mesh-device-details code")).toBeVisible()
})

test("Given a restored board has signed participant access without saved peer devices, when opening Sync after reload, then retain the offline participant and collapsible empty device list", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  await page.evaluate(async () => {
    const { useTincanban } = await import("/src/state.ts")
    const { createRecoverableIdentity } = await import("/vendor/meta-mesh/packages/mesh-identity/src/index.ts")
    const { createWorkspaceGrant } = await import("/src/sync/meshRecords.ts")
    const { defaultProofStore } = await import("/src/domain/proofs.ts")
    const { signEnvelope } = await import("/src/domain/identity.ts")
    const { receiveChat } = await import("/src/chat/service.ts")
    const { workspaceChatRoomId } = await import("/src/app/workspaceMetadata.ts")
    const app = useTincanban(), doc = app.getActiveDoc()!, owner = app.getCurrentProfile()!
    const editor = (await createRecoverableIdentity("better", "Ray")).profile
    const grant = await createWorkspaceGrant(owner, doc.id, editor.identity.personId, "editor")
    await defaultProofStore.putGrant(grant.payload.grantId, grant)
    const signed = await signEnvelope(editor.privateKeys.devicePrivateKey, { kind: "chat-profile", version: 1,
      workspaceId: workspaceChatRoomId(doc), personId: editor.identity.personId, deviceId: editor.device.deviceId,
      id: `${editor.device.deviceId}:${crypto.randomUUID()}`, createdAt: new Date().toISOString(), text: "Ray", revision: 1,
    }, editor.device.deviceId)
    await receiveChat(doc.id, { version: 1, profiles: [{ signed, publicKey: editor.identity.publicKey,
      certificates: [editor.certificate], authority: { publicKey: owner.identity.publicKey,
        certificates: [owner.certificate], grant } }], messages: [], typing: [] }, true)
  })
  await page.reload()
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  await page.getByRole("button", { name: "Menu", exact: true }).click()
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  const participant = dialog.locator(".mesh-member").filter({ hasText: "Ray" })
  await expect(participant).toContainText("0 devices")
  await expect(participant).toContainText("editor")
  await participant.click()
  await expect(dialog.getByRole("list", { name: "Devices for Ray" }).getByRole("listitem")).toHaveCount(0)
  await expect(participant).toHaveAttribute("aria-expanded", "true")
  await participant.click()
  await expect(dialog.getByRole("region", { name: "Selected mesh member" })).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("restored-participant.png"), animations: "disabled" })
})
