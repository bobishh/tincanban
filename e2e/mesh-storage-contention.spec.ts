import { expect, test, type Page } from "./support/coverage"
import { writeFile } from "node:fs/promises"

/** Capture the real app controller in this disposable test profile only. */
async function observeController(page: Page) {
  await page.route("**/src/sync/deviceSyncController.ts*", async route => {
    const response = await route.fetch()
    const source = await response.text()
    const constructor = "constructor(options) {"
    if (!source.includes(constructor)) throw new Error("Controller observation target changed")
    await route.fulfill({ response, body: source.replace(constructor,
      `${constructor}\n(window.__TINCANBAN_BENCH_CONTROLLERS__ ??= []).push(this);`) })
  })
}

async function createBoard(page: Page, index: number) {
  await page.getByRole("button", { name: "Open workspaces", exact: true }).click()
  await page.getByRole("button", { name: "New workspace", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Create workspace", exact: true })
  await dialog.getByLabel("Title", { exact: true }).fill(`Catalog load ${index}`)

  await dialog.getByRole("button", { name: "Create", exact: true }).click()
  await expect(page.getByRole("heading", { name: `TINCANBAN // Catalog load ${index}`, exact: true })).toBeVisible()
}

test("Given three tabs sharing nine boards, when signed catalogs replay, then processing stays bounded and a checklist change remains visible", async ({ context, page }, testInfo) => {
  test.setTimeout(120_000)
  await observeController(page)
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "TINCANBAN // Untitled", exact: true })).toBeVisible()
  for (let index = 1; index < 9; index += 1) await createBoard(page, index)
  await page.getByRole("button", { name: "Add item to To do", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Item details", exact: true })
  await form.getByLabel("Title *", { exact: true }).fill("Catalog pressure checklist")
  await form.getByLabel("Body", { exact: true }).fill("- [ ] Propagate while catalogs replay")
  await form.getByRole("button", { name: "Save item", exact: true }).click()
  await expect(page.getByRole("checkbox")).toHaveCount(1)

  // Real signed member bundles, real Rust validation, real shared IndexedDB.
  // Synthetic identities prevent reading or copying any user's browser data.
  const catalogs = await page.evaluate(async () => {
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const { profileFromIdentitySeedForDevice } = await import("/vendor/meta-mesh/packages/mesh-identity/src/index.ts")
    const { createPeerAdvertisement, createWorkspaceGrant } = await import("/src/sync/meshRecords.ts")
    const { peerStore } = await import("/src/sync/peerStore.ts")
    const { WorkspaceStorage } = await import("/src/storage.ts")
    const profile = await bootstrapIdentity()
    const workspaces = await new WorkspaceStorage().listWorkspaces()
    const members = await Promise.all(Array.from({ length: 7 }, (_, index) =>
      profileFromIdentitySeedForDevice(new Uint8Array(32).fill(index + 1), `Synthetic peer ${index}`,
        new Uint8Array(32).fill(index + 101))))
    const result: Array<{ workspaceId: string; catalog: unknown }> = []
    for (const workspace of workspaces) {
      let credential = await peerStore.getWorkspaceCredential(workspace.id)
      if (!credential) {
        credential = { version: 1, workspaceId: workspace.id, ownerPersonId: profile.identity.personId,
          ownerPublicKey: profile.identity.publicKey, ownerCertificates: [profile.certificate],
          transportSecret: `synthetic-secret-${workspace.id}`, epoch: 1, updatedAt: new Date().toISOString() }
        await peerStore.putWorkspaceCredential(credential)
      }
      const authority = await peerStore.getWorkspaceAuthority(workspace.id)
      const peers = await Promise.all([profile, ...members].map(async (member, index) =>
        createPeerAdvertisement(member, workspace.id, (index + 1).toString(16).padStart(64, "0"), {
          ...(index ? { grant: await createWorkspaceGrant(profile, workspace.id, member.identity.personId, "editor") } : {}),
          ownerPublicKey: profile.identity.publicKey, ownerCertificates: [profile.certificate],
          instanceId: `synthetic-${index}`, userAgent: "mesh-keeper/benchmark",
        })))
      result.push({ workspaceId: workspace.id, catalog: { version: 1, peers,
        deviceRevocations: [], departures: [], revocations: [], ownershipTransfers: [],
        successionVotes: [], successionClaims: [], scopeAuthoritySnapshot: authority?.scopeAuthoritySnapshot } })
    }
    return result
  })
  expect(catalogs).toHaveLength(9)
  const pages = [page, await context.newPage(), await context.newPage()]
  for (const sibling of pages.slice(1)) {
    await observeController(sibling)
    await sibling.goto("/")
    await expect(sibling.getByRole("checkbox")).toHaveCount(1)
  }
  for (const target of pages) {
    await target.evaluate(async () => {
      const { DurableMesh } = await import("/src/sync/durableMesh.ts")
      const controller = (window as any).__TINCANBAN_BENCH_CONTROLLERS__.at(-1)
      const options = controller.meshOptions(controller.meshWorkspaceStore)
      ;(window as any).__TINCANBAN_BENCH_MESH__ = new DurableMesh(options)
    })
  }
  const replay = async () => Promise.all(pages.map(target => target.evaluate(async snapshots => {
    const controller = (window as any).__TINCANBAN_BENCH_CONTROLLERS__.at(-1)
    const mesh = (window as any).__TINCANBAN_BENCH_MESH__
    const before = controller.api().ownershipRevision.value
    const started = performance.now()
    await Promise.all(snapshots.map(snapshot => mesh.mergeWorkspace(snapshot.workspaceId, snapshot.catalog)))
    return { elapsedMs: Math.round(performance.now() - started),
      policyInvalidations: controller.api().ownershipRevision.value - before }
  }, catalogs)))
  await replay() // Import and settle the generated security records.
  await replay() // Settle fingerprints after concurrent initial imports.
  const rounds = []
  for (let round = 0; round < 4; round += 1) {
    const measurements = await replay()
    rounds.push(measurements)
    expect(measurements.every(value => value.policyInvalidations === 0), JSON.stringify(measurements)).toBe(true)
    expect(measurements.every(value => value.elapsedMs < 12_000), JSON.stringify(measurements)).toBe(true)
  }
  const pending = replay()
  const started = Date.now()
  await page.getByRole("checkbox").check()
  await Promise.all(pages.slice(1).map(target => expect(target.getByRole("checkbox")).toBeChecked({ timeout: 3_000 })))
  const deliveryMs = Date.now() - started
  rounds.push(await pending)
  const report = testInfo.outputPath("shared-idb-catalog-benchmark.json")
  await writeFile(report, JSON.stringify({ tabs: 3, boards: 9, membersPerCatalog: 8,
    catalogBytes: catalogs.map(value => Buffer.byteLength(JSON.stringify(value.catalog))), rounds, deliveryMs }, null, 2))
  await testInfo.attach("shared-idb-catalog-benchmark.json", { path: report, contentType: "application/json" })
  await page.screenshot({ path: testInfo.outputPath("checklist-after-catalog-replay.png"), fullPage: true })
  for (const target of pages) await target.evaluate(async () => (window as any).__TINCANBAN_BENCH_MESH__.dispose())
})
