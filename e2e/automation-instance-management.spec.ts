import { expect, test, type Page, type Route } from "@playwright/test"
import { ensureJobSearchWorkspace } from "./support/workspaces"

const workerOrigin = "https://automation-instance.example.test"
const workerRoute = "automation-instance-route"
const definitionId = "typed-existing-instance"

type Fixture = { workspaceId: string; boardId: string; executorPersonId: string; grantId: string; heads: string[] }
type Scenario = "expired" | "legacy" | "current"

test("Given an expired signed approval while Worker execution is unavailable, When renewing, Then require workspace-read consent and explicit confirmation", async ({ page, baseURL }) => {
  const activations: Array<Record<string, unknown>> = []
  const fixture = await prepareAutomationManagement(page, baseURL!, "expired", activations)
  const automation = await openAutomations(page)
  await expect(automation.getByText("Approval expired", { exact: true })).toBeVisible()
  await expect(automation.getByRole("button", { name: "Renew approval", exact: true })).toBeVisible()
  await automation.getByRole("button", { name: "Renew approval", exact: true }).click()
  const approval = page.getByRole("form", { name: "Confirm automation approval" })
  await expect(approval.getByText(/entire workspace/i)).toBeVisible()
  await expect(approval.getByText(/30 days/i)).toBeVisible()
  const consent = approval.getByRole("checkbox", { name: "Allow Worker to read this workspace", exact: true })
  const confirm = approval.getByRole("button", { name: "Confirm approval", exact: true })
  await expect(consent).not.toBeChecked()
  await expect(confirm).toBeDisabled()
  expect(activations).toHaveLength(0)
  await consent.check()
  await confirm.click()
  await expect.poll(() => activations.length).toBe(1)
  expect(activations[0]).toMatchObject({ adoptLegacy: false, integrationId: workerRoute,
    packet: { version: 2, workspaceId: fixture.workspaceId, definition: { payload: { id: definitionId } },
      grant: { payload: { personId: fixture.executorPersonId } } } })
})

test("Given a legacy Worker identity, When adopting it, Then require explicit consent and reuse its route", async ({ page, baseURL }) => {
  const activations: Array<Record<string, unknown>> = []
  await prepareAutomationManagement(page, baseURL!, "legacy", activations)
  const automation = await openAutomations(page)
  await expect(automation.getByText("Existing Worker · approval required", { exact: true })).toBeVisible()
  await automation.getByRole("button", { name: "Adopt existing Worker", exact: true }).click()
  const approval = page.getByRole("form", { name: "Confirm automation approval" })
  const consent = approval.getByRole("checkbox", { name: "Allow Worker to read this workspace", exact: true })
  const confirm = approval.getByRole("button", { name: "Confirm approval", exact: true })
  await expect(consent).not.toBeChecked()
  await expect(confirm).toBeDisabled()
  expect(activations).toHaveLength(0)
  await consent.check()
  await confirm.click()
  await expect.poll(() => activations.length).toBe(1)
  expect(activations[0]).toMatchObject({ adoptLegacy: true, integrationId: workerRoute,
    packet: { version: 2, definition: { payload: { id: definitionId } } } })
})

test("Given a current approval, When enabling evidence or email, Then each change uses explicit workspace-read consent", async ({ page, baseURL }) => {
  const activations: Array<Record<string, unknown>> = []
  await prepareAutomationManagement(page, baseURL!, "current", activations)
  const automation = await openAutomations(page)

  await automation.getByRole("button", { name: "Enable vacancy evidence", exact: true }).click()
  await confirmDisclosure(page, activations, 0)
  await expect.poll(() => activations.length).toBe(1)

  const refreshed = page.getByRole("article", { name: "Existing intake", exact: true })
  await expect(refreshed.getByRole("button", { name: "Enable email and Applied", exact: true })).toBeVisible()
  await refreshed.getByRole("button", { name: "Enable email and Applied", exact: true }).click()
  await confirmDisclosure(page, activations, 1)
  await expect.poll(() => activations.length).toBe(2)
  expect(activations[0]!.packet).toMatchObject({ definition: { payload: { typeVersion: 2 } } })
  expect(activations[1]!.packet).toMatchObject({ definition: { payload: { typeVersion: 2, parameters: { sources: ["website", "email"] } } } })
})

