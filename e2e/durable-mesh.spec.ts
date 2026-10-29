import { expect, test, type Browser, type BrowserContext, type Page } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"
import { captureRealIrohNodes, closeLatestRealIrohNode, realIrohNodeOwnership } from "./support/recovery"
import { captureMeshResources, meshResourceCounts } from "./support/meshResources"

async function addLead(page: Page, company: string) {
  await ensureJobSearchWorkspace(page)
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  await page.getByLabel("Company *").fill(company)
  await page.getByLabel("Role *").fill("Engineer")
  await page.getByRole("button", { name: "Create item" }).click()
  await page.getByRole("button", { name: "Close detail" }).click()
}

async function pairWorkspace(host: Page, guest: Page) {
  await ensureJobSearchWorkspace(host)
  await host.getByRole("button", { name: "Sync", exact: true }).click()
  const hostDialog = host.getByRole("dialog", { name: "Device sync" })
  await hostDialog.getByRole("button", { name: "Add someone" }).click()
  await hostDialog.getByRole("button", { name: "Generate link" }).click()
  const invite = await hostDialog.getByLabel("Pairing link").inputValue()
  await guest.goto(invite)
  const guestDialog = guest.getByRole("dialog", { name: "Device sync" })
  await guestDialog.getByRole("button", { name: "Accept and join" }).click()
  await host.getByLabel("Participant role").selectOption("editor")
  await host.getByRole("button", { name: "Approve access" }).click()
  await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
  await expect(guest.getByLabel("Workspace role: editor")).toBeVisible()
  if (await guestDialog.isVisible()) await guestDialog.getByRole("button", { name: "Close", exact: true }).first().click()
  if (await hostDialog.isVisible()) await hostDialog.getByRole("button", { name: "Close", exact: true }).first().click()
  return invite
}

async function isolatedContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext()
  await context.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  return context
}

async function journalChangeIds(page: Page, workspaceId: string): Promise<string[]> {
  return page.evaluate(async id => {
    const { openWorkspaceJournal, recordsForWorkspace } = await import("/src/storageJournal.ts")
    // The journal module owns this cached connection; observation borrows it.
    const db = await openWorkspaceJournal()
    const records = await recordsForWorkspace<{ changeHash: string }>(db, "changes", id)
    return records.map(record => record.changeHash).sort()
  }, workspaceId)
}

test("Given paired browsers, when a lead changes, then the peer receives the durable board update", async ({ browser, page }) => {
  test.setTimeout(90_000)
  const context = await isolatedContext(browser)
  const guest = await context.newPage()
  try {
    await Promise.all([page.goto("/"), guest.goto("/")])
    await pairWorkspace(page, guest)
    const handoffTrace = await page.evaluate(async () => {
      const { meshTraceSnapshot } = await import("/src/sync/meshTrace.ts")
      return meshTraceSnapshot().filter(event => event.event === "live.session.failed")
    })
    expect(handoffTrace.filter(event => String(event.reason ?? "").includes("mesh-handoff-confirmed")), JSON.stringify(handoffTrace)).toHaveLength(0)
    await addLead(page, "Gossip production path")

    await expect(guest.getByRole("button", { name: "Open Gossip production path — Engineer" })).toBeVisible({ timeout: 30_000 })
  } finally { await context.close() }
})

