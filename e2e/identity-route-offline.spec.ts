import { expect, test } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

test("Given a loaded Identity route catalog, when the device goes offline before its first export, then signed route data can still round-trip locally", async ({ page, context }) => {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
  await page.evaluate(async () => (await import("/src/sync/identityWorkspaceRouteWorkerClient.ts")).warmIdentityWorkspaceRoutes())
  await context.setOffline(true)
  const routes = await page.evaluate(async () => {
    const { identityWorkspaceRouteRecoveryComponent, readIdentityWorkspaceRouteRecoveryComponent } =
      await import("/src/sync/identityWorkspaceRouteRecovery.ts")
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const owner = await bootstrapIdentity()
    const value = { personId: owner.identity.personId, envelopes: [{ version: 1 as const, workspaceId: "offline-board",
      ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate],
      transportSecret: "offline-route-secret", epoch: 1, peers: [] }] }
    const component = await identityWorkspaceRouteRecoveryComponent(value)
    return { value, restored: await readIdentityWorkspaceRouteRecoveryComponent({ personId: value.personId,
      components: { workspaceRouteRecovery: component } }) }
  })
  expect(routes.restored).toEqual(routes.value)
})

test("Given the Identity route worker is loading, when Rejected opens and closes, then the board responds before the worker is ready", async ({ page, context }) => {
  const requested = Promise.withResolvers<void>()
  const allowWorker = Promise.withResolvers<void>()
  await context.route(/\/identityWorkspaceRouteWorker\.ts(?:\?|$)/, async route => {
    requested.resolve()
    await allowWorker.promise
    await route.continue()
  })
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await requested.promise
    await createJobSearchWorkspace(page, "Route load")
    const collapse = page.getByRole("button", { name: "Collapse Rejected", exact: true })
    const expand = page.getByRole("button", { name: /Open Rejected with/ })
    await collapse.click()
    await expand.click()
    await collapse.click()
    await expect(expand).toBeVisible()
  } finally {
    allowWorker.resolve()
  }
  await page.evaluate(async () => (await import("/src/sync/identityWorkspaceRouteWorkerClient.ts")).warmIdentityWorkspaceRoutes())
})
