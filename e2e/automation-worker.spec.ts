import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { ensureJobSearchWorkspace } from "./support/workspaces"

const operatorToken = "automation-e2e-provisioning-token-with-at-least-32-bytes"
const integrationId = "e2e"
const forwardedMessages = new Map<string, string>()

test("Given an owner-approved blind workspace, when Worker intake and forwarded mail run, then real clients see one scoped Lead and safe status moves", async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(180_000)
  const rustyDirectory = await mkdtemp(join(tmpdir(), "automation-rusty-e2e-"))
  const workerDirectory = await mkdtemp(join(tmpdir(), "automation-worker-e2e-"))
  let rusty: ChildProcess | undefined
  let worker: ChildProcess | undefined
  let context: BrowserContext | undefined
  try {
    const workerSetup = await startAutomationWorker(workerDirectory)
    worker = workerSetup.process
    const workerOrigin = workerSetup.origin
    context = await browser.newContext()
    let page = await context.newPage()
    await page.goto(baseURL!)
    await ensureJobSearchWorkspace(page)
    const trustedOwner = await page.evaluate(async () => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const profile = await bootstrapIdentity()
      return { identity: profile.identity, allowedControllerDeviceIds: [profile.device.deviceId] }
    })
    const rustySetup = await startRusty(rustyDirectory, baseURL!, trustedOwner)
    rusty = rustySetup.process
    const rustyOrigin = rustySetup.origin

    // Exercise the real owner UI export: this contains Rusty's read/write access and content key.
    await connectBlindRusty(page, rustyOrigin)
    const workspace = await inspectWorkspace(page)
    const configured = await fetch(`${workerOrigin}/__test/configure`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.workspaceId, boardId: workspace.boardId,
        columns: workspace.columns, fieldIds: workspace.fieldBindings, emailAddress: "intake@example.test" }),
    })
    expect(configured.status, await configured.clone().text()).toBe(200)
    const workerIdentityResponse = await fetch(`${workerOrigin}/v1/integrations/${integrationId}/identity`, {
      method: "POST", headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(workerIdentityResponse.status, await workerIdentityResponse.clone().text()).toBe(200)
    const workerIdentity = await workerIdentityResponse.json() as Record<string, unknown>
    const activation = await approveAutomationFromUi(page, workerIdentity)
    expect(activation).toMatchObject({ version: 2, definition: { payload: { type: "job-intake", typeVersion: 2 } } })
    const sharedAutomation = await page.evaluate(async () => {
      const { useTincanban } = await import("/src/state.ts")
      const { automationLifecycle } = await import("/src/domain/automationLifecycle.ts")
      const doc = useTincanban().getActiveDoc()
      const entity = doc?.entities["automation:e2e"]
      if (entity?.kind !== "automation") throw new Error("Owner approval must persist its CRDT record")
      return { state: automationLifecycle(entity).state, origin: entity.executor.origin, approval: entity.approval }
    })
    expect(sharedAutomation).toMatchObject({ state: "active", origin: workerOrigin })
    const privateData = activation.blind as { readToken: string; writeToken: string; contentKey: string }
    for (const secret of Object.values(privateData).filter(value => typeof value === "string" && value.length >= 43)) {
      expect(sharedAutomation.approval).not.toContain(secret)
    }
    const expiry = (activation as { grant: { payload: { automation: { expiresAt: number } } } }).grant.payload.automation.expiresAt
    const exactExpiryConfiguration = await fetch(`${workerOrigin}/__test/configure`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.workspaceId, boardId: workspace.boardId,
        columns: workspace.columns, fieldIds: workspace.fieldBindings, emailAddress: "intake@example.test", expiresAt: expiry }),
    })
    expect(exactExpiryConfiguration.status, await exactExpiryConfiguration.clone().text()).toBe(200)
    const activated = await fetch(`${workerOrigin}/v1/integrations/${integrationId}/activation`, {
      method: "PUT", headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
      body: JSON.stringify(activation),
    })
    expect(activated.status, await activated.clone().text()).toBe(200)
    expect(await activated.json()).toMatchObject({ status: "active", synced: true })

    // Bad human check is the required failure path; it must not create an event.
    const rejected = await submitWebsite(workerOrigin, { company: "No event", role: "Rejected submission", contact: "no-event@example.test" }, "wrong-answer")
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toMatchObject({ error: "Human check expired or incorrect" })

    await page.close()
    // Workerd test entry injects deterministic AI choices; this is not real Clef proof.
    const challenge = await getChallenge(workerOrigin)
    const intakeBody = {
      company: "Nacre Light Integration GmbH",
      role: "Principal Systems Engineer",
      jobUrl: "https://jobs.example.test/nacre/systems",
      contact: "automation-e2e-contact-secret@example.test",
      message: "automation-e2e-source-secret: please consider this systems role.",
      humanCheckToken: challenge.token,
      humanCheckAnswer: challenge.answer,
    }
    const accepted = await fetch(`${workerOrigin}/v1/intake/${integrationId}`, {
      method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "website-lead-1" },
      body: JSON.stringify(intakeBody),
    })
    expect(accepted.status, await accepted.clone().text()).toBe(202)
    const leadEvent = await accepted.json() as { eventId: string }
    const leadResult = await waitForAppliedEvent(workerOrigin, leadEvent.eventId)
    expect(leadResult).toMatchObject({ result: { action: { kind: "created-lead" } } })
    const leadCardId = actionFrom(leadResult).cardId

    // Human client closed while Worker wrote; same profile and local IndexedDB reopen now.
    page = await context.newPage()
    await page.goto(baseURL!)
    await expect(page.getByRole("region", { name: "Job search", exact: true })).toBeVisible()
    await syncFromBlindRusty(page)
    await expect(page.getByRole("button", { name: "Open Nacre Light Integration GmbH — Principal Systems Engineer", exact: true })).toBeVisible({ timeout: 30_000 })
    await testInfo.attach("lead-after-client-reopen", { body: await page.screenshot(), contentType: "image/png" })

    await page.close()
    const appliedId = await postForwardedMail(workerOrigin, "<automation-applied-1@example.test>",
      "Application received: Principal Systems Engineer at Nacre Light Integration GmbH",
      "We received your application for Principal Systems Engineer at Nacre Light Integration GmbH.")
    const appliedResult = await waitForAppliedEvent(workerOrigin, appliedId)
    expect(actionFrom(appliedResult)).toMatchObject({ cardId: leadCardId, columnId: workspace.columns.applied })
    page = await context.newPage()
    await page.goto(baseURL!)
    await expect(page.getByRole("region", { name: "Job search", exact: true })).toBeVisible()
    await syncFromBlindRusty(page)
    await expectStatusColumn(page, "Applied", "Nacre Light Integration GmbH — Principal Systems Engineer")

    const applicationHeader = "Interview invitation for Principal Systems Engineer at Nacre Light Integration GmbH"
    await page.close()
    const interviewId = await postForwardedMail(workerOrigin, "<automation-interview-1@example.test>", applicationHeader,
      "We would like to invite you to an interview for Principal Systems Engineer at Nacre Light Integration GmbH.")
    const interviewResult = await waitForAppliedEvent(workerOrigin, interviewId)
    expect(actionFrom(interviewResult)).toMatchObject({ cardId: leadCardId, columnId: workspace.columns.interview })
    page = await context.newPage()
    await page.goto(baseURL!)
    await expect(page.getByRole("region", { name: "Job search", exact: true })).toBeVisible()
    await syncFromBlindRusty(page)
    await expectStatusColumn(page, "Interview", "Nacre Light Integration GmbH — Principal Systems Engineer")
    const afterInterview = await rustyObjectCount(rustyDirectory)

    // Replaying identical RFC message must reuse its event and produce no second board write.
    expect(await postForwardedMail(workerOrigin, "<automation-interview-1@example.test>", applicationHeader,
      "We would like to invite you to an interview for Principal Systems Engineer at Nacre Light Integration GmbH.")).toBe(interviewId)
    await expect.poll(() => eventStatus(workerOrigin, interviewId)).toMatchObject({ status: "applied", result: { action: { cardId: leadCardId } } })
    await syncFromBlindRusty(page)
    expect(await rustyObjectCount(rustyDirectory)).toBe(afterInterview)
    await expectStatusColumn(page, "Interview", "Nacre Light Integration GmbH — Principal Systems Engineer")

    const rejectionId = await postForwardedMail(workerOrigin, "<automation-rejection-1@example.test>",
      "Application update: Nacre Light Integration GmbH",
      "We rejected your application and will not continue for Principal Systems Engineer at Nacre Light Integration GmbH.")
    const rejectionResult = await waitForAppliedEvent(workerOrigin, rejectionId)
    expect(actionFrom(rejectionResult)).toMatchObject({ cardId: leadCardId, columnId: workspace.columns.rejected })
    await page.close()
    page = await context.newPage()
    await page.goto(baseURL!)
    await expect(page.getByRole("region", { name: "Job search", exact: true })).toBeVisible()
    await syncFromBlindRusty(page)
    await expectStatusColumn(page, "Rejected", "Nacre Light Integration GmbH — Principal Systems Engineer")
    await testInfo.attach("rejected-after-client-reopen", { body: await page.screenshot(), contentType: "image/png" })
    const afterRejection = await rustyObjectCount(rustyDirectory)
    expect(await postForwardedMail(workerOrigin, "<automation-rejection-1@example.test>",
      "Application update: Nacre Light Integration GmbH",
      "We rejected your application and will not continue for Principal Systems Engineer at Nacre Light Integration GmbH.")).toBe(rejectionId)
    await expect.poll(() => eventStatus(workerOrigin, rejectionId)).toMatchObject({ status: "applied", result: { action: { cardId: leadCardId } } })
    await syncFromBlindRusty(page)
    expect(await rustyObjectCount(rustyDirectory)).toBe(afterRejection)
    await expectStatusColumn(page, "Rejected", "Nacre Light Integration GmbH — Principal Systems Engineer")

    // Stale message dates must not move an application even when Clef classifies it as an interview.
    const staleInterviewId = await postForwardedMail(workerOrigin, "<automation-stale-interview@example.test>",
      "Interview invitation for Principal Systems Engineer at Nacre Light Integration GmbH",
      "We would like to invite you to an interview for Principal Systems Engineer at Nacre Light Integration GmbH.",
      new Date("2000-01-01T00:00:00.000Z").toUTCString())
    const staleInterview = await waitForReviewEvent(workerOrigin, staleInterviewId)
    expect(staleInterview).toMatchObject({ result: { reason: "Email is older than the latest application status" } })
    await syncFromBlindRusty(page)
    expect(await rustyObjectCount(rustyDirectory)).toBe(afterRejection)
    await expectStatusColumn(page, "Rejected", "Nacre Light Integration GmbH — Principal Systems Engineer")

    const stored = await readRustyObjects(rustyDirectory)
    expect(stored.length).toBeGreaterThan(0)
    for (const object of stored) {
      expect(Object.keys(JSON.parse(object).object).sort()).toEqual(["ciphertext", "keyEpoch", "nonce", "scopeId", "version"])
      for (const sentinel of ["Nacre Light Integration GmbH", "Principal Systems Engineer", "automation-e2e-source-secret", "automation-e2e-contact-secret", applicationHeader]) {
        expect(object).not.toContain(sentinel)
      }
    }
    const privateAccess = activation.blind as { readToken: string; writeToken: string; contentKey: string }
    for (const rawFile of await readRustyFiles(rustyDirectory)) {
      for (const secret of [privateAccess.readToken, privateAccess.writeToken, privateAccess.contentKey]) {
        expect(rawFile).not.toContain(secret)
      }
    }
  } finally {
    try { await context?.close() } finally {
      await stopProcess(worker)
      await stopProcess(rusty)
      await rm(workerDirectory, { recursive: true, force: true })
      await rm(rustyDirectory, { recursive: true, force: true })
    }
  }
})