test("Given a paired editor, when its actual Iroh node closes unexpectedly, then a fresh node reconnects and syncs without reload or pairing", async ({ browser }) => {
  test.setTimeout(120_000)
  const hostContext = await isolatedContext(browser)
  const guestContext = await isolatedContext(browser)
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  try {
    await Promise.all([captureRealIrohNodes(host), captureRealIrohNodes(guest)])
    await Promise.all([host.goto("/"), guest.goto("/")])
    await pairWorkspace(host, guest)
    await guest.evaluate(() => { (window as Window & { __TINCANBAN_RECOVERY_SENTINEL__?: string }).__TINCANBAN_RECOVERY_SENTINEL__ = "still-running" })
    const ownershipBeforeClose = await realIrohNodeOwnership(guest)
    expect(ownershipBeforeClose.created).toBeGreaterThan(0)
    const before = await guest.evaluate(async () => {
      const { clearMeshTrace, meshTraceSnapshot } = await import("/src/sync/meshTrace.ts")
      const endpoint = meshTraceSnapshot().findLast(event => event.event === "node.started")?.endpoint
      clearMeshTrace()
      return { endpoint, href: window.location.href }
    })

    await closeLatestRealIrohNode(guest, before.endpoint)

    await expect.poll(async () => (await realIrohNodeOwnership(guest)).created, { timeout: 45_000 })
      .toBe(ownershipBeforeClose.created + 1)
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 45_000 })
    await expect(guest.getByLabel("Workspace role: editor")).toBeVisible()
    expect(await guest.evaluate(() => window.location.href)).toBe(before.href)
    expect(await guest.evaluate(() => (window as Window & { __TINCANBAN_RECOVERY_SENTINEL__?: string }).__TINCANBAN_RECOVERY_SENTINEL__)).toBe("still-running")

    await addLead(host, "After actual node recovery")
    await expect(guest.getByRole("button", { name: "Open After actual node recovery — Engineer" })).toBeVisible({ timeout: 30_000 })
    await addLead(guest, "Recovered node sends")
    await expect(host.getByRole("button", { name: "Open Recovered node sends — Engineer" })).toBeVisible({ timeout: 30_000 })

    const after = await guest.evaluate(async () => {
      const { meshTraceSnapshot } = await import("/src/sync/meshTrace.ts")
      return meshTraceSnapshot()
    })
    expect(after.some(event => event.event === "node.shutdown"), JSON.stringify(after)).toBe(true)
    const restarted = after.filter(event => event.event === "node.started")
    expect(restarted).toHaveLength(1)
    expect(after.filter(event => event.event === "run.start")).toHaveLength(1)
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()])
  }
})

test("Given a paired editor goes offline, when both sides edit and it comes online, then persisted changes converge without reloading", async ({ browser }) => {
  test.setTimeout(120_000)
  const hostContext = await isolatedContext(browser)
  const guestContext = await isolatedContext(browser)
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  try {
    await captureMeshResources(guest)
    await Promise.all([host.goto("/"), guest.goto("/")])
    await pairWorkspace(host, guest)
    await expect(host.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => (await meshResourceCounts(guest)).heartbeats, { timeout: 20_000 }).toBeGreaterThan(0)

    const before = await Promise.all([host, guest].map((target, index) => target.evaluate(async sentinel => {
      const current = window as Window & { __TINCANBAN_RECONNECT_SENTINEL__?: string }
      current.__TINCANBAN_RECONNECT_SENTINEL__ = sentinel
      const { readLocal } = await import("/src/localDb.ts")
      const profile = JSON.parse((await readLocal("tincanban.local_profile.v1"))!) as { identity: { personId: string } }
      const { useTincanban } = await import("/src/test/stateFixture.ts")
      const workspaceId = useTincanban().getActiveDoc()!.id
      const { meshTraceSnapshot, clearMeshTrace } = await import("/src/sync/meshTrace.ts")
      const session = meshTraceSnapshot().findLast(event => event.event === "session.started")
      clearMeshTrace()
      return { sentinel, personId: profile.identity.personId, workspaceId, connectionId: session?.connectionId }
    }, `reconnect-${index}`)))
    expect(before[0].workspaceId).toBe(before[1].workspaceId)
    expect(before[1].connectionId).toEqual(expect.any(String))
    const guestJournalBefore = await journalChangeIds(guest, before[1].workspaceId)

    // Chromium's network emulation emits the production offline event. tincanban's
    // handler closes the real Iroh session even when WebRTC itself stays viable.
    await guestContext.setOffline(true)
    await expect(guest.getByLabel("Mesh offline")).toBeVisible({ timeout: 20_000 })
    // Transport teardown may finish before the baseline trace is cleared.
    // Require stopped live resources rather than a particular close event.
    await expect.poll(async () => (await meshResourceCounts(guest)).heartbeats, { timeout: 20_000 }).toBe(0)

    await addLead(guest, "Guest queued offline")
    await addLead(host, "Host queued remotely")
    const guestJournalOffline = await journalChangeIds(guest, before[1].workspaceId)
    expect(guestJournalOffline.length).toBeGreaterThan(guestJournalBefore.length)

    await guestContext.setOffline(false)
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 35_000 })
    await expect(host.getByLabel("Mesh connected")).toBeVisible({ timeout: 35_000 })
    await expect(host.getByRole("button", { name: "Open Guest queued offline — Engineer" })).toBeVisible({ timeout: 30_000 })
    await expect(guest.getByRole("button", { name: "Open Host queued remotely — Engineer" })).toBeVisible({ timeout: 30_000 })

    const after = await Promise.all([host, guest].map(target => target.evaluate(async () => {
      const current = window as Window & { __TINCANBAN_RECONNECT_SENTINEL__?: string }
      const { readLocal } = await import("/src/localDb.ts")
      const profile = JSON.parse((await readLocal("tincanban.local_profile.v1"))!) as { identity: { personId: string } }
      const { meshTraceSnapshot } = await import("/src/sync/meshTrace.ts")
      return { sentinel: current.__TINCANBAN_RECONNECT_SENTINEL__, personId: profile.identity.personId,
        trace: meshTraceSnapshot() }
    })))
    expect(after.map(value => value.sentinel)).toEqual(before.map(value => value.sentinel))
    expect(after.map(value => value.personId)).toEqual(before.map(value => value.personId))
    await expect(host.getByLabel("Workspace role: owner")).toBeVisible()
    await expect(guest.getByLabel("Workspace role: editor")).toBeVisible()

    const reconnect = after[1].trace.find(event => event.event === "session.started")
    expect(reconnect, JSON.stringify(after[1].trace)).toBeDefined()
    expect(reconnect?.connectionId).not.toBe(before[1].connectionId)
    expect(after[1].trace.some(event => event.event === "node.shutdown"), JSON.stringify(after[1].trace)).toBe(false)
    expect(after[1].trace.some(event => event.event === "run.start"), JSON.stringify(after[1].trace)).toBe(false)

    // tincanban currently replays persisted Automerge state; it does not drain a
    // separate outbox. The committed offline change therefore remains journaled.
    const guestJournalAfter = await journalChangeIds(guest, before[1].workspaceId)
    expect(guestJournalAfter).toEqual(guestJournalOffline)
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()])
  }
})

