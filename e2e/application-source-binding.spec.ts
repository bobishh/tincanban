import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { expect, test, type Page } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"
import { startRustyService } from "./support/rustyService"

const integrationId = "e2e"
const operatorToken = "automation-e2e-provisioning-token-with-at-least-32-bytes"
const company = "Nacre Light Integration GmbH"
const originalRole = "Principal Systems Engineer"
const jobUrl = "https://jobs.example.test/nacre/systems"

type WorkspaceBindings = {
  workspaceId: string
  boardId: string
  columns: { lead: string; applied: string; interview: string; rejected: string }
  fieldIds: { company: string; role: string; jobUrl: string; notes: string; sourceText: string }
}

type ApplicationFixture = WorkspaceBindings & {
  workerOrigin: string
  privateAddress: string
  close: () => Promise<void>
}

test("Given an extracted posting, when display labels change and its URL later returns 404, then retain original evidence", async ({ page, baseURL }) => {
  test.setTimeout(180_000)
  const fixture = await createApplicationFixture(page, baseURL!)
  try {
    const cardId = await submitApplication(fixture, {
      company,
      role: "Display Platform Architect",
      jobUrl,
      message: `${company} is hiring a ${originalRole}. Build and operate distributed systems.`,
      idempotencyKey: "source-original-posting",
    })
    await syncFromRusty(page)
    await patchCard(page, fixture, cardId, "Edited display title", "Edited display role")
    const detail = await openApplicationDetail(page, "Edited display title")
    const source = detail.getByRole("region", { name: "Original posting evidence" })
    await expect(source.getByText("Original posting title", { exact: true })).toBeVisible()
    await expect(source).toContainText(originalRole)
    await expect(source).toContainText(company)

    // Planned E2E-only fetch fixture: return changed posting content, then an actual 404 for the same URL.
    await setJobPage(fixture.workerOrigin, { url: jobUrl, status: 200,
      html: '<script type="application/ld+json">{"@type":"JobPosting","title":"Generic Infrastructure Role","hiringOrganization":{"name":"Nacre Light Integration GmbH"}}</script>' })
    await source.getByRole("button", { name: "Refresh posting evidence", exact: true }).click()
    await expect(source).toContainText("Generic Infrastructure Role")
    await expect(source.getByText(originalRole, { exact: true })).toBeVisible()

    await setJobPage(fixture.workerOrigin, { url: jobUrl, status: 404 })
    await source.getByRole("button", { name: "Refresh posting evidence", exact: true }).click()
    await expect(source).toContainText("Posting page not found")
    await expect(source.getByText(originalRole, { exact: true })).toBeVisible()
    await expect(detail.getByText("Edited display role", { exact: true })).toBeVisible()
  } finally { await fixture.close() }
})

test("Given a legacy application with no source record, when a generic rejection arrives, then keep evidence pending and do not invent an original title", async ({ page, baseURL }) => {
  test.setTimeout(180_000)
  const fixture = await createApplicationFixture(page, baseURL!)
  try {
    await createLegacyApplication(page, fixture, "Legacy Platform Role")
    const detail = await openApplicationDetail(page, `${company} — Legacy Platform Role`)
    const source = detail.getByRole("region", { name: "Original posting evidence" })
    await expect(source).toContainText("Original posting evidence pending")
    await expect(source).toContainText("Original posting title unavailable")
    await expect(source.getByText("Legacy Platform Role", { exact: true })).toHaveCount(0)
    await page.getByRole("button", { name: "Close detail" }).click()

    const messageId = "<legacy-source-review@example.test>"
    const eventId = await submitForwardedMail(fixture, messageId,
      `Application update: ${company}`, `Thank you for applying to ${company}. We decided to proceed with other candidates.`)
    const review = await waitForStatus(fixture.workerOrigin, eventId, "review")
    expect(review).toMatchObject({ result: { reason: expect.stringMatching(/source|original posting/i) } })
    await syncFromRusty(page)
    await expect(page.getByRole("region", { name: "Applied", exact: true })
      .getByRole("button", { name: `Open ${company} — Legacy Platform Role`, exact: true })).toBeVisible()
  } finally { await fixture.close() }
})