async function connectBlindRusty(page: Page, origin: string): Promise<void> {
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  await page.getByRole("tab", { name: "Rusty", exact: true }).click()
  const panel = page.getByRole("region", { name: "Rusty", exact: true })
  await panel.getByRole("button", { name: "Add Rusty", exact: true }).click()
  await panel.getByLabel("Address", { exact: true }).fill(origin)
  await panel.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(panel.locator(":scope > .rusty-connections").getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })
}

type WorkspaceSeed = {
  workspaceId: string
  boardId: string
  columns: { lead: string; applied: string; interview: string; rejected: string }
  fieldBindings: { company: string; role: string; jobUrl: string; notes: string; sourceText: string }
}

async function inspectWorkspace(page: Page): Promise<WorkspaceSeed> {
  return page.evaluate(async () => {
    const { useTincanban } = await import("/src/state.ts")
    const tincanban = useTincanban()
    await tincanban.whenReady()
    const profile = tincanban.getCurrentProfile()
    const doc = tincanban.getActiveDoc()
    if (!profile || !doc) throw new Error("Owner workspace is not ready")
    const board = Object.values(doc.entities).find(entity => entity.kind === "board" && entity.preset?.key === "job-search")
    if (!board || board.kind !== "board") throw new Error("Job-search board is missing")
    const bindings = board.preset.bindings
    const columns = { lead: bindings["status.lead"], applied: bindings["status.applied"], interview: bindings["status.interview"], rejected: bindings["status.rejected"] }
    const fieldBindings = { company: bindings["field.company"], role: bindings["field.role"], jobUrl: bindings["field.url"],
      notes: bindings["field.notes"], sourceText: bindings["field.sourceText"] }
    return { workspaceId: doc.id, boardId: board.id, columns, fieldBindings }
  })
}

