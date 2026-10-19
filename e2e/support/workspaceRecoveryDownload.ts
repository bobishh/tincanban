import type { Download, Locator, Page } from "@playwright/test"

const SOURCE_CHANGED = "Workspace changed during private recovery export; retry when changes settle"
const DEADLINE_ERROR = "Private workspace backup exceeded its 60-second deadline"
const SOURCE_QUIET_MS = 2_000
const REVISION_SAMPLE_MS = 100
type Binding = { personId: string; deviceId: string; workspaceId: string }
type Outcome = { kind: "download"; download: Download } | { kind: "message"; message: string } |
  { kind: "failed"; error: unknown } | { kind: "cancelled" }

class BackupObservation {
  readonly result: Promise<Outcome>
  private resolve!: (outcome: Outcome) => void
  private finished = false
  private poll?: ReturnType<typeof setTimeout>
  private timer: ReturnType<typeof setTimeout>
  private readonly downloaded = (download: Download) => this.finish({ kind: "download", download })
  private readonly closed = () => this.finish({ kind: "failed", error: new Error("Backup source page closed") })
  constructor(private readonly page: Page, private readonly panel: Locator, deadline: number) {
    this.result = new Promise(resolve => { this.resolve = resolve })
    this.timer = setTimeout(() => this.finish({ kind: "failed", error: new Error(DEADLINE_ERROR) }), Math.max(0, deadline - Date.now()))
    page.on("download", this.downloaded); page.on("close", this.closed)
  }
  observeErrors() { void this.checkError() }
  cancel() { this.finish({ kind: "cancelled" }) }
  private finish(outcome: Outcome) {
    if (this.finished) return
    this.finished = true
    clearTimeout(this.timer); clearTimeout(this.poll)
    this.page.off("download", this.downloaded); this.page.off("close", this.closed)
    this.resolve(outcome)
  }
  private async checkError() {
    try {
      // Query without waiting for an absent alert. Every poll and event listener is cancelled on an outcome.
      const messages = await this.panel.getByRole("alert").allTextContents()
      if (this.finished) return
      if (messages.length) this.finish({ kind: "message", message: messages.join("\n").trim() })
      else this.poll = setTimeout(() => { void this.checkError() }, 50)
    } catch (error) { this.finish({ kind: "failed", error }) }
  }
}

async function withinDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(DEADLINE_ERROR)), Math.max(0, deadline - Date.now()))
    })])
  } finally { clearTimeout(timer) }
}

async function settleSourceWrites(page: Page, binding: Binding, deadline: number) {
  await page.evaluate(async ({ expected, quietMs, sampleMs, deadline, deadlineError }) => {
    const state = (await import("/src/test/stateFixture.ts")).useTincanban()
    const current = () => {
      const profile = state.getCurrentProfile()
      if (state.activeWorkspace.id !== expected.workspaceId || profile?.identity.personId !== expected.personId ||
          profile.device.deviceId !== expected.deviceId) throw new Error("Backup identity or workspace changed")
    }
    current()
    await (await import("/src/workspaceMutation.ts")).withWorkspaceMutation(expected.workspaceId, async () => {})
    current()
    const storage = (await import("/src/storage.ts")).defaultStorage
    let revision = await storage.readWorkspaceRevision(expected.workspaceId) ?? null
    let unchangedSince = Date.now()
    while (Date.now() - unchangedSince < quietMs) {
      if (Date.now() >= deadline) throw new Error(deadlineError)
      await new Promise(resolve => setTimeout(resolve, sampleMs))
      current()
      const nextRevision = await storage.readWorkspaceRevision(expected.workspaceId) ?? null
      if (nextRevision !== revision) {
        revision = nextRevision
        unchangedSince = Date.now()
      }
    }
    current()
  }, { expected: binding, quietMs: SOURCE_QUIET_MS, sampleMs: REVISION_SAMPLE_MS, deadline, deadlineError: DEADLINE_ERROR })
}

/** A rejected concurrent capture is discarded; only its exact Retry action can start a fresh complete file. */
export async function downloadPrivateWorkspaceRecovery(page: Page, panel: Locator): Promise<Download> {
  const deadline = Date.now() + 60_000
  const binding = await withinDeadline(page.evaluate(async () => {
    const state = (await import("/src/test/stateFixture.ts")).useTincanban(), profile = state.getCurrentProfile()
    if (!profile) throw new Error("Backup identity or workspace changed")
    return { personId: profile.identity.personId, deviceId: profile.device.deviceId, workspaceId: state.activeWorkspace.id }
  }), deadline)
  await withinDeadline(settleSourceWrites(page, binding, deadline), deadline)
  for (let attempt = 0; attempt < 3; attempt++) {
    if (Date.now() >= deadline) throw new Error(DEADLINE_ERROR)
    const observation = new BackupObservation(page, panel, deadline)
    let outcome: Outcome
    try {
      await panel.getByRole("button", { name: attempt ? "Retry private backup" : "Create private recovery backup", exact: true })
        .click({ timeout: Math.max(1, deadline - Date.now()) })
      observation.observeErrors()
      outcome = await observation.result
    } finally { observation.cancel() }
    if (outcome.kind === "download") return outcome.download
    if (outcome.kind === "failed") throw outcome.error
    if (outcome.kind !== "message") throw new Error("Private workspace backup observation cancelled")
    if (outcome.message !== SOURCE_CHANGED || attempt === 2) throw new Error(`Private workspace backup failed: ${outcome.message}`)
    await withinDeadline(settleSourceWrites(page, binding, deadline), deadline)
  }
  throw new Error(DEADLINE_ERROR)
}