test("Given two same-company original postings and a role-free retained rejection, when the owner binds one candidate, then stale workflow rejects retry", async ({ page, baseURL }) => {
  test.setTimeout(180_000)
  const fixture = await createApplicationFixture(page, baseURL!)
  try {
    const firstCard = await submitApplication(fixture, { company, role: "Display Role One", jobUrl,
      message: `${company} is hiring a ${originalRole}.`, idempotencyKey: "source-ambiguous-one" })
    const secondCard = await submitApplication(fixture, { company, role: "Display Role Two", jobUrl,
      message: `${company} is hiring a ${originalRole}.`, idempotencyKey: "source-ambiguous-two" })
    await syncFromRusty(page)
    await patchCard(page, fixture, firstCard, `${company} — Display Role One`, "Display Role One", fixture.columns.applied)
    await patchCard(page, fixture, secondCard, `${company} — Display Role Two`, "Display Role Two", fixture.columns.applied)

    const messageId = "<ambiguous-source-binding@example.test>"
    const eventId = await submitForwardedMail(fixture, messageId, `Application update: ${company}`,
      `Thank you for applying to ${company}. We decided to proceed with other candidates.`)
    const review = await waitForStatus(fixture.workerOrigin, eventId, "review")
    expect(review).toMatchObject({ result: { reason: expect.stringMatching(/ambiguous|role|application/i) } })
    await syncFromRusty(page)
    await expectApplicationInColumn(page, "Applied", firstCard)
    await expectApplicationInColumn(page, "Applied", secondCard)

    const subject = `Application update: ${company}`
    const event = await openEmailReview(page, subject)
    await expect(event).toContainText("Needs review")
    await expect(event).toContainText("Choose an application; this will not edit the card title")
    await event.getByRole("button", { name: "Bind to application", exact: true }).click()
    const binding = page.getByRole("dialog", { name: "Bind retained email to application" })
    await binding.getByRole("group", { name: "Application candidates" })
      .getByRole("button", { name: `${company} — Display Role One`, exact: true }).click()
    await binding.getByRole("button", { name: "Save binding", exact: true }).click()
    await expect(event).toContainText("Owner binding saved")

    // Workflow changes after the owner signs. Retry must re-check the captured workflow precondition.
    await patchCard(page, fixture, firstCard, `${company} — Display Role One`, "Display Role One", fixture.columns.interview)
    await syncFromRusty(page)
    await event.getByRole("button", { name: "Retry processing", exact: true }).click()
    await expect.poll(async () => {
      const afterRetry = await readEvent(fixture.workerOrigin, eventId)
      return (afterRetry.result as { reason?: string } | undefined)?.reason
    }, { timeout: 45_000 }).toMatch(/Application workflow changed; event requires review/)
    await syncFromRusty(page)
    await expectApplicationInColumn(page, "Interview", firstCard)
    await expectApplicationInColumn(page, "Applied", secondCard)
  } finally { await fixture.close() }
})