async function approveAutomationFromUi(page: Page, workerIdentity: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Management UI is covered by the independent lifecycle scenario below. This scenario covers intake and mail semantics.
  return page.evaluate(async identity => {
    const { useTincanban } = await import("/src/state.ts")
    const { getReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
    const { exportApprovedAutomation } = await import("/src/app/automationActivation.ts")
    const workspace = useTincanban()
    const personId = workspace.getCurrentProfile()!.identity.personId
    const configs = await getReplicaConfigurations(personId)
    const config = configs.find(value => value.workspaceId === workspace.getActiveDoc()!.id)
    if (!config) throw new Error("Rusty local access missing")
    return JSON.parse(await exportApprovedAutomation(workspace, config, JSON.stringify(identity), {
      name: "Job intake", type: "job-intake", typeVersion: 2, parameters: { sources: ["website", "email"] },
    }))
  }, workerIdentity)
}

async function getChallenge(origin: string): Promise<{ token: string; answer: string }> {
  const response = await fetch(`${origin}/v1/challenge`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ integrationId }) })
  expect(response.status, await response.clone().text()).toBe(200)
  const value = await response.json() as { token: string; prompt: string }
  const numbers = value.prompt.match(/\d+/g)?.map(Number) ?? []
  expect(numbers).toHaveLength(2)
  return { token: value.token, answer: String(numbers[0]! + numbers[1]!) }
}