async function prepareAutomationManagement(page: Page, baseURL: string, scenario: Scenario,
  activations: Array<Record<string, unknown>>): Promise<Fixture> {
  await page.goto(baseURL)
  await ensureJobSearchWorkspace(page)
  const fixture = await page.evaluate(async ({ workerOrigin, definitionId, scenario }) => {
    const { bootstrapIdentity, signEnvelope, publicKeyId, toBase64Url } = await import("/src/domain/identity.ts")
    const { identitySeedFromPrivateKey, profileFromIdentitySeedForDevice } = await import("@meta-uber/mesh-identity")
    const { useTincanban } = await import("/src/state.ts")
    const { automationTypes, parseAutomationDefinition } = await import("/src/domain/automationContract.ts")
    const { automationLifecycle } = await import("/src/domain/automationLifecycle.ts")
    const profile = await bootstrapIdentity()
    const doc = useTincanban().getActiveDoc()
    if (!doc) throw new Error("Workspace is unavailable")
    const board = Object.values(doc.entities).find(entity => entity.kind === "board" && entity.preset?.key === "job-search")
    if (!board || board.kind !== "board") throw new Error("Job-search board is missing")
    const bindings = board.preset.bindings
    const owner = profile
    const rootPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
    const personId = await publicKeyId(toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", rootPair.publicKey))))
    const seed = await identitySeedFromPrivateKey(rootPair.privateKey, personId)
    const executor = await profileFromIdentitySeedForDevice(seed, "Automation executor", new Uint8Array(32).fill(82))
    const grantId = crypto.randomUUID()
    const expiresAt = scenario === "expired" ? 1 : Date.now() + 30 * 24 * 60 * 60 * 1000
    const version = scenario === "current" ? 1 : 2
    const grant = await signEnvelope(owner.privateKeys.devicePrivateKey, {
      kind: "workspace-grant", version: 1, grantId, workspaceId: doc.id, personId: executor.identity.personId,
      role: "automation", accessEpoch: 1, automation: { version, boardId: board.id,
        columns: { lead: bindings["status.lead"], applied: bindings["status.applied"],
          interview: bindings["status.interview"], rejected: bindings["status.rejected"] },
        fieldIds: [bindings["field.company"], bindings["field.role"], bindings["field.url"],
          bindings["field.notes"], bindings["field.sourceText"]], expiresAt },
    }, owner.device.deviceId)
    const automationType = automationTypes.find(value => value.type === "job-intake" && value.version === version)
    if (!automationType) throw new Error("Job intake type unavailable")
    const definition = parseAutomationDefinition({ kind: "automation-definition", version: 1, id: definitionId,
      name: "Existing intake", type: "job-intake", typeVersion: version,
      parameters: { sources: ["website"] }, permissions: automationType.permissions,
      scope: { workspaceId: doc.id, boardId: board.id, grantId },
    })
    const signedDefinition = await signEnvelope(owner.privateKeys.devicePrivateKey, definition, owner.device.deviceId)
    const approval = JSON.stringify({ grant, definition: signedDefinition })
    await useTincanban().executeCommandAsync({ kind: "createAutomation", definition, approval,
      executor: { origin: workerOrigin, personId: executor.identity.personId } })
    const entity = useTincanban().getActiveDoc()!.entities[`automation:${definitionId}`]
    if (entity?.kind !== "automation") throw new Error("Automation fixture was not stored")
    const heads = automationLifecycle(entity).heads
    Reflect.set(window, "__automationInstanceTarget", executor)
    Reflect.set(window, "__automationInstanceFixture", { workspaceId: doc.id, boardId: board.id,
      executorPersonId: executor.identity.personId, grantId, heads })
    return { workspaceId: doc.id, boardId: board.id, executorPersonId: executor.identity.personId, grantId, heads }
  }, { workerOrigin, definitionId, scenario })

  await page.route(`${workerOrigin}/**`, async (route: Route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" } })
      return
    }
    const url = new URL(route.request().url())
    if (url.pathname === "/v2/capabilities") {
      await fulfillWorkerJson(route, { origin: workerOrigin, version: 2,
        instanceManagement: { version: 1, actions: ["discover", "identity", "activate"] },
        applicationReview: { version: 1, actions: ["discover", "list"] } })
      return
    }
    if (url.pathname === "/v2/automation-instances/discover") {
      await fulfillWorkerJson(route, { origin: workerOrigin, workspaceId: fixture.workspaceId, definitionId,
        executorPersonId: fixture.executorPersonId, integrations: [{ integrationId: workerRoute }] })
      return
    }
    if (url.pathname === "/v2/automation-instances/identity") {
      const request = route.request().postDataJSON() as { instanceRequest: { signed: { payload: { nonce: string } } } }
      const nonce = request.instanceRequest.signed.payload.nonce
      const proof = await page.evaluate(async ({ nonce, workerOrigin, workerRoute, definitionId, scenario }) => {
        const { resolveSigningContext } = await import("/src/domain/signingContext.ts")
        const { createAutomationInstanceIdentity } = await import("/src/domain/automationInstanceIdentity.ts")
        const target = Reflect.get(window, "__automationInstanceTarget")
        const fixture = Reflect.get(window, "__automationInstanceFixture") as Fixture
        const isLegacy = scenario === "legacy"
        const description = { workspaceId: fixture.workspaceId, boardId: fixture.boardId,
          definitionId: isLegacy ? null : definitionId, executorPersonId: fixture.executorPersonId,
          grantId: fixture.grantId, expiresAt: scenario === "expired" ? 1 : Date.now() + 30 * 24 * 60 * 60 * 1000,
          state: "active" as const, adoptionRequired: isLegacy }
        const binding = { origin: workerOrigin, workspaceId: fixture.workspaceId, definitionId, integrationId: workerRoute }
        const context = await resolveSigningContext({ profile: target, certificates: [], purpose: "automation-instance-identity",
          binding, authorityRevision: "e2e-owner", current: async () => ({ personId: target.identity.personId,
            deviceId: target.device.deviceId, authorityRevision: "e2e-owner" }) })
        return createAutomationInstanceIdentity(context, { ...binding, requestNonce: nonce, description })
      }, { nonce, workerOrigin, workerRoute, definitionId, scenario })
      await fulfillWorkerJson(route, proof)
      return
    }
    if (url.pathname === "/v2/automation-instances/activate") {
      const activation = route.request().postDataJSON() as { body: Record<string, unknown> }
      activations.push(activation.body)
      const packet = activation.body.packet as { grant?: { payload?: { grantId?: string } } } | undefined
      if (packet?.grant?.payload?.grantId) {
        await page.evaluate(grantId => {
          const fixture = Reflect.get(window, "__automationInstanceFixture") as Fixture
          Reflect.set(window, "__automationInstanceFixture", { ...fixture, grantId })
        }, packet.grant.payload.grantId)
      }
      await fulfillWorkerJson(route, { status: "active", synced: true })
      return
    }
    if (url.pathname === "/v2/application-review/discover") {
      await fulfillWorkerJson(route, { origin: workerOrigin, workspaceId: fixture.workspaceId, definitionId,
        integrations: [{ integrationId: workerRoute, personId: fixture.executorPersonId }] })
      return
    }
    if (url.pathname === "/v2/application-review/list") {
      if (scenario !== "current") {
        await fulfillWorkerJson(route, { error: "Worker execution unavailable in this acceptance fixture" }, 503)
        return
      }
      const request = route.request().postDataJSON() as { reviewRequest: { signed: { payload: { nonce: string } } } }
      const nonce = request.reviewRequest.signed.payload.nonce
      const mailbox = await page.evaluate(async ({ nonce, workerOrigin, workerRoute, definitionId }) => {
        const { signEnvelope } = await import("/src/domain/identity.ts")
        const target = Reflect.get(window, "__automationInstanceTarget")
        const fixture = Reflect.get(window, "__automationInstanceFixture") as Fixture
        const payload = { kind: "automation-observation", version: 1, origin: workerOrigin,
          integrationId: definitionId, workspaceId: fixture.workspaceId, grantId: fixture.grantId, nonce,
          issuedAt: Date.now(), state: "active", heads: fixture.heads }
        const observation = { publicKey: target.identity.publicKey, certificates: [target.certificate],
          signed: await signEnvelope(target.privateKeys.devicePrivateKey, payload, target.device.deviceId) }
        return { origin: workerOrigin, workspaceId: fixture.workspaceId, definitionId, integrationId: workerRoute,
          route: { address: "intake@example.test", mailbox: "owner@example.test" },
          receipt: { confirmation: null, events: [] }, observation }
      }, { nonce, workerOrigin, workerRoute, definitionId })
      await fulfillWorkerJson(route, mailbox)
      return
    }
    await fulfillWorkerJson(route, { error: "Worker execution unavailable in this acceptance fixture" }, 503)
  })
  return fixture
}

async function fulfillWorkerJson(route: Route, json: unknown, status = 200) {
  await route.fulfill({ status, body: JSON.stringify(json), headers: { "content-type": "application/json",
    "access-control-allow-origin": "*" } })
}

async function openAutomations(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await settings.getByRole("tab", { name: "Workspace", exact: true }).click()
  return settings.getByRole("region", { name: "Automations", exact: true })
}

async function confirmDisclosure(page: Page, activations: Array<Record<string, unknown>>, priorCalls: number) {
  const approval = page.getByRole("form", { name: "Confirm automation approval" })
  const consent = approval.getByRole("checkbox", { name: "Allow Worker to read this workspace", exact: true })
  const confirm = approval.getByRole("button", { name: "Confirm approval", exact: true })
  await expect(consent).not.toBeChecked()
  await expect(confirm).toBeDisabled()
  expect(activations).toHaveLength(priorCalls)
  await consent.check()
  await confirm.click()
  await expect(approval).toBeHidden()
}
