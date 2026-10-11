import { expect, test } from "./support/coverage"

const boardId = "public-board-fixture"
const publicOrigin = process.env.TINCANBAN_PUBLIC_E2E_KEEPER_ORIGIN ?? "http://127.0.0.1:47839"
const api = `${publicOrigin}/v1/public/boards/${boardId}`
const fileHash = "A".repeat(43)
const snapshot = {
  kind: "tincanban-public-board", version: 1, board: { id: boardId, title: "Published board" },
  columns: [{ id: "column-a", title: "Doing", rank: "0/1" }],
  fields: [{ id: "field-a", title: "Company", valueType: "text", required: false, rank: "0/1", options: [] }],
  cards: [{ id: "card-a", parentId: null, columnId: "column-a", title: "Public card", body: "**Public body**",
    values: { "field-a": "Example Co" }, rank: "0/1" }, { id: "card-child", parentId: "card-a", columnId: "column-a", title: "Nested card", body: "", values: {}, rank: "1/1" }],
  discussions: [{ id: "discussion-root", threadId: "discussion-root", replyTo: null, targets: [{ type: "card", id: "card-a" }], author: "Public author", createdAt: "2026-10-10T10:00:00Z", body: "Read only discussion" }],
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

for (const width of [390, 1440]) test(`Given an anonymous reader at ${width}px, When a published board is reloaded, Then board content is readable without private startup`, async ({ page, browserName }) => {
  const getWasmRequests = await monitorPrivateStartup(page)
  await page.setViewportSize({ width, height: 900 })
  await page.route(api, route => route.fulfill({ json: { boardId, revision: 3, projection: snapshot }, headers: { "cache-control": "no-store" } }))
  await page.route(`${api}/files/3/${fileHash}`, route => route.fulfill({ body: "public!", headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="handout.txt"', "x-content-type-options": "nosniff" } }))
  await page.goto(`/boards/${boardId}`)
  await expect(page.getByRole("heading", { name: "Published board" })).toBeVisible()
  await page.getByRole("searchbox", { name: "Search cards" }).fill("Example Co")
  await expect(page.getByRole("heading", { name: "Public card" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Nested card" })).toHaveCount(0)
  await page.getByRole("searchbox", { name: "Search cards" }).fill("")
  await expect(page.getByRole("heading", { name: "Nested card" })).toBeVisible()
  await page.getByRole("button", { name: "Read card" }).first().click()
  await expect(page.getByRole("dialog").getByText("Public body")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Discussion" })).toBeVisible()
  await expect(page.getByText("Read only discussion")).toBeVisible()
  await expect(page.getByRole("button", { name: /Edit|Reply|Post/ })).toHaveCount(0)
  await expect(page.getByRole("button", { name: /Chat|Workspace chat|Invite/ })).toHaveCount(0)
  await expect(page.locator('[data-role-stamp="visitor"]')).toHaveCount(0)
  await page.getByRole("button", { name: "Close" }).click()
  const handout = page.getByRole("link", { name: /Handout/ })
  await expect(handout).toHaveAttribute("download", "handout.txt")
  if (browserName !== "webkit") {
    const downloadPromise = page.waitForEvent("download")
    await handout.click()
    expect((await downloadPromise).suggestedFilename()).toBe("handout.txt")
  }
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
  await page.goto(`/boards/${boardId}`)
  await expect(page.getByRole("alert")).toContainText("unavailable")
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible()
  await expect(page.getByRole("button", { name: /Open workspaces|Workspace chat|Menu/ })).toHaveCount(0)
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByRole("heading", { name: "Publication invalid" })).toBeVisible()
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByRole("heading", { name: "Board unavailable" })).toBeVisible()
  expect(requestCount).toBe(3)
  for (const path of ["/boards/!", "/boards/foo/bar", "/boards"]) {
    await page.goto(path)
    await expect(page.getByRole("heading", { name: "Publication invalid" })).toBeVisible()
  }
  expect(await page.evaluate(() => (window as typeof window & { __publicProbe: unknown }).__publicProbe)).toEqual({ workers: 0, wasm: 0, idbOpen: 0 })
  expect(getWasmRequests()).toBe(0)
})