test("Given two same-company postings and an ambiguous retained rejection, when the owner binds and retries, then move only the chosen application once", async ({ page, baseURL }) => {
  test.setTimeout(180_000)
  const fixture = await createApplicationFixture(page, baseURL!)
  try {
    const firstCard = await submitApplication(fixture, { company, role: "Display Role One", jobUrl,
      message: `${company} is hiring a ${originalRole}.`, idempotencyKey: "source-binding-success-one" })
    const secondCard = await submitApplication(fixture, { company, role: "Display Role Two", jobUrl,
      message: `${company} is hiring a ${originalRole}.`, idempotencyKey: "source-binding-success-two" })
    const firstLabel = `${company} — Display Role One`
    const secondLabel = `${company} — Display Role Two`
    await syncFromRusty(page)
    await patchCard(page, fixture, firstCard, firstLabel, "Display Role One", fixture.columns.applied)
    await patchCard(page, fixture, secondCard, secondLabel, "Display Role Two", fixture.columns.applied)

    const messageId = "<successful-source-binding@example.test>"
    const subject = `Application update: ${company}`
    const eventId = await submitForwardedMail(fixture, messageId, subject,
      `Thank you for applying to ${company}. We decided to proceed with other candidates.`)
    const review = await waitForStatus(fixture.workerOrigin, eventId, "review")
    expect(review).toMatchObject({ status: "review", result: { reason: expect.stringMatching(/ambiguous|role|application/i) } })
    await syncFromRusty(page)
    await expectApplicationInColumn(page, "Applied", firstCard)
    await expectApplicationInColumn(page, "Applied", secondCard)

    const event = await openEmailReview(page, subject)
    await event.getByRole("button", { name: "Bind to application", exact: true }).click()
    const binding = page.getByRole("dialog", { name: "Bind retained email to application" })
    await binding.getByRole("group", { name: "Application candidates" }).getByRole("button", { name: firstLabel, exact: true }).click()
    await binding.getByRole("button", { name: "Save binding", exact: true }).click()
    await expect(event).toContainText("Owner binding saved")
    await event.getByRole("button", { name: "Retry processing", exact: true }).click()
    await expect.poll(async () => (await readEvent(fixture.workerOrigin, eventId)).status, { timeout: 45_000 }).toBe("applied")
    expect(await readEvent(fixture.workerOrigin, eventId)).toMatchObject({ status: "applied" })

    const sourceBeforeReplay = await readApplicationSources(page, [firstCard, secondCard])
    await syncFromRusty(page)
    await expectApplicationInColumn(page, "Rejected", firstCard)
    await expectApplicationInColumn(page, "Applied", secondCard)
    await expect(page.getByRole("region", { name: "Rejected", exact: true })
      .getByRole("button", { name: `Open ${firstLabel}`, exact: true })).toBeVisible()
    await expect(page.getByRole("region", { name: "Applied", exact: true })
      .getByRole("button", { name: `Open ${secondLabel}`, exact: true })).toBeVisible()

    // Replaying the same signed retry is an idempotent read of the completed event.
    const replay = await page.evaluate(async ({ origin, workspaceId, eventId }) => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { retryAutomationEmail } = await import("/src/app/automationClient.ts")
      return retryAutomationEmail(await bootstrapIdentity(), { origin, integrationId: "e2e", workspaceId }, eventId)
    }, { origin: fixture.workerOrigin, workspaceId: fixture.workspaceId, eventId })
    expect(replay).toMatchObject({ eventId, status: "applied", duplicate: true })
    await expect.poll(async () => (await readEvent(fixture.workerOrigin, eventId)).status).toBe("applied")
    expect(await readApplicationSources(page, [firstCard, secondCard])).toEqual(sourceBeforeReplay)
    await expectApplicationInColumn(page, "Rejected", firstCard)
    await expectApplicationInColumn(page, "Applied", secondCard)
    const retainedEvent = await openEmailReview(page, subject)
    await expect(retainedEvent).toContainText(subject)
  } finally { await fixture.close() }
})

