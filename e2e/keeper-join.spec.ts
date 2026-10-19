import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Automerge from "@automerge/automerge"
import { expect, test, type Page } from "./support/coverage"
import { validateWorkspaceDoc } from "../src/domain/model"
import { ensureJobSearchWorkspace } from "./support/workspaces"

const manifest = "crates/tincanban-lighthouse/Cargo.toml"
test.use({ trace: "retain-on-failure" })

function lighthouse(...args: string[]) {
  return spawn("cargo", ["run", "--quiet", "--manifest-path", manifest, "--", ...args], {
    cwd: process.cwd(), stdio: "pipe",
  }) as ChildProcessWithoutNullStreams
}

function output(process: ChildProcessWithoutNullStreams, pattern: RegExp, timeoutMs = 60_000) {
  return new Promise<string>((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => finish(new Error(`Lighthouse output timed out: ${stderr}`)), timeoutMs)
    const onData = (chunk: Buffer) => {
      stdout += String(chunk)
      if (pattern.test(stdout)) finish()
    }
    const onError = (chunk: Buffer) => { stderr += String(chunk) }
    const onExit = (code: number | null) => finish(new Error(`Lighthouse exited ${code}: ${stderr}`))
    const finish = (error?: Error) => {
      clearTimeout(timer)
      process.stdout.off("data", onData)
      process.stderr.off("data", onError)
      process.off("exit", onExit)
      if (error) reject(error)
      else resolve(stdout)
    }
    process.stdout.on("data", onData)
    process.stderr.on("data", onError)
    process.on("exit", onExit)
  })
}

async function addLead(page: Page, company: string) {
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  await page.getByLabel("Company *").fill(company)
  await page.getByLabel("Role *").fill("Engineer")
  await page.getByRole("button", { name: "Create item" }).click()
  await page.getByRole("button", { name: "Close detail" }).click()
}

async function stateContains(path: string, company: string) {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as { document: number[] }
    const document = Automerge.load(Uint8Array.from(state.document))
    return JSON.stringify(Automerge.toJS(document)).includes(company)
  } catch { return false }
}

async function nativeStateStatus(path: string): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "state file present; JSON shape invalid"
    const document: unknown = (parsed as Record<string, unknown>).document
    if (!Array.isArray(document) || !document.every((value: unknown) => typeof value === "number")) {
      return "state file present; document bytes invalid"
    }
    return `state file present; document bytes=${document.length}`
  } catch { return "state file unavailable" }
}

function safeNativeErrors(errors: string): string {
  const lines = errors.split(/\r?\n/).filter(Boolean).slice(-12).map(line => line
    .replace(/Lighthouse (connect|publish) to \S+/g, "Lighthouse $1 to [peer]")
    .replace(/Lighthouse handshake with \S+/g, "Lighthouse handshake with [peer]")
    .slice(0, 300))
  return lines.join("\n") || "(none)"
}

async function stop(process: ChildProcessWithoutNullStreams | undefined) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return
  const exited = once(process, "exit")
  process.kill("SIGINT")
  await exited
}

test("Given a tincanban invitation, when native lighthouse joins and restarts, then it exchanges board changes both ways", async ({ page }) => {
  test.setTimeout(180_000)
  const temporary = await mkdtemp(join(tmpdir(), "tincanban-lighthouse-e2e-"))
  const directory = join(temporary, "node")
  let server: ChildProcessWithoutNullStreams | undefined
  let joining: ChildProcessWithoutNullStreams | undefined
  let serverErrors = ""
  try {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    await addLead(page, "Before lighthouse")
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Device sync" })
    await dialog.getByRole("button", { name: "Add someone" }).click()
    await dialog.getByRole("button", { name: "Generate link" }).click()
    const invite = await dialog.getByLabel("Pairing link").inputValue()

    joining = lighthouse("join", invite, directory)
    const joined = output(joining, /Lighthouse joined/, 90_000)
    await page.getByLabel("Participant role").selectOption("editor")
    await page.getByRole("button", { name: "Approve access" }).click()
    await joined
    joining = undefined
    const state = join(directory, "state.json")
    await expect.poll(() => stateContains(state, "Before lighthouse")).toBe(true)
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click()

    server = lighthouse(join(directory, "config.json"))
    server.stderr.on("data", chunk => { serverErrors += String(chunk) })
    await output(server, /Lighthouse .* listening/, 30_000)
    await addLead(page, "Live lighthouse")
    await expect.poll(() => stateContains(state, "Live lighthouse"), { timeout: 25_000 }).toBe(true)
      .catch(error => { throw new Error(`${error}\nNative errors: ${serverErrors}`) })

    await stop(server)
    server = undefined
    await addLead(page, "After lighthouse restart")
    server = lighthouse(join(directory, "config.json"))
    server.stderr.on("data", chunk => { serverErrors += String(chunk) })
    await output(server, /Lighthouse .* listening/, 30_000)
    await expect.poll(() => stateContains(state, "After lighthouse restart"), { timeout: 30_000 }).toBe(true)
      .catch(error => { throw new Error(`${error}\nNative errors: ${serverErrors}`) })

    await stop(server)
    server = undefined
    const retained = JSON.parse(await readFile(state, "utf8")) as { document: number[] }
    const configured = Automerge.toJS(Automerge.load(Uint8Array.from(retained.document))) as any
    const board = Object.values(configured.entities).find((entity: any) => entity.kind === "board") as any
    const bindings = board.preset.bindings
    joining = lighthouse("create-item", join(directory, "config.json"), bindings["status.lead"], "From lighthouse — Engineer", JSON.stringify({
      [bindings["field.company"]]: "From lighthouse", [bindings["field.role"]]: "Engineer",
    }))
    await output(joining, /Created item/, 30_000)
    joining = undefined
    await expect.poll(() => stateContains(state, "From lighthouse")).toBe(true)
    const nativeState = JSON.parse(await readFile(state, "utf8")) as { document: number[] }
    const nativeDocument = Automerge.load(Uint8Array.from(nativeState.document))
    const nativeValidation = validateWorkspaceDoc(Automerge.toJS(nativeDocument))
    const nativeView = Automerge.toJS(nativeDocument) as { entities: Record<string, unknown> }
    const nativeLead = Object.entries(nativeView.entities).find(([id]) => id.startsWith("item-"))
    expect(nativeValidation.ok, JSON.stringify({ nativeValidation, nativeLead })).toBe(true)
    server = lighthouse(join(directory, "config.json"))
    server.stderr.on("data", chunk => { serverErrors += String(chunk) })
    await output(server, /Lighthouse .* listening/, 30_000)
    await expect(page.getByText("From lighthouse", { exact: false }).first()).toBeVisible({ timeout: 30_000 })
      .catch(async error => {
        await page.getByRole("button", { name: "Sync", exact: true }).click()
        const diagnostic = await page.getByRole("dialog", { name: "Device sync" }).innerText()
        throw new Error(`${error}\nNative errors: ${serverErrors}\nBrowser sync: ${diagnostic}`)
      })
  } finally {
    await stop(joining)
    await stop(server)
    await rm(temporary, { recursive: true, force: true })
  }
})