async function submitWebsite(origin: string, submission: Record<string, string>, answer: string): Promise<Response> {
  const challenge = await getChallenge(origin)
  const numbers = challenge.answer
  const correctAnswer = answer === "wrong-answer" ? "0" : numbers
  return fetch(`${origin}/v1/intake/${integrationId}`, {
    method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "failure-path" },
    body: JSON.stringify({ ...submission, message: "Bad human-check attempt", humanCheckToken: challenge.token, humanCheckAnswer: correctAnswer }),
  })
}

async function postForwardedMail(origin: string, messageId: string, subject: string, text: string, date = new Date().toUTCString()): Promise<string> {
  let raw = forwardedMessages.get(messageId)
  if (!raw) {
    raw = [
      "From: owner@example.test", "To: intake@example.test", `Message-ID: ${messageId}`, "In-Reply-To: <automation-applied-1@example.test>",
      `Date: ${date}`, `Subject: ${subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "",
      text, "",
    ].join("\r\n")
    forwardedMessages.set(messageId, raw)
  }
  const response = await fetch(`${origin}/__test/email`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "owner@example.test", to: "intake@example.test", raw }),
  })
  expect(response.status, await response.clone().text()).toBe(202)
  return createHash("sha256").update(`${integrationId}:email:${messageId}`).digest("base64url")
}

async function eventStatus(origin: string, eventId: string, targetIntegrationId = integrationId): Promise<Record<string, unknown>> {
  const response = await fetch(`${origin}/v1/integrations/${targetIntegrationId}/events/${eventId}`, {
    headers: { authorization: `Bearer ${operatorToken}` },
  })
  if (response.status !== 200) return { status: `http-${response.status}` }
  return await response.json() as Record<string, unknown>
}

async function waitForAppliedEvent(origin: string, eventId: string): Promise<Record<string, unknown>> {
  const event = await waitForTerminalEvent(origin, eventId)
  expect(event, JSON.stringify(event)).toMatchObject({ status: "applied" })
  return event
}

async function waitForReviewEvent(origin: string, eventId: string): Promise<Record<string, unknown>> {
  const event = await waitForTerminalEvent(origin, eventId)
  expect(event, JSON.stringify(event)).toMatchObject({ status: "review" })
  return event
}

async function waitForTerminalEvent(origin: string, eventId: string): Promise<Record<string, unknown>> {
  await expect.poll(async () => {
    const event = await eventStatus(origin, eventId)
    return ["pending", "processing"].includes(String(event.status)) ? undefined : event
  }, { timeout: 30_000 }).not.toBeUndefined()
  return eventStatus(origin, eventId)
}

function actionFrom(event: Record<string, unknown>): Record<string, unknown> {
  const result = event.result
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Applied event has no result")
  const action = (result as Record<string, unknown>).action
  if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error("Applied event has no action correlation")
  return action as Record<string, unknown>
}

async function syncFromBlindRusty(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  await page.getByRole("tab", { name: "Rusty", exact: true }).click()
  const panel = page.getByRole("region", { name: "Rusty", exact: true })
  const syncButton = panel.getByRole("button", { name: "Sync now", exact: true })
  await syncButton.click()
  await expect(syncButton).toBeEnabled({ timeout: 15_000 })
  await expect(panel.getByRole("alert")).toHaveCount(0)
  await page.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Close" }).click()
}

async function expectStatusColumn(page: Page, column: string, card: string): Promise<void> {
  const cardButton = `Open ${card}`
  await expect(page.getByRole("button", { name: cardButton, exact: true })).toBeVisible()
  const columnRegion = page.getByRole("region", { name: column, exact: true })
  await expect(columnRegion.getByRole("button", { name: cardButton, exact: true })).toBeVisible()
}

async function startRusty(directory: string, allowedOrigin: string, trustedOwner: unknown): Promise<{ origin: string; process: ChildProcess }> {
  const executable = resolve(process.env.TINCANBAN_RUSTY_BINARY ?? "../mesh-lighthouse/target/debug/mesh-lighthouse")
  const child = spawn(executable, [directory, "127.0.0.1:0"], {
    detached: process.platform !== "win32",
    env: { ...process.env, RUSTY_TRUSTED_OWNER: JSON.stringify(trustedOwner), RUSTY_CORS_ORIGINS: allowedOrigin },
    stdio: ["ignore", "pipe", "pipe"],
  })
  try {
  const origin = await new Promise<string>((resolveOrigin, reject) => {
    let output = ""
    const timer = setTimeout(() => reject(new Error(`Rusty did not start: ${output}`)), 20_000)
    child.stdout?.on("data", chunk => {
      output += chunk.toString()
      const address = output.match(/listening on (127\.0\.0\.1:\d+)/)?.[1]
      if (address) { clearTimeout(timer); resolveOrigin(`http://${address}`) }
    })
    child.once("error", error => { clearTimeout(timer); reject(error) })
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Rusty exited ${code}: ${output}`)) })
  })
  return { origin, process: child }
  } catch (error) {
    await stopProcess(child)
    throw error
  }
}

async function startAutomationWorker(directory: string, browserOrigin?: string): Promise<{ origin: string; process: ChildProcess }> {
  const port = await unusedPort()
  const config = resolve("workers/automation/wrangler.e2e.jsonc")
  const executable = resolve("workers/automation/node_modules/.bin/wrangler")
  const child = spawn(executable, ["dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--config", config, "--persist-to", directory, ...(browserOrigin ? ["--var", `CORS_ORIGINS:${browserOrigin}`] : [])], {
    detached: process.platform !== "win32",
    cwd: resolve("workers/automation"), env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const origin = `http://127.0.0.1:${port}`
  try {
    await waitForReady(child, `${origin}/health`, 45_000)
    return { origin, process: child }
  } catch (error) {
    await stopProcess(child)
    throw error
  }
}