test("Given a saved owner binding, when its automation grant is revoked before retry, then the retained event cannot move a card", async ({ page, baseURL }) => {
  test.setTimeout(180_000)
  const fixture = await createApplicationFixture(page, baseURL!)
  try {
    const firstCard = await submitApplication(fixture, { company, role: "Display Role One", jobUrl,
      message: `${company} is hiring a ${originalRole}.`, idempotencyKey: "source-grant-one" })
    const secondCard = await submitApplication(fixture, { company, role: "Display Role Two", jobUrl,
      message: `${company} is hiring a ${originalRole}.`, idempotencyKey: "source-grant-two" })
    await syncFromRusty(page)
    await patchCard(page, fixture, firstCard, `${company} — Display Role One`, "Display Role One", fixture.columns.applied)
    await patchCard(page, fixture, secondCard, `${company} — Display Role Two`, "Display Role Two", fixture.columns.applied)
    const eventId = await submitForwardedMail(fixture, "<revoked-grant-binding@example.test>", `Application update: ${company}`,
      `Thank you for applying to ${company}. We decided to proceed with other candidates.`)
    await waitForStatus(fixture.workerOrigin, eventId, "review")
    await syncFromRusty(page)

    const subject = `Application update: ${company}`
    const event = await openEmailReview(page, subject)
    await event.getByRole("button", { name: "Bind to application", exact: true }).click()
    const binding = page.getByRole("dialog", { name: "Bind retained email to application" })
    await binding.getByRole("group", { name: "Application candidates" })
      .getByRole("button", { name: `${company} — Display Role One`, exact: true }).click()
    await binding.getByRole("button", { name: "Save binding", exact: true }).click()
    await expect(event).toContainText("Owner binding saved")

    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const settings = page.getByRole("dialog", { name: "Settings", exact: true })
    await settings.getByRole("tab", { name: "Workspace", exact: true }).click()
    const automation = settings.getByRole("article", { name: "Application source E2E", exact: true })
    await automation.getByRole("button", { name: "Enable vacancy evidence", exact: true }).click()
    await expect.poll(() => page.evaluate(async () => {
      const { useTincanban } = await import("/src/state.ts")
      const doc = useTincanban().getActiveDoc()!
      const record = Object.values(doc.entities).find(value => value.kind === "automation" && value.title === "Application source E2E")
      if (record?.kind !== "automation") return null
      const approval = JSON.parse(record.approval) as { definition: { payload: { typeVersion: number } }; grant: { payload: { automation: { version: number } } } }
      return [approval.definition.payload.typeVersion, approval.grant.payload.automation.version]
    })).toEqual([2, 2])
    await automation.getByRole("button", { name: "Remove", exact: true }).click()
    await automation.getByRole("button", { name: "Confirm removal", exact: true }).click()
    await expect(automation.getByText("Removed · confirmed by Worker", { exact: true })).toBeVisible()
    await settings.getByRole("button", { name: "Dismiss", exact: true }).click()
    await expect(page.evaluate(async ({ origin, workspaceId, eventId }) => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { retryAutomationEmail } = await import("/src/app/automationClient.ts")
      return retryAutomationEmail(await bootstrapIdentity(), { origin, integrationId: "e2e", workspaceId }, eventId)
    }, { origin: fixture.workerOrigin, workspaceId: fixture.workspaceId, eventId })).rejects.toThrow()
    const retainedEvent = await openEmailReview(page, subject)
    await expect(retainedEvent).toContainText("Needs review")
    const afterRetry = await waitForStatus(fixture.workerOrigin, eventId, "review")
    expect(afterRetry).toMatchObject({ status: "review" })
    await syncFromRusty(page)
    await expectApplicationInColumn(page, "Applied", firstCard)
    await expectApplicationInColumn(page, "Applied", secondCard)
  } finally { await fixture.close() }
})

