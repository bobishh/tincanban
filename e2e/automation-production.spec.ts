import { chromium, expect, test } from "@playwright/test"
import { resolve4 } from "node:dns/promises"
import { request as httpsRequest } from "node:https"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createJobSearchWorkspace } from "./support/workspaces"

const root = join(homedir(), ".local/share/tincanban-automation/production-acceptance")
const profilePath = join(root, "profile")
const appOrigin = "https://match.meta-uber-engineer.dev"
const workerOrigin = "https://automation.meta-uber-engineer.dev"
const rustyOrigin = "https://ingest.meta-uber-engineer.dev"
const integrationId = "production-proof-20261008"
const workspaceTitle = "Production proof 20261008"
const packetPath = join(root, "automation-private-activation.json")
const accessPath = join(root, "rusty-private-access.json")
const routePath = join(root, "worker-route-config.json")
const eventPath = join(root, "accepted-event.json")
const company = "Example GmbH"
const role = "Principal Distributed Systems Engineer"
const postingMessage = "Example GmbH — Principal Distributed Systems Engineer\nLocation: Berlin, Germany (hybrid, 2 days per week in office)\nEmployment: Full-time, permanent\nCompensation: EUR 105,000–135,000 gross annually plus equity and benefits\n\nWe are hiring a Principal Distributed Systems Engineer for our infrastructure group. The team owns the event ingestion and workflow platform used by 40 product teams. You will lead architecture and implementation for replicated state services, multi-region storage, queue processing, service reliability, and operational tooling. Responsibilities include designing fault-tolerant APIs, improving p99 latency and recovery, reviewing Rust and TypeScript changes, mentoring senior engineers, and collaborating with security and product teams. We expect substantial experience operating distributed systems in production, strong backend engineering skills, and clear technical leadership. Experience with Rust, TypeScript, SQLite or Postgres, and cloud platforms is useful.\n\nApply: https://jobs.example.test/principal-distributed-systems-engineer"

type WorkerSecrets = { PROVISIONING_TOKEN: string }
type ActivationPacket = {
  workspaceId: string
  bindings: {
    boardId: string
    columns: { lead: string; interview: string; rejected: string }
    fieldIds: Record<string, string>
  }
  grant: { payload: { automation: { expiresAt: number } } }
}

