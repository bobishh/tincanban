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


test("Given a route worker request is pending, when Rejected opens and closes, then the board responds before the worker replies", async ({ page }) => {
  await page.addInitScript(() => {
    const BrowserWorker = Worker
    window.Worker = class extends BrowserWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        if (options?.name !== "identity-workspace-routes") return
        const send = this.postMessage.bind(this)
        this.postMessage = message => {
          if (message.operation?.kind !== "pack") { send(message); return }
          document.documentElement.dataset.routeWorker = "pending"
          window.addEventListener("release-test-route-worker", () => send(message), { once: true })
        }
      }
    }
  })
  await page.goto("/")
  await createJobSearchWorkspace(page, "Route load")
  await page.getByRole("button", { name: "Collapse Rejected", exact: true }).click()
  await page.evaluate(async () => {
    const { identityWorkspaceRouteRecoveryComponent } = await import("/src/sync/identityWorkspaceRouteRecovery.ts")
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const owner = await bootstrapIdentity()
    const personId = owner.identity.personId
    const value = { personId, envelopes: [{ version: 1 as const, workspaceId: "worker-board",
      ownerPersonId: personId, ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate],
      transportSecret: "worker-board-secret", epoch: 1, peers: [] }] }
    void identityWorkspaceRouteRecoveryComponent(value).then(
      () => { document.documentElement.dataset.routeWorker = "completed" },
      () => { document.documentElement.dataset.routeWorker = "failed" },
    )
  })
  await expect(page.locator("html")).toHaveAttribute("data-route-worker", "pending")
  await page.getByRole("button", { name: /Open Rejected with/ }).click()
  await page.getByRole("button", { name: "Collapse Rejected", exact: true }).click()
  await expect(page.getByRole("button", { name: /Open Rejected with/ })).toBeVisible()
  await expect(page.locator("html")).toHaveAttribute("data-route-worker", "pending")
  await page.evaluate(() => window.dispatchEvent(new Event("release-test-route-worker")))
  await expect(page.locator("html")).toHaveAttribute("data-route-worker", "completed")
})