async function createApplicationFixture(page: Page, baseURL: string): Promise<ApplicationFixture> {
  const workerDirectory = await mkdtemp(join(tmpdir(), "application-source-worker-"))
  let worker: ChildProcess | undefined
  let rusty: Awaited<ReturnType<typeof startRustyService>> | undefined
  try {
    const workerService = await startWorker(workerDirectory, baseURL)
    worker = workerService.process
    await page.goto(baseURL)
    await ensureJobSearchWorkspace(page)
    const trustedOwner = await page.evaluate(async () => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const profile = await bootstrapIdentity()
      return { identity: profile.identity, allowedControllerDeviceIds: [profile.device.deviceId] }
    })
    rusty = await startRustyService(trustedOwner, baseURL)
    await connectRusty(page, rusty.origin)
    const workspace = await inspectWorkspace(page)
    const configured = await configureWorker(workerService.origin, workspace, trustedOwner.identity.personId)
    expect(configured.status).toBe(200)
    const workerIdentityResponse = await fetch(`${workerService.origin}/v1/integrations/${integrationId}/identity`, {
      method: "POST", headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(workerIdentityResponse.status).toBe(200)
    const workerIdentity = await workerIdentityResponse.json() as Record<string, unknown>
    const activation = await page.evaluate(async identity => {
      const { useTincanban } = await import("/src/state.ts")
      const { readLocal } = await import("/src/localDb.ts")
      const { exportApprovedAutomation } = await import("/src/app/automationActivation.ts")
      const app = useTincanban()
      const personId = app.getCurrentProfile()!.identity.personId
      const configs = JSON.parse(await readLocal(`tincanban.blind-replicas.v1.${personId}`) ?? "[]") as Array<{ workspaceId: string }>
      const config = configs.find(value => value.workspaceId === app.getActiveDoc()!.id)
      if (!config) throw new Error("Rusty local access missing")
      return JSON.parse(await exportApprovedAutomation(app, config, JSON.stringify(identity), {
        name: "Application source E2E", type: "job-intake", typeVersion: 1, parameters: { sources: ["website"] },
      })) as Record<string, unknown>
    }, workerIdentity)
    const activated = await fetch(`${workerService.origin}/v1/integrations/${integrationId}/activation`, {
      method: "PUT", headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" }, body: JSON.stringify(activation),
    })
    expect(activated.status, await activated.clone().text()).toBe(200)
    const entityId = (activation as { definition?: { payload?: { id?: string } } }).definition?.payload?.id
    if (!entityId) throw new Error("Activated application automation has no identifier")
    const privateAddress = `applications-${"b".repeat(32)}@example.test`
    const emailRoute = await fetch(`${workerService.origin}/__test/configure`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...workspace, ownerPersonId: trustedOwner.identity.personId,
        privateEmailRoutes: [{ id: entityId, address: privateAddress, mailbox: "owner@example.test" }] }),
    })
    expect(emailRoute.status, await emailRoute.clone().text()).toBe(200)
    await page.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Close", exact: true }).click()
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const settings = page.getByRole("dialog", { name: "Settings", exact: true })
    await settings.getByRole("tab", { name: "Workspace", exact: true }).click()
    const automation = settings.getByRole("article", { name: "Application source E2E", exact: true })
    const enableEmail = automation.getByRole("button", { name: "Enable email and Applied", exact: true })
    await expect(enableEmail).toBeVisible({ timeout: 45_000 })
    await enableEmail.click()
    await expect(automation.getByText("Email enabled · Waiting for first email", { exact: true })).toBeVisible({ timeout: 30_000 })
    await settings.getByRole("button", { name: "Dismiss", exact: true }).click()
    return { ...workspace, workerOrigin: workerService.origin, privateAddress, close: async () => {
      await stopProcess(worker)
      await rusty?.close()
      await rm(workerDirectory, { recursive: true, force: true })
    } }
  } catch (error) {
    await stopProcess(worker)
    await rusty?.close()
    await rm(workerDirectory, { recursive: true, force: true })
    throw error
  }
}

async function startWorker(directory: string, browserOrigin: string): Promise<{ origin: string; process: ChildProcess }> {
  const port = await unusedPort()
  const config = resolve("workers/automation/wrangler.e2e.jsonc")
  const executable = resolve("workers/automation/node_modules/.bin/wrangler")
  const child = spawn(executable, ["dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--config", config,
    "--persist-to", directory, "--var", `CORS_ORIGINS:${browserOrigin}`], {
    cwd: resolve("workers/automation"), detached: process.platform !== "win32",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"],
  })
  const origin = `http://127.0.0.1:${port}`
  const startedAt = Date.now()
  let output = ""
  let spawnError: Error | undefined
  child.once("error", error => { spawnError = error })
  child.stdout?.on("data", chunk => { output += chunk.toString() })
  child.stderr?.on("data", chunk => { output += chunk.toString() })
  while (Date.now() - startedAt < 45_000) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null) throw new Error(`Automation Worker exited ${child.exitCode}: ${output}`)
    try { if ((await fetch(`${origin}/health`)).ok) return { origin, process: child } } catch { /* Wait for local workerd. */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200))
  }
  await stopProcess(child)
  throw new Error(`Automation Worker did not become ready: ${output}`)
}