test("Given an editor has synced changes, when owner removes access, then writes stop and a new peer retains accepted history", async ({ browser, page }) => {
  test.setTimeout(100_000)
  await page.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  const guestContext = await isolatedContext(browser)
  const freshContext = await isolatedContext(browser)
  const guest = await guestContext.newPage()
  try {
    await Promise.all([page.goto("/"), guest.goto("/")])
    await pairWorkspace(page, guest)
    await addLead(guest, "Accepted editor history")
    await expect(page.getByRole("button", { name: "Open Accepted editor history — Engineer" })).toBeVisible({ timeout: 20_000 })
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const settings = page.getByRole("dialog", { name: "Device sync" })
    await settings.getByRole("list", { name: "Mesh members" }).getByRole("button").filter({ hasText: "editor" }).click()
    await settings.getByRole("button", { name: "Remove participant", exact: true }).click()
    const confirmation = settings.getByRole("region", { name: "Remove participant confirmation" })
    await expect(confirmation).toContainText("all their devices")
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(guest.getByRole("button", { name: /Add lead to/ }).first()).toBeVisible()
    await settings.getByRole("button", { name: "Remove participant", exact: true }).click()
    await confirmation.getByRole("button", { name: "Remove participant and all devices", exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    await expect(guest.getByLabel("Mesh offline")).toBeVisible({ timeout: 20_000 })

    await expect(guest.getByRole("button", { name: /Add lead to/ })).toHaveCount(0)
    await settings.getByRole("button", { name: "Close", exact: true }).click()
    const fresh = await freshContext.newPage()
    await pairWorkspace(page, fresh)
    await expect(fresh.getByRole("button", { name: "Open Accepted editor history — Engineer" })).toBeVisible()
    await addLead(fresh, "New editor after revocation")
    await expect(page.getByRole("button", { name: "Open New editor after revocation — Engineer" })).toBeVisible({ timeout: 20_000 })
  } finally {
    await Promise.all([guestContext.close(), freshContext.close()])
  }
})