test("Given owner and editor share a fresh board, when owner closes, then editor syncs with lighthouse", async ({ browser, page }) => {
  test.setTimeout(150_000)
  const temporary = await mkdtemp(join(tmpdir(), "tincanban-keeper-e2e-"))
  const directory = join(temporary, "node")
  const guestContext = await browser.newContext()
  await guestContext.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  const guest = await guestContext.newPage()
  let server: ChildProcessWithoutNullStreams | undefined
  let joining: ChildProcessWithoutNullStreams | undefined
  let serverErrors = ""
  try {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const ownerDialog = page.getByRole("dialog", { name: "Device sync" })
    await ownerDialog.getByRole("button", { name: "Add someone" }).click()
    await ownerDialog.getByRole("button", { name: "Generate link" }).click()
    joining = lighthouse("join", await ownerDialog.getByLabel("Pairing link").inputValue(), directory)
    const joined = output(joining, /Lighthouse joined/, 90_000)
    await page.getByLabel("Participant role").selectOption("editor")
    await page.getByRole("button", { name: "Approve access" }).click()
    await joined
    joining = undefined
    await ownerDialog.getByRole("button", { name: "Close", exact: true }).first().click()
    server = lighthouse(join(directory, "config.json"))
    server.stderr.on("data", chunk => { serverErrors += String(chunk) })
    await output(server, /Lighthouse .* listening/, 30_000)
    await addLead(page, "Owner online")
    const state = join(directory, "state.json")
    await expect.poll(() => stateContains(state, "Owner online"), { timeout: 25_000 }).toBe(true)
      .catch(async error => {
        throw new Error(`${error}\nNative state: ${await nativeStateStatus(state)}\nNative errors:\n${safeNativeErrors(serverErrors)}`)
      })

    await page.getByRole("button", { name: "Sync", exact: true }).click()
    await ownerDialog.getByRole("button", { name: "Add someone" }).click()
    await ownerDialog.getByRole("button", { name: "Generate link" }).click()
    await guest.goto(await ownerDialog.getByLabel("Pairing link").inputValue())
    const guestDialog = guest.getByRole("dialog", { name: "Device sync" })
    await guestDialog.getByRole("button", { name: "Accept and join" }).click()
    await page.getByLabel("Participant role").selectOption("editor")
    await page.getByRole("button", { name: "Approve access" }).click()
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
      .catch(async error => {
        throw new Error(`${error}\nOwner sync: ${await ownerDialog.innerText()}\nGuest sync: ${await guestDialog.innerText()}\nNative errors: ${serverErrors}`)
      })
    await guestDialog.getByRole("button", { name: "Close", exact: true }).first().click()
    await expect(guest.getByRole("button", { name: "Open Owner online — Engineer" })).toBeVisible({ timeout: 30_000 })
    await page.close()
    await addLead(guest, "Owner offline")
    await expect.poll(() => stateContains(state, "Owner offline"), { timeout: 40_000 }).toBe(true)
      .catch(error => { throw new Error(`${error}\nNative errors: ${serverErrors}`) })
    await stop(server)
    server = undefined
    await addLead(guest, "Lighthouse offline")
    server = lighthouse(join(directory, "config.json"))
    server.stderr.on("data", chunk => { serverErrors += String(chunk) })
    await output(server, /Lighthouse .* listening/, 30_000)
    await expect.poll(() => stateContains(state, "Lighthouse offline"), { timeout: 40_000 }).toBe(true)
      .catch(error => { throw new Error(`${error}\nNative errors: ${serverErrors}`) })
  } finally {
    await stop(joining)
    await stop(server)
    await guestContext.close()
    await rm(temporary, { recursive: true, force: true })
  }
})