async function configureWorker(origin: string, workspace: WorkspaceBindings, ownerPersonId: string): Promise<Response> {
  return fetch(`${origin}/__test/configure`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...workspace, ownerPersonId, emailAddress: "applications@example.test" }) })
}

async function inspectWorkspace(page: Page): Promise<WorkspaceBindings> {
  return page.evaluate(async () => {
    const { useTincanban } = await import("/src/state.ts")
    const app = useTincanban()
    await app.whenReady()
    const doc = app.getActiveDoc()
    if (!doc) throw new Error("Job-search board is missing")
    const board = Object.values(doc.entities).find(entity => entity.kind === "board" && entity.preset?.key === "job-search")
    if (!board || board.kind !== "board") throw new Error("Job-search board is missing")
    const bindings = board.preset.bindings
    return { workspaceId: doc.id, boardId: board.id,
      columns: { lead: bindings["status.lead"], applied: bindings["status.applied"], interview: bindings["status.interview"], rejected: bindings["status.rejected"] },
      fieldIds: { company: bindings["field.company"], role: bindings["field.role"], jobUrl: bindings["field.url"],
        notes: bindings["field.notes"], sourceText: bindings["field.sourceText"] } }
  })
}

async function connectRusty(page: Page, origin: string): Promise<void> {
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  await page.getByRole("tab", { name: "Rusty", exact: true }).click()
  const panel = page.getByRole("region", { name: "Rusty", exact: true })
  await panel.getByRole("button", { name: "Add Rusty", exact: true }).click()
  await panel.getByLabel("Address", { exact: true }).fill(origin)
  await panel.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(panel.getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })
}

async function submitApplication(fixture: ApplicationFixture, input: { company: string; role: string; jobUrl: string; message: string; idempotencyKey: string }): Promise<string> {
  const challengeResponse = await fetch(`${fixture.workerOrigin}/v1/challenge`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ integrationId }) })
  expect(challengeResponse.status).toBe(200)
  const challenge = await challengeResponse.json() as { token: string; prompt: string }
  const numbers = challenge.prompt.match(/\d+/g)?.map(Number) ?? []
  expect(numbers).toHaveLength(2)
  const response = await fetch(`${fixture.workerOrigin}/v1/intake/${integrationId}`, {
    method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": input.idempotencyKey },
    body: JSON.stringify({ ...input, contact: "application-source@example.test", humanCheckToken: challenge.token,
      humanCheckAnswer: String(numbers[0]! + numbers[1]!) }),
  })
  expect(response.status, await response.clone().text()).toBe(202)
  const accepted = await response.json() as { eventId: string }
  const event = await waitForStatus(fixture.workerOrigin, accepted.eventId, "applied")
  const result = event.result as { action?: { cardId?: string } } | undefined
  if (!result?.action?.cardId) throw new Error("Website application event did not create a card")
  return result.action.cardId
}

async function createLegacyApplication(page: Page, fixture: ApplicationFixture, role: string): Promise<string> {
  const cardId = `legacy-application-${crypto.randomUUID()}`
  await page.evaluate(async ({ cardId, companyName, roleName, parentId, fieldIds }) => {
    const { useTincanban } = await import("/src/state.ts")
    await useTincanban().executeCommandAsync({ kind: "createItem", id: cardId, parentId,
      title: `${companyName} — ${roleName}`, values: { [fieldIds.company]: companyName, [fieldIds.role]: roleName } })
  }, { cardId, companyName: company, roleName: role, parentId: fixture.columns.applied, fieldIds: fixture.fieldIds })
  return cardId
}

async function patchCard(page: Page, fixture: ApplicationFixture, cardId: string, title: string, role: string, parentId?: string): Promise<void> {
  await page.evaluate(async ({ cardId, title, role, parentId, roleField }) => {
    const { useTincanban } = await import("/src/state.ts")
    await useTincanban().executeCommandAsync({ kind: "patchItem", entityId: cardId, title,
      ...(parentId ? { parentId } : {}), values: { [roleField]: role } })
  }, { cardId, title, role, parentId, roleField: fixture.fieldIds.role })
}

