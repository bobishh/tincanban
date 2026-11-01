import { expect, test } from "./support/coverage"

test("Given a loaded Identity route catalog, when the device goes offline before its first export, then signed route data can still round-trip locally", async ({ page, context }) => {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
  await page.evaluate(() => import("/src/sync/identityWorkspaceRouteRecovery.ts"))
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