test.describe.serial("production automation proof", () => {
  test("Given the production owner UI, when owner connects Rusty and approves the Worker, then private signed scope is exported", async ({}, testInfo) => {
    test.setTimeout(180_000)
    await mkdir(root, { recursive: true, mode: 0o700 })
    await chmod(root, 0o700)
    let hasOwnerPacket = false
    try { await readFile(packetPath); hasOwnerPacket = true } catch { /* First production run creates the owner packet. */ }
    if (hasOwnerPacket) test.skip(true, "Reuse the owner-approved production packet already saved outside the repository")
    const context = await chromium.launchPersistentContext(profilePath, {
      headless: true,
      acceptDownloads: true,
      viewport: { width: 1440, height: 1000 },
      args: ["--no-first-run", "--no-default-browser-check"],
    })
    try {
      const page = context.pages()[0] ?? await context.newPage()
      await page.goto(appOrigin, { waitUntil: "domcontentloaded" })
      await expect(page.getByRole("button", { name: "Open workspaces" })).toBeVisible()
      await createJobSearchWorkspace(page, workspaceTitle)

      await page.getByRole("button", { name: "Sync", exact: true }).click()

  const panel = page.getByRole("region", { name: "Rusty", exact: true })
      await panel.getByRole("button", { name: "Add Rusty", exact: true }).click()
  await panel.getByLabel("Address", { exact: true }).fill(rustyOrigin)
      await panel.getByRole("button", { name: "Connect", exact: true }).click()
      await expect(panel.locator(":scope > .rusty-connections").getByText("Synced", { exact: true })).toBeVisible({ timeout: 60_000 })

      const secrets = await workerSecrets()
      const identityResponse = await workerFetch(`${workerOrigin}/v1/integrations/${integrationId}/identity`, {
        method: "POST", headers: { authorization: `Bearer ${secrets.PROVISIONING_TOKEN}` },
      })
      expect(identityResponse.status, "Worker public identity provisioning route").toBe(200)
      const workerIdentity = await identityResponse.json()

      await page.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Close", exact: true }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("tab", { name: "Workspace", exact: true }).click()
  const setup = page.getByRole("region", { name: "Manual automation integration", exact: true })
  await setup.getByText("Manual integration setup", { exact: true }).click()
      await setup.getByLabel("Allow Worker to read this workspace and automate the job board").check()
      await setup.getByLabel("Worker public identity").fill(JSON.stringify(workerIdentity))
      const activationDownload = page.waitForEvent("download")
      await setup.getByRole("button", { name: "Export private automation approval" }).click()
      const activationFile = await (await activationDownload).path()
      expect(activationFile).toBeTruthy()
      const activationText = await readFile(activationFile!, "utf8")
      await writePrivate(packetPath, activationText)
      const packet = JSON.parse(activationText) as ActivationPacket
      const privateAccess = (JSON.parse(activationText) as { blind: unknown }).blind
      await writePrivate(accessPath, JSON.stringify(privateAccess))

      const expiry = new Date(packet.grant.payload.automation.expiresAt).toISOString()
      await writePrivate(routePath, JSON.stringify({
        id: integrationId,
        workspaceId: packet.workspaceId,
        scope: {
          version: 1,
          boardId: packet.bindings.boardId,
          columns: packet.bindings.columns,
          fieldIds: packet.bindings.fieldIds,
          expiresAt: expiry,
        },
        allowedForwarders: [],
      }, null, 2))
      const screenshot = await page.screenshot({ path: join(root, "production-owner-approval.png"), fullPage: true })
      await chmod(join(root, "production-owner-approval.png"), 0o600)
      await testInfo.attach("production-owner-approval", { body: screenshot, contentType: "image/png" })
    } finally {
      await context.close()
    }
  })

  test("Given exact owner-approved Worker routing, when real Clef classifies website intake, then a Lead syncs to Rusty and reopens in the owner UI", async ({}, testInfo) => {
    test.setTimeout(240_000)
    const secrets = await workerSecrets()
    const activation = await readFile(packetPath, "utf8")
    const packet = JSON.parse(activation) as ActivationPacket
    const route = JSON.parse(await readFile(routePath, "utf8")) as { workspaceId: string; scope: { boardId: string; expiresAt: string } }
    expect(route.workspaceId).toBe(packet.workspaceId)
    expect(route.scope.boardId).toBe(packet.bindings.boardId)
    expect(Date.parse(route.scope.expiresAt)).toBe(packet.grant.payload.automation.expiresAt)

    const activationResponse = await workerFetch(`${workerOrigin}/v1/integrations/${integrationId}/activation`, {
      method: "PUT",
      headers: { authorization: `Bearer ${secrets.PROVISIONING_TOKEN}`, "content-type": "application/json" },
      body: activation,
    })
    expect(activationResponse.status, await activationResponse.clone().text()).toBe(200)
    expect(await activationResponse.json()).toMatchObject({ status: "active", workspaceId: packet.workspaceId, synced: true })

    const failedChallenge = await workerFetch(`${workerOrigin}/v1/challenge`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ integrationId }),
    })
    expect(failedChallenge.status).toBe(200)
    const wrongChallenge = await failedChallenge.json() as { token: string }
    const rejected = await workerFetch(`${workerOrigin}/v1/intake/${integrationId}`, {
      method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": `production-negative-${crypto.randomUUID()}` },
      body: JSON.stringify({ company, role, contact: "proof@example.invalid", message: "Synthetic production acceptance negative human-check path.",
        humanCheckToken: wrongChallenge.token, humanCheckAnswer: "incorrect" }),
    })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toMatchObject({ error: "Human check expired or incorrect" })

    // Resume a previously applied proof event after test interruption; avoid duplicate production inference.
    let eventId: string | undefined
    let finalEvent: (Record<string, unknown> & { status: string; result?: unknown }) | undefined
    try {
      const previous = JSON.parse(await readFile(eventPath, "utf8")) as { eventId?: string; company?: string; role?: string; workspaceId?: string }
      if (previous.company === company && previous.role === role && previous.workspaceId === packet.workspaceId && previous.eventId) {
        const response = await workerFetch(`${workerOrigin}/v1/integrations/${integrationId}/events/${previous.eventId}`, {
          headers: { authorization: `Bearer ${secrets.PROVISIONING_TOKEN}` },
        })
        if (response.ok) {
          const event = await response.json() as Record<string, unknown> & { status: string; result?: unknown }
          if (event.status === "applied" && (event.result as { action?: { kind?: string } } | undefined)?.action?.kind === "created-lead") {
            eventId = previous.eventId
            finalEvent = event
          }
        }
      }
    } catch {
      // First run has no saved proof event.
    }
    let challenge: { token: string; answer: string } | undefined
    if (!eventId) {
      const challengeResponse = await workerFetch(`${workerOrigin}/v1/challenge`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ integrationId }),
      })
      expect(challengeResponse.status, await challengeResponse.clone().text()).toBe(200)
      const issued = await challengeResponse.json() as { token: string; prompt: string }
      const addends = issued.prompt.match(/\d+/g)?.map(Number) ?? []
      expect(addends).toHaveLength(2)
      challenge = { token: issued.token, answer: String(addends[0]! + addends[1]!) }
    }

    let context = await chromium.launchPersistentContext(profilePath, {
      headless: true,
      acceptDownloads: true,
      viewport: { width: 1440, height: 1000 },
      args: ["--no-first-run", "--no-default-browser-check"],
    })
    let page = context.pages()[0] ?? await context.newPage()
    await page.goto(appOrigin, { waitUntil: "domcontentloaded" })
    await expect(page.getByRole("region", { name: workspaceTitle, exact: true })).toBeVisible()
    await page.close()
    await context.close()

    if (!eventId) {
      // Client is closed before production intake. This proves the remote Worker write reaches Rusty.
      const accepted = await workerFetch(`${workerOrigin}/v1/intake/${integrationId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": `production-proof-${crypto.randomUUID()}` },
        body: JSON.stringify({ company, role, contact: "production-proof@example.invalid", message: postingMessage,
          humanCheckToken: challenge!.token, humanCheckAnswer: challenge!.answer }),
      })
      expect([200, 202]).toContain(accepted.status)
      const acceptedBody = await accepted.json() as { eventId: string; status: string; durable: boolean }
      expect(acceptedBody).toMatchObject({ durable: true })
      eventId = acceptedBody.eventId
      await writePrivate(eventPath, JSON.stringify({ eventId, company, role, workspaceId: packet.workspaceId, status: acceptedBody.status }, null, 2))
      finalEvent = await waitForEvent(eventId, secrets.PROVISIONING_TOKEN)
    }
    expect(finalEvent!.status, JSON.stringify(finalEvent!.result)).toBe("applied")
    expect(finalEvent!.result, JSON.stringify(finalEvent!.result)).toMatchObject({ action: { kind: "created-lead" } })
    const action = (finalEvent!.result as { action: { cardId: string; columnId?: string } }).action
    if (action.columnId !== undefined) expect(action.columnId).toBe(packet.bindings.columns.lead)
    await writePrivate(eventPath, JSON.stringify({ eventId, company, role, workspaceId: packet.workspaceId,
      status: finalEvent!.status, action, result: finalEvent!.result }, null, 2))

    context = await chromium.launchPersistentContext(profilePath, {
      headless: true,
      acceptDownloads: true,
      viewport: { width: 1440, height: 1000 },
      args: ["--no-first-run", "--no-default-browser-check"],
    })
    page = context.pages()[0] ?? await context.newPage()
    await page.goto(appOrigin, { waitUntil: "domcontentloaded" })
    await expect(page.getByRole("region", { name: workspaceTitle, exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Sync", exact: true }).click()

  const panel = page.getByRole("region", { name: "Rusty", exact: true })
    await panel.getByRole("button", { name: "Sync now", exact: true }).click()
    await page.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Close", exact: true }).click()
    const leadColumn = page.getByRole("region", { name: "Lead", exact: true })
    const remoteCard = leadColumn.locator(".lead-card").filter({ hasText: company }).filter({ hasText: role })
    await expect(remoteCard).toBeVisible({ timeout: 60_000 })
    const screenshot = await page.screenshot({ path: join(root, "lead-after-production-reopen.png"), fullPage: true })
    await chmod(join(root, "lead-after-production-reopen.png"), 0o600)
    await testInfo.attach("lead-after-production-reopen", { body: screenshot, contentType: "image/png" })
    await context.close()
  })
})

async function workerSecrets(): Promise<WorkerSecrets> {
  const parsed = JSON.parse(await readFile(join(homedir(), ".local/share/tincanban-automation/production-secrets.json"), "utf8")) as Partial<WorkerSecrets>
  if (!parsed.PROVISIONING_TOKEN || parsed.PROVISIONING_TOKEN.length < 32) throw new Error("Production Worker provisioning credential unavailable")
  return { PROVISIONING_TOKEN: parsed.PROVISIONING_TOKEN }
}

async function writePrivate(path: string, value: string): Promise<void> {
  await writeFile(path, value, { mode: 0o600 })
  await chmod(path, 0o600)
}

async function waitForEvent(eventId: string, token: string): Promise<Record<string, unknown> & { status: string; result?: unknown }> {
  const deadline = Date.now() + 150_000
  let last: unknown
  while (Date.now() < deadline) {
    const response = await workerFetch(`${workerOrigin}/v1/integrations/${integrationId}/events/${eventId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (response.ok) {
      const event = await response.json() as Record<string, unknown> & { status: string; result?: unknown }
      if (["applied", "review", "failed"].includes(event.status)) return event
      last = event
    } else last = { status: response.status }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  throw new Error(`Production Worker event did not finish before deadline: ${JSON.stringify(last)}`)
}

async function workerFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input)
  if (url.origin !== workerOrigin) throw new Error("Production Worker request escaped the approved origin")
  const addresses = await resolve4(url.hostname)
  if (!addresses.length) throw new Error("Production Worker hostname has no public IPv4 address")
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: addresses[0],
      port: 443,
      servername: url.hostname,
      method: init.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers: { ...(init.headers as Record<string, string> | undefined), host: url.host },
    }, response => {
      const chunks: Buffer[] = []
      response.on("data", chunk => chunks.push(Buffer.from(chunk)))
      response.on("error", reject)
      response.on("end", () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode ?? 500,
        headers: response.headers as HeadersInit,
      })))
    })
    request.on("error", reject)
    if (init.body) request.write(typeof init.body === "string" ? init.body : Buffer.from(init.body as ArrayBuffer))
    request.end()
  })
}