async function waitForReady(child: ChildProcess, url: string, timeout: number): Promise<void> {
  const started = Date.now()
  let output = ""
  child.stdout?.on("data", chunk => { output += chunk.toString() })
  child.stderr?.on("data", chunk => { output += chunk.toString() })
  while (Date.now() - started < timeout) {
    if (child.exitCode !== null) throw new Error(`Automation Worker exited ${child.exitCode}: ${output}`)
    try { if ((await fetch(url)).ok) return } catch { /* Wait for local workerd. */ }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Automation Worker did not become ready: ${output}`)
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not allocate a local port")
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function stopProcess(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null) return
  const signal = (value: NodeJS.Signals) => {
    if (process.platform === "win32" || !child.pid) { child.kill(value); return }
    try { process.kill(-child.pid, value) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
  signal("SIGTERM")
  await new Promise<void>(resolve => {
    const timeout = setTimeout(() => { signal("SIGKILL"); resolve() }, 5_000)
    child.once("exit", () => { clearTimeout(timeout); resolve() })
  })
}

async function rustyObjectCount(directory: string): Promise<number> { return (await readRustyObjects(directory)).length }

async function readRustyObjects(directory: string): Promise<string[]> {
  const root = join(directory, "scopes")
  const scopes = await readdir(root).catch(() => [])
  const results: string[] = []
  for (const scope of scopes) {
    const files = await readdir(join(root, scope, "objects")).catch(() => [])
    for (const file of files) results.push(await readFile(join(root, scope, "objects", file), "utf8"))
  }
  return results
}

async function readRustyFiles(directory: string): Promise<string[]> {
  const results: string[] = []
  const visit = async (path: string) => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const next = join(path, entry.name)
      if (entry.isDirectory()) await visit(next)
      else if (entry.isFile()) results.push(await readFile(next, "utf8").catch(() => ""))
    }
  }
  await visit(directory)
  return results
}

test("Given an owner and connected Rusty, when an automation is added, paused, resumed and removed, then Worker confirms each CRDT state and failed setup stays explicit", async ({ browser, baseURL }) => {
  test.setTimeout(240_000)
  const rustyDirectory = await mkdtemp(join(tmpdir(), "automation-management-rusty-"))
  const workerDirectory = await mkdtemp(join(tmpdir(), "automation-management-worker-"))
  let rusty: ChildProcess | undefined
  let worker: ChildProcess | undefined
  let context: BrowserContext | undefined
  try {
    const setup = await startAutomationWorker(workerDirectory, baseURL!)
    worker = setup.process
    context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(baseURL!)
    await ensureJobSearchWorkspace(page)
    const trustedOwner = await page.evaluate(async () => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const profile = await bootstrapIdentity()
      return { identity: profile.identity, allowedControllerDeviceIds: [profile.device.deviceId] }
    })
    const rustySetup = await startRusty(rustyDirectory, baseURL!, trustedOwner)
    rusty = rustySetup.process
    await connectBlindRusty(page, rustySetup.origin)
    const workspace = await inspectWorkspace(page)
    await page.evaluate(async bindings => {
      const { useTincanban } = await import("/src/state.ts")
      await useTincanban().executeCommandAsync({ kind: "createItem", id: "upvest-review-card", parentId: bindings.columns.applied,
        title: "Upvest — Senior Software Engineer (f/m/d)", values: {
          [bindings.fieldBindings.company]: "Upvest", [bindings.fieldBindings.role]: "Senior Software Engineer (f/m/d)",
        } })
    }, workspace)
    await fetch(`${setup.origin}/__test/configure`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.workspaceId, boardId: workspace.boardId, columns: workspace.columns,
        fieldIds: workspace.fieldBindings, ownerPersonId: trustedOwner.identity.personId }) })
    await page.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Close", exact: true }).click()
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("tab", { name: "Workspace", exact: true }).click()
    const panel = page.getByRole("region", { name: "Automations", exact: true })
    await panel.getByRole("button", { name: "Add automation", exact: true }).click()
    await panel.getByLabel("Automation name").fill("My job intake")
    await panel.getByLabel("Worker address").fill(rustySetup.origin)
    await panel.getByLabel("Allow Worker to read this workspace").check()
    await panel.getByRole("button", { name: "Connect automation", exact: true }).click()
    await expect(panel.getByRole("alert")).toBeVisible()
    await expect(panel.getByRole("article")).toHaveCount(0)
    await panel.getByLabel("Worker address").fill(setup.origin)
    await panel.getByRole("button", { name: "Connect automation", exact: true }).click()
    const automation = panel.getByRole("article", { name: "My job intake" })
    await expect(automation.getByText("Active · confirmed by Worker", { exact: true })).toBeVisible({ timeout: 30_000 })
    const instanceId = await page.evaluate(async () => {
      const { useTincanban } = await import("/src/state.ts")
      const instance = Object.values(useTincanban().getActiveDoc()!.entities).find(entity => entity.kind === "automation")
      if (!instance || instance.kind !== "automation") throw new Error("Missing instance")
      return JSON.parse(instance.definition).id as string
    })
    const privateAddress = `jobs-${"a".repeat(32)}@example.test`
    await fetch(`${setup.origin}/__test/configure`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.workspaceId, boardId: workspace.boardId, columns: workspace.columns,
        fieldIds: workspace.fieldBindings, emailAddress: privateAddress, ownerPersonId: trustedOwner.identity.personId,
        privateEmailRoutes: [{ id: instanceId, address: privateAddress, mailbox: "owner@example.test" }] }) })
    await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Dismiss", exact: true }).click()
    await page.reload()
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("tab", { name: "Workspace", exact: true }).click()
    const mailboxProbe = await page.evaluate(async () => {
      const { useTincanban } = await import("/src/state.ts")
      const { readAutomationMailbox } = await import("/src/app/automationMailbox.ts")
      const { parseAutomationDefinition } = await import("/src/domain/automationContract.ts")
      const app = useTincanban(), profile = app.getCurrentProfile()!, workspaceId = app.getActiveDoc()!.id
      const entity = Object.values(app.getActiveDoc()!.entities).find(value => value.kind === "automation")
      if (entity?.kind !== "automation") throw new Error("Automation unavailable")
      const definition = parseAutomationDefinition(JSON.parse(entity.definition))
      const mailbox = await readAutomationMailbox(profile, { origin: entity.executor.origin, workspaceId,
        definitionId: definition.id, personId: entity.executor.personId, grantId: definition.scope.grantId })
      return { integrationId: mailbox.integrationId, route: mailbox.setup.route }
    })
    expect(mailboxProbe).toMatchObject({ integrationId: instanceId, route: { address: privateAddress } })
    await expect(automation.getByRole("button", { name: "Enable email and Applied", exact: true })).toBeVisible({ timeout: 45_000 })
    await automation.getByRole("button", { name: "Enable email and Applied", exact: true }).click()
    const emailApproval = automation.getByRole("form", { name: "Confirm automation approval", exact: true })
    await emailApproval.getByLabel("Allow Worker to read this workspace").check()
    await emailApproval.getByRole("button", { name: "Confirm approval", exact: true }).click()
    await expect(automation.getByText("Email enabled", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(automation.getByRole("button", { name: "Enable email and Applied", exact: true })).toHaveCount(0)
    const raw = ["From: owner@example.test", `To: ${privateAddress}`, "Message-ID: <upvest-role-review@example.test>",
      `Date: ${new Date().toUTCString()}`, "Subject: Sorry, it’s not a match this time", "Content-Type: text/plain; charset=utf-8", "",
      "Thank you for applying to Upvest for Senior Product Engineer (f/m/d). We decided to proceed with other candidates; your application was declined."].join("\r\n")
    const received = await fetch(`${setup.origin}/__test/email`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "owner@example.test", to: privateAddress, raw }) })
    expect(received.status).toBe(202)
    const mailEventId = createHash("sha256").update(`${instanceId}:email:<upvest-role-review@example.test>`).digest("base64url")
    await expect.poll(async () => (await eventStatus(setup.origin, mailEventId, instanceId)).status, { timeout: 45_000 }).toBe("review")
    expect(await eventStatus(setup.origin, mailEventId, instanceId)).toMatchObject({
      result: { reason: "Original posting evidence is missing or unavailable; choose an application" },
    })
    await expect(automation.getByRole("list", { name: "Recent email processing" })).toHaveCount(0)
    await page.evaluate(async urlFieldId => {
      const { useTincanban } = await import("/src/state.ts")
      await useTincanban().executeCommandAsync({ kind: "patchItem", entityId: "upvest-review-card",
        values: { [urlFieldId]: "https://jobs.example.test/upvest/product" } })
    }, workspace.fieldBindings.jobUrl)
    await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Dismiss", exact: true }).click()
    await syncFromBlindRusty(page)
    expect(await eventStatus(setup.origin, mailEventId, instanceId)).toMatchObject({
      status: "review", result: { reason: "Original posting evidence is missing or unavailable; choose an application" },
    })
    await expectStatusColumn(page, "Applied", "Upvest — Senior Software Engineer (f/m/d)")
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("tab", { name: "Workspace", exact: true }).click()
    await automation.getByRole("button", { name: "Pause", exact: true }).click()
    await expect(automation.getByText("Paused · confirmed by Worker", { exact: true })).toBeVisible({ timeout: 30_000 })
    await automation.getByRole("button", { name: "Resume", exact: true }).click()
    await expect(automation.getByText("Active · confirmed by Worker", { exact: true })).toBeVisible({ timeout: 30_000 })
    await automation.getByRole("button", { name: "Remove", exact: true }).click()
    await automation.getByRole("button", { name: "Confirm removal", exact: true }).click()
    await expect(automation.getByText("Removed · confirmed by Worker", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(automation.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0)
    await page.reload()
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("tab", { name: "Workspace", exact: true }).click()
    await expect(page.getByRole("article", { name: "My job intake" }).getByText("Removed · confirmed by Worker", { exact: true })).toBeVisible({ timeout: 30_000 })
  } finally {
    try { await context?.close() } finally {
      await stopProcess(worker)
      await stopProcess(rusty)
      await rm(rustyDirectory, { recursive: true, force: true })
      await rm(workerDirectory, { recursive: true, force: true })
    }
  }
})