async function openApplicationDetail(page: Page, cardName: string) {
  await page.getByRole("button", { name: `Open ${cardName}`, exact: true }).click()
  const detail = page.getByRole("dialog", { name: "Lead details" })
  await expect(detail).toBeVisible()
  return detail
}

async function expectApplicationInColumn(page: Page, column: string, cardId: string): Promise<void> {
  const target = page.getByRole("region", { name: column, exact: true })
  await expect(target.locator(`[data-item-id="${cardId}"]`)).toBeVisible()
}

async function syncFromRusty(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  await page.getByRole("tab", { name: "Rusty", exact: true }).click()
  const panel = page.getByRole("region", { name: "Rusty", exact: true })
  const sync = panel.getByRole("button", { name: "Sync now", exact: true })
  await sync.click()
  await expect(sync).toBeEnabled({ timeout: 20_000 })
  await page.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Close", exact: true }).click()
}

async function submitForwardedMail(fixture: ApplicationFixture, messageId: string, subject: string, text: string): Promise<string> {
  const raw = ["From: owner@example.test", `To: ${fixture.privateAddress}`, `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`, `Subject: ${subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", text, ""].join("\r\n")
  const received = await fetch(`${fixture.workerOrigin}/__test/email`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "owner@example.test", to: fixture.privateAddress, raw }) })
  expect(received.status, await received.clone().text()).toBe(202)
  return createHash("sha256").update(`${integrationId}:email:${messageId}`).digest("base64url")
}

async function openEmailReview(page: Page, subject: string) {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await settings.getByRole("tab", { name: "Workspace", exact: true }).click()
  const automation = settings.getByRole("article", { name: "Application source E2E", exact: true })
  const events = automation.getByRole("list", { name: "Recent email processing" })
  const item = events.getByRole("listitem").filter({ hasText: subject })
  await expect(item).toBeVisible({ timeout: 45_000 })
  return item
}

async function waitForStatus(origin: string, eventId: string, status: "applied" | "review"): Promise<Record<string, unknown>> {
  await expect.poll(async () => (await readEvent(origin, eventId)).status, { timeout: 45_000 }).toBe(status)
  return readEvent(origin, eventId)
}

async function readEvent(origin: string, eventId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${origin}/v1/integrations/${integrationId}/events/${eventId}`, {
    headers: { authorization: `Bearer ${operatorToken}` },
  })
  if (!response.ok) return { status: `http-${response.status}` }
  return await response.json() as Record<string, unknown>
}

async function readApplicationSources(page: Page, cardIds: string[]): Promise<Array<{ id: string; data: string }>> {
  return page.evaluate(async cardIds => {
    const { useTincanban } = await import("/src/state.ts")
    const doc = useTincanban().getActiveDoc()
    if (!doc) throw new Error("Job-search board is missing")
    return Object.values(doc.entities).filter(entity => entity.kind === "application_source" &&
      cardIds.includes((JSON.parse(entity.data) as { cardId: string }).cardId))
      .map(entity => ({ id: entity.id, data: entity.data })).sort((a, b) => a.id.localeCompare(b.id))
  }, cardIds)
}

async function setJobPage(origin: string, response: { url: string; status: 200; html: string } | { url: string; status: 404 }): Promise<void> {
  // Test-fixture route contract to be added to workers/automation/src/e2e-worker.ts; it drives the real extractor.
  const result = await fetch(`${origin}/__test/job-page`, { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify(response) })
  expect(result.status, await result.clone().text()).toBe(200)
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolveListen))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not allocate a local port")
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  return address.port
}

async function stopProcess(child?: ChildProcess): Promise<void> {
  if (!child || !child.pid || child.exitCode !== null) return
  if (child.pid && process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGTERM") } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  } else child.kill("SIGTERM")
  await new Promise<void>(resolveExit => {
    const timeout = setTimeout(() => {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL") } catch { /* Worker has already exited. */ }
      } else child.kill("SIGKILL")
      resolveExit()
    }, 5_000)
    child.once("exit", () => { clearTimeout(timeout); resolveExit() })
  })
}
