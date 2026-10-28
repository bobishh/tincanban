import { expect, test } from "./support/coverage"

const boardId = "public-board-fixture"
const publicOrigin = process.env.TINCANBAN_PUBLIC_E2E_KEEPER_ORIGIN ?? "http://127.0.0.1:47839"
const publicPath = `/boards/${boardId}?rusty=${encodeURIComponent(publicOrigin)}`
const api = `${publicOrigin}/v1/public/boards/${boardId}`
const fileHash = "A".repeat(43)
const snapshot = {
  kind: "tincanban-public-board", version: 1, board: { id: boardId, title: "Published board" },
  columns: [{ id: "column-a", title: "Doing", rank: "0/1", collapsible: true }, { id: "column-b", title: "Backlog", rank: "1/1", collapsible: false }],
  fields: [{ id: "field-a", title: "Company", valueType: "text", required: false, rank: "0/1", options: [] }],
  cards: [{ id: "card-a", parentId: null, columnId: "column-a", title: "Public card", body: "**Public body**",
    values: { "field-a": "Example Co" }, rank: "0/1" }, { id: "card-child", parentId: "card-a", columnId: "column-a", title: "Nested card", body: "", values: {}, rank: "1/1" }],
  discussions: [{ id: "discussion-root", threadId: "discussion-root", replyTo: null, targets: [{ type: "card", id: "card-a" }], authorId: "A".repeat(42) + "E", author: "Public author", createdAt: "2026-10-10T10:00:00Z", body: "Read only discussion" }],
  discussionAuthors: [{ id: "A".repeat(42) + "E", avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA" }],
  files: [{ id: "file-a", parentId: "card-a", title: "Handout", fileName: "handout.txt", mediaType: "text/plain", byteLength: 7, sha256: fileHash }],
}

async function monitorPrivateStartup(page: import("@playwright/test").Page) {
  let wasmRequests = 0
  await page.addInitScript(() => {
    const state = window as typeof window & { __publicProbe: { workers: number; wasm: number; idbOpen: number } }
    state.__publicProbe = { workers: 0, wasm: 0, idbOpen: 0 }
    const WorkerConstructor = window.Worker
    window.Worker = class extends WorkerConstructor { constructor(...args: ConstructorParameters<typeof WorkerConstructor>) { state.__publicProbe.workers++; super(...args) } }
    const open = indexedDB.open.bind(indexedDB)
    indexedDB.open = ((...args: Parameters<IDBFactory["open"]>) => { state.__publicProbe.idbOpen++; return open(...args) }) as IDBFactory["open"]
    const instantiate = WebAssembly.instantiate.bind(WebAssembly)
    WebAssembly.instantiate = ((...args: Parameters<typeof WebAssembly.instantiate>) => { state.__publicProbe.wasm++; return instantiate(...args) }) as typeof WebAssembly.instantiate
    const instantiateStreaming = WebAssembly.instantiateStreaming.bind(WebAssembly)
    WebAssembly.instantiateStreaming = ((...args: Parameters<typeof WebAssembly.instantiateStreaming>) => { state.__publicProbe.wasm++; return instantiateStreaming(...args) }) as typeof WebAssembly.instantiateStreaming
  })
  page.on("request", request => {
    if (/\.wasm(?:\?|$)/u.test(request.url())) wasmRequests++
  })
  return () => wasmRequests
}

for (const width of [390, 1440]) test(`Given an anonymous reader at ${width}px, When a published board is reloaded, Then the shared visitor board and detail are readable without private startup`, async ({ page, browserName }, info) => {
  const getWasmRequests = await monitorPrivateStartup(page)
  await page.setViewportSize({ width, height: 900 })
  await page.route(api, route => route.fulfill({ json: { boardId, revision: 3, projection: snapshot }, headers: { "cache-control": "no-store" } }))
  await page.route(`${api}/files/3/${fileHash}`, route => route.fulfill({ body: "public!", headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="handout.txt"', "x-content-type-options": "nosniff" } }))
  await page.goto(publicPath)
  await expect(page.getByRole("heading", { name: "Published board" })).toBeVisible()
  await expect(page.locator('.topbar .brand-name')).toHaveText("TINCANBAN")
  await expect(page.getByRole("img", { name: "Read-only board", exact: true })).toBeVisible()
  await expect(page.locator('.board .column .lead-card')).toHaveCount(1)
  const doing = page.getByRole("region", { name: "Doing", exact: true })
  const backlog = page.getByRole("region", { name: "Backlog", exact: true })
  await expect(doing.getByRole("button", { name: /Collapse/ })).toBeVisible()
  await expect(backlog.getByRole("button", { name: /Collapse|Expand/ })).toHaveCount(0)
  await doing.getByRole("button", { name: "Collapse Doing", exact: true }).click()
  await expect(doing.getByRole("button", { name: "Open Doing with 1 cards", exact: true })).toBeVisible()
  await doing.getByRole("button", { name: "Open Doing with 1 cards", exact: true }).click()
  await page.getByRole("searchbox", { name: "Search cards" }).fill("Example Co")
  await expect(page.getByRole("button", { name: "Open Public card", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Open Nested card", exact: true })).toHaveCount(0)
  await page.getByRole("searchbox", { name: "Search cards" }).fill("missing")
  await expect(page.getByText("No matching cards", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Clear search and filters" }).click()
  await expect(page.getByRole("button", { name: "Open Nested card", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Open Public card", exact: true }).click()
  const cardDialog = page.getByRole("dialog", { name: "Item overview", exact: true })
  await expect(cardDialog).toHaveClass(/spatial-window/)
  const closeCard = cardDialog.getByRole("button", { name: "Dismiss", exact: true })
  await expect(cardDialog.getByRole("button", { name: "Edit", exact: true })).toBeDisabled()
  await expect(cardDialog.getByText("Nested card", { exact: true })).toBeVisible()
  await expect(cardDialog.getByText("Public body")).toBeVisible()
  await expect(cardDialog.getByText("Attached documents", { exact: true })).toBeVisible()
  await expect(cardDialog.getByRole("group", { name: "Handout", exact: true }).getByRole("button", { name: "Preview", exact: true })).toBeVisible()
  await closeCard.click()
  await page.getByRole("button", { name: /Open discussion for Public card/ }).click()
  const discussion = page.getByRole("dialog", { name: "Discussion", exact: true })
  await expect(discussion).toHaveClass(/spatial-window/)
  await expect(discussion.getByText("Read only discussion")).toBeVisible()
  await expect(discussion.getByRole("textbox", { name: "Message" })).toHaveCount(0)
  await discussion.getByRole("button", { name: "Close", exact: true }).click()
  await expect(page.getByRole("button", { name: /Reply|Post/ })).toHaveCount(0)
  await expect(page.getByRole("button", { name: /Invite/ })).toHaveCount(0)
  await page.getByRole("button", { name: "Open Public card", exact: true }).click()
  const documentDownload = cardDialog.getByRole("link", { name: "Download Handout", exact: true })
  await expect(documentDownload).toHaveAttribute("download", "handout.txt")
  if (browserName !== "webkit") {
    const downloadPromise = page.waitForEvent("download")
    await documentDownload.click()
    expect((await downloadPromise).suggestedFilename()).toBe("handout.txt")
  }
  await closeCard.click()
  await expect(page.getByRole("button", { name: "Open Public card", exact: true })).toBeFocused()
  await page.screenshot({ path: info.outputPath(`visitor-board-${width}.png`), fullPage: true })
  await page.reload()
  await expect(page.getByRole("heading", { name: "Published board" })).toBeVisible()
  const result = await page.evaluate(async () => ({
    profile: localStorage.getItem("tincanban.local_profile.v1"), active: localStorage.getItem("tincanban.active_workspace_id"),
    idb: await indexedDB.databases(), probe: (window as typeof window & { __publicProbe: unknown }).__publicProbe,
  }))
  expect(result.profile).toBeNull()
  expect(result.active).toBeNull()
  expect(result.idb).toEqual([])
  expect(result.probe).toEqual({ workers: 0, wasm: 0, idbOpen: 0 })
  expect(getWasmRequests()).toBe(0)
})

test("Given a public route, When the service is pending, unavailable, or returns invalid data, Then errors are retryable without private startup", async ({ page }) => {
  const getWasmRequests = await monitorPrivateStartup(page)
  let requestCount = 0
  await page.route(api, route => {
    requestCount++
    if (requestCount === 1) return route.fulfill({ status: 503, json: { message: "temporarily unavailable" } })
    if (requestCount === 2) return route.fulfill({ json: { boardId, revision: 0, projection: { ...snapshot, privateCredential: "must be rejected" } } })
    return route.fulfill({ status: 404, json: { message: "Public board unavailable" } })
  })
  await page.goto(publicPath)
  await expect(page.getByRole("alert")).toContainText("unavailable")
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible()
  await expect(page.getByRole("button", { name: /Open workspaces|Workspace chat|Menu/ })).toHaveCount(0)
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByRole("heading", { name: "Publication invalid" })).toBeVisible()
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByRole("heading", { name: "Board unavailable" })).toBeVisible()
  expect(requestCount).toBe(3)
  for (const path of ["/boards/!", "/boards/foo/bar/extra", "/boards"]) {
    await page.goto(path)
    await expect(page.getByRole("heading", { name: "Publication invalid" })).toBeVisible()
  }
  expect(await page.evaluate(() => (window as typeof window & { __publicProbe: unknown }).__publicProbe)).toEqual({ workers: 0, wasm: 0, idbOpen: 0 })
  expect(getWasmRequests()).toBe(0)
})

test("Given a live public board, When its publication changes or is withdrawn, Then the shared visitor UI updates and closes stale windows", async ({ page }) => {
  let revision = 1
  let withdrawn = false
  const updated = {
    ...snapshot,
    board: { id: boardId, title: "Updated publication" },
    columns: [
      { id: "column-a", title: "Doing", rank: "0/1", collapsible: false },
      { id: "column-b", title: "Backlog", rank: "1/1", collapsible: true },
    ],
    cards: [{ ...snapshot.cards[0], title: "Updated public card" }, snapshot.cards[1]],
  }
  await page.route(api, route => withdrawn
    ? route.fulfill({ status:  404, json: { message: "Public board unavailable" }, headers: { "cache-control": "no-store" } })
    : route.fulfill({ json: { boardId, revision, projection: revision === 1 ? snapshot : updated }, headers: { "cache-control": "no-store" } }))
  await page.goto(publicPath)
  await expect(page.getByRole("heading", { name: "Published board" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Doing", exact: true }).getByRole("button", { name: "Collapse Doing", exact: true })).toBeVisible()
  await expect(page.getByRole("region", { name: "Backlog", exact: true }).getByRole("button", { name: /Collapse|Open Backlog/ })).toHaveCount(0)

  await page.getByRole("button", { name: "Open Public card", exact: true }).click()
  const detail = page.getByRole("dialog", { name: "Item overview", exact: true })
  await expect(detail).toHaveClass(/spatial-window/)
  await page.getByRole("button", { name: "Workspace chat", exact: true }).click()
  const chat = page.getByRole("dialog", { name: "Board discussion", exact: true })
  await expect(chat).toHaveClass(/spatial-window/)
  await expect(chat.getByText("(You)", { exact: true })).toHaveCount(0)
  await expect(chat.locator(".participant-avatar-photo")).toBeVisible()

  revision = 2
  await expect(page.getByRole("heading", { name: "Updated publication" })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole("button", { name: "Open Updated public card", exact: true })).toBeVisible()
  await expect(page.getByRole("region", { name: "Doing", exact: true }).getByRole("button", { name: /Collapse Doing|Open Doing/ })).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Backlog", exact: true }).getByRole("button", { name: "Collapse Backlog", exact: true })).toBeVisible()
  await expect(detail).toHaveClass(/spatial-window/)
  await expect(detail.getByRole("heading", { name: "Updated public card", exact: true })).toBeVisible()
  await expect(chat).toHaveClass(/spatial-window/)
  withdrawn = true
  await expect(page.getByRole("heading", { name: "Board unavailable" })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

for (const width of [390, 1440]) test(`Given a job-search publication at ${width}px, When opening a card, Then reuse visitor summaries, accents, filters and lead details`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 })
  const jobSnapshot = { ...snapshot,
    board: { id: boardId, title: "Job search", presentation: { entityName: "lead", preset: { key: "job-search", version: 1,
      bindings: { "status.lead": "lead", "status.applied": "column-a", "status.interview": "interview", "status.offer": "offer", "status.rejected": "rejected", "field.company": "field-a", "field.role": "role", "field.url": "url", "field.location": "location" } } } },
    columns: [{ id: "lead", title: "Lead", rank: "-1/1", color: "#e8c547" }, { id: "column-a", title: "Applied", rank: "0/1", color: "#66b3ff" },
      { id: "interview", title: "Interview", rank: "1/1", color: "#a98cff" }, { id: "offer", title: "Offer", rank: "2/1", color: "#65cf9b" }, { id: "rejected", title: "Rejected", rank: "3/1", color: "#ed8b65" }],
    fields: [...snapshot.fields, ...[{ id: "role", title: "Role", valueType: "text" }, { id: "url", title: "URL", valueType: "url" }, { id: "location", title: "Location", valueType: "text" }].map((field, index) => ({ ...field, required: false, rank: `${index + 1}/1`, options: [] }))],
    cards: [{ ...snapshot.cards[0], title: "Example Co — Senior Systems Engineer", values: { "field-a": "Example Co", role: "Senior Systems Engineer", location: "Berlin, Germany", url: "https://jobs.example.test/very-long-original-posting" } }],
    discussions: [], files: [],
  }
  await page.route(api, route => route.fulfill({ json: { boardId, revision: 4, projection: jobSnapshot } }))
  await page.goto(publicPath)
  await expect(page.locator('.workspace-heading')).toHaveText("Job search")
  const column = page.getByRole("region", { name: "Applied", exact: true })
  const card = column.locator('.lead-card')
  await expect(card.getByText("Example Co — Senior Systems Engineer", { exact: true })).toBeVisible()
  await expect(card.locator('.company')).toHaveCount(0)
  await expect(card.locator('dl')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath(`visitor-jobs-${width}.png`), fullPage: true })
  await card.getByRole("button", { name: "Open Example Co — Senior Systems Engineer", exact: true }).click()
  const detail = page.getByRole("dialog", { name: "Item overview", exact: true })
  await expect(detail).toHaveClass(/spatial-window/)
  await expect(detail.getByRole("heading", { name: "Example Co — Senior Systems Engineer", exact: true })).toBeVisible()
  await expect(detail.getByText("Senior Systems Engineer", { exact: true })).toBeVisible()
  await expect(detail.getByRole("button", { name: "Edit", exact: true })).toBeDisabled()
  await expect(detail.getByRole("link", { name: "https://jobs.example.test/very-long-original-posting" })).toHaveAttribute("href", "https://jobs.example.test/very-long-original-posting")
  await expect(detail).toContainText("Berlin, Germany")
  await page.screenshot({ path: info.outputPath(`visitor-lead-${width}.png`), fullPage: true })
})


test("Given the original board address without a server parameter, when an anonymous visitor opens it, then read its publication without private startup", async ({ page }) => {
  const getWasmRequests = await monitorPrivateStartup(page)
  await page.route(api, route => route.fulfill({ json: { boardId, revision: 1, projection: snapshot } }))
  await page.goto(`/boards/${boardId}`)
  await expect(page.getByRole("heading", { name: "Published board" })).toBeVisible()
  expect(getWasmRequests()).toBe(0)
})


test("Given this browser knows another private board, when a public board opens, then read the shared address without private startup", async ({ page }) => {
  const getWasmRequests = await monitorPrivateStartup(page)
  await page.addInitScript(boardId => {
    localStorage.setItem("tincanban.board-route-index.v1", JSON.stringify({ version: 1, activeIdentityId: "known-owner",
      identities: { "known-owner": { [boardId + "-other"]: "known-workspace" } } }))
  }, boardId)
  await page.route(api, route => route.fulfill({ json: { boardId, revision: 1, projection: snapshot } }))
  await page.goto(publicPath)
  await expect(page.getByRole("heading", { name: "Published board" })).toBeVisible()
  expect(getWasmRequests()).toBe(0)
  expect(await page.evaluate(() => (window as typeof window & { __publicProbe: unknown }).__publicProbe))
    .toEqual({ workers: 0, wasm: 0, idbOpen: 0 })
})

test("Given an obsolete local route hint for a public board, when private access is unavailable, then read its public copy instead of rejecting the address", async ({ page }) => {
  await page.addInitScript(boardId => {
    localStorage.setItem("tincanban.board-route-index.v1", JSON.stringify({ version: 1, activeIdentityId: "previous-identity",
      identities: { "previous-identity": { [boardId]: "unavailable-workspace" } } }))
  }, boardId)
  await page.route(api, route => route.fulfill({ json: { boardId, revision: 1, projection: snapshot } }))
  await page.goto(`/boards/${boardId}`)
  await expect(page.getByRole("heading", { name: "Published board" })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("button", { name: "Edit board", exact: true })).toHaveCount(0)
})
