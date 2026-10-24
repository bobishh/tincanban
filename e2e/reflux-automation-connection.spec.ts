import { expect, test } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { createJobSearchWorkspace } from "./support/workspaces"
import { startRustyService } from "./support/rustyService"
import { approveRustyForFixture } from "./support/identityRustyFixture"

const reflux = process.env.REFLUX_E2E_ORIGIN!
const refluxRoot = process.env.REFLUX_E2E_SOURCE_ROOT!
const identityOrigin = process.env.IDENTITY_E2E_ORIGIN!
if (!refluxRoot) throw new Error("Set REFLUX_E2E_SOURCE_ROOT to the isolated Reflux checkout")
if (!reflux || !identityOrigin) throw new Error("Start isolated Reflux and Identity services and set REFLUX_E2E_ORIGIN and IDENTITY_E2E_ORIGIN")
for (const value of [reflux, identityOrigin]) {
  const url = new URL(value)
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Use isolated local services for the Reflux connection proof")
}

test("Given a native Reflux workflow and an existing board, when its owner connects it and website intake is followed by the same application email twice, then one Lead moves once to Applied", async ({ page, baseURL }) => {
  execFileSync("mix", ["run", "--no-start", "test/support/reset_e2e_pending_automation_connection.exs"], {
    cwd: refluxRoot, stdio: "pipe", env: { ...process.env, MIX_ENV: "e2e",
      E2E_DATABASE_NAME: process.env.REFLUX_E2E_DATABASE_NAME ?? "acidreflux_reflux_bridge_e2e_v2",
      E2E_AUTOMATION_OWNER_PERSON_ID: "_oEsEvOrTOasXbaaw1L5BssbEe9D-zPiUu9_9VImOIk" },
  })
  await page.goto("/")
  const owner = await page.evaluate(async () => {
    const { adoptRefluxFixtureOwner } = await import("/src/test/refluxOwnerFixture.ts")
    return adoptRefluxFixtureOwner()
  })
  expect(owner.identity.personId).toBe("_oEsEvOrTOasXbaaw1L5BssbEe9D-zPiUu9_9VImOIk")
  await createJobSearchWorkspace(page, "Existing bridge board")
  const boardUrl = page.url()
  const rusty = await startRustyService(owner, baseURL!)
  try {
    await approveRustyForFixture(page, rusty.origin)
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const panel = page.getByRole("region", { name: "Rusty", exact: true })
    await panel.getByRole("button", { name: "Add Rusty", exact: true }).click()
    await panel.getByLabel("Address", { exact: true }).fill(rusty.origin)
    await panel.getByRole("button", { name: "Connect", exact: true }).click()
    await Promise.race([
      panel.locator(":scope > .rusty-connections").getByText("Synced", { exact: true }).waitFor({ timeout: 45_000 }),
      panel.getByRole("alert").waitFor({ timeout: 45_000 }).then(async () => { throw new Error(await panel.getByRole("alert").innerText()) }),
    ])
    await page.goto(`${reflux}/workflows/job-search-automation`)
    await page.getByRole("button", { name: "Sign in with MetaMesh Identity", exact: true }).click()
    await page.waitForURL(url => url.origin === identityOrigin && url.pathname === "/login")
    const encoded = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("request")!
    const request = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
    const approval = JSON.parse(execFileSync(resolve(refluxRoot, "node_modules/.bin/tsx"), [
      resolve(refluxRoot, "e2e/support/create_identity_login_approval.mjs"),
    ], { cwd: refluxRoot, input: JSON.stringify(request), encoding: "utf8", env: { ...process.env, IDENTITY_APPROVAL_SEED: "7" } }))
    await page.goto(approval.callbackUrl)
    await expect(page).toHaveURL(`${reflux}/workflows/job-search-automation`)
    await page.getByRole("button", { name: /^(?:Connect a|Change) Tincanban board$/ }).click()
    await page.waitForURL(url => url.origin === baseURL && url.pathname === "/automation/connect")
    const consent = page.getByRole("dialog", { name: "Connect automation", exact: true })
    await expect(consent).toContainText("Sources: website, email")
    await expect(consent.getByLabel("Board", { exact: true })).toContainText("Existing bridge board")
    await consent.getByRole("button", { name: "Connect workflow", exact: true }).click()
    await Promise.race([
      page.waitForURL(url => url.origin === reflux && url.pathname === "/workflows/job-search-automation" && url.searchParams.has("automation_connection"), { timeout: 90_000 }),
      consent.getByRole("alert").waitFor({ timeout: 90_000 }).then(async () => { throw new Error(await consent.getByRole("alert").innerText()) }),
    ])
    await expect(page.getByRole("status").filter({ hasText: "Tincanban board connected." })).toBeVisible()
    const website = runFixture("submit_website_ingress_e2e.exs")
    expect(website).toMatchObject({ run_status: "completed", signal_count: 1, run_count: 1 })
    await syncBoard()
    const leadCard = page.getByRole("region", { name: "Lead", exact: true }).locator("[data-item-id]").filter({
      has: page.getByRole("button", { name: /^Open Nacre Light Integration GmbH — Principal Systems Engineer/ }),
    })
    await expect(leadCard).toBeVisible({ timeout: 30_000 })
    const cardId = await leadCard.getAttribute("data-item-id")
    expect(cardId).toBeTruthy()
    const sourceEvidence = await page.evaluate(async () => {
      const { useTincanban } = await import("/src/test/stateFixture.ts")
      const workspace = useTincanban()
      await workspace.whenReady()
      const entities = Object.values(workspace.getActiveDoc()!.entities)
      return {
        grantVersions: entities.filter(value => value.kind === "automation")
          .map(value => JSON.parse(value.approval).grant.payload.automation.version),
        originals: entities.filter(value => value.kind === "application_source").map(value => {
          const source = JSON.parse(value.data)
          return { phase: source.observation.phase, status: source.observation.status, reason: source.observation.reason }
        }),
      }
    })
    expect(sourceEvidence.grantVersions).toEqual([2])
    expect(sourceEvidence.originals, JSON.stringify(sourceEvidence)).toContainEqual({ phase: "original", status: "available", reason: undefined })
    const evidence = runFixture("submit_email_ingress_e2e.exs")
    expect(evidence).toMatchObject({ run_status: "completed", signal_count: 1, run_count: 1, replay_duplicate: true })
    await syncBoard()
    await expect(page.getByRole("region", { name: "Applied", exact: true }).locator(`[data-item-id="${cardId}"]`)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("button", { name: /^Open Nacre Light Integration GmbH — Principal Systems Engineer/ })).toHaveCount(1)

    async function syncBoard() {
      await page.goto(boardUrl)
      await page.getByRole("button", { name: "Sync", exact: true }).click()
      const storage = page.getByRole("region", { name: "Rusty", exact: true })
      await expect(storage.getByRole("button", { name: "Sync now", exact: true })).toBeEnabled()
      await storage.getByRole("button", { name: "Sync now", exact: true }).click()
      await expect(storage.getByRole("button", { name: "Sync now", exact: true })).toBeEnabled()
      await page.getByRole("dialog", { name: "Device sync", exact: true }).getByRole("button", { name: "Close", exact: true }).click()
    }
    const automation = await page.evaluate(async () => {
      const { useTincanban } = await import("/src/test/stateFixture.ts")
      const workspace = useTincanban()
      await workspace.whenReady()
      return Object.values(workspace.getActiveDoc()!.entities).filter(value => value.kind === "automation")
        .map(value => JSON.parse(value.approval).definition.payload)
    })
    expect(automation).toHaveLength(1)
    expect(automation[0]).toMatchObject({ type: "job-intake", typeVersion: 2, parameters: { sources: ["website", "email"] } })
  } finally { await rusty.close() }
})

function runFixture(filename: string) {
  const output = execFileSync("mix", ["run", `test/support/${filename}`], {
    cwd: refluxRoot, encoding: "utf8", timeout: 90_000,
    env: { ...process.env, MIX_ENV: "e2e", PORT: "4103", E2E_BASE_URL: reflux,
      E2E_DATABASE_NAME: process.env.REFLUX_E2E_DATABASE_NAME ?? "acidreflux_reflux_bridge_e2e_v2",
      E2E_AUTOMATION_OWNER_PERSON_ID: "_oEsEvOrTOasXbaaw1L5BssbEe9D-zPiUu9_9VImOIk",
      E2E_WEBSITE_ORIGIN: process.env.E2E_WEBSITE_ORIGIN ?? "https://website.example.test",
      ACIDREFLUX_TINCANBAN_APPLICATION_ORIGIN: `http://127.0.0.1:${process.env.TINCANBAN_REFLUX_E2E_PORT ?? 48926}`,
      TINCANBAN_REACTION_ENGINE_PATH: process.env.TINCANBAN_REACTION_ENGINE_PATH },
  })
  return JSON.parse(output.split("\n").findLast(line => line.startsWith("{") && line.includes('"run_count"')) ?? "null")
}
