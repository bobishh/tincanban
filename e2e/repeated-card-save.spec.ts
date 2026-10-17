import { expect, test } from "./support/coverage"
import { populatedBoard } from "./support/detailedBoard"
import type { Page } from "@playwright/test"

async function savedJournal(page: Page) {
  return page.evaluate(async () => {
    const id = (await import("/src/test/stateFixture.ts")).useTincanban().activeWorkspace.id
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("tincanban-workspace-state")
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const read = db.transaction(["snapshots", "authorizations", "frontiers"], "readonly")
    const get = <T>(name: string) => new Promise<T>(resolve => {
      const request = read.objectStore(name).get(id)
      request.onsuccess = () => resolve(request.result)
    })
    const [snapshot, proofs, frontier] = await Promise.all([
      get<{ savedAt: string; bytes: Uint8Array }>("snapshots"),
      get<{ records: unknown[] }>("authorizations"),
      get<{ revision: number } | undefined>("frontiers"),
    ])
    db.close()
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(snapshot.bytes)))
    return { savedAt: snapshot.savedAt, snapshotHash: Array.from(digest).join(","),
      basisProofCount: proofs.records.length, revision: frontier?.revision ?? 0 }
  })
}

test("Given a detailed board, two enrolled certificates and ten idle minutes, when Lead and Applied alternate repeatedly, then every transition persists without history replay or renewed access serialization", async ({ page }, info) => {
  test.setTimeout(120_000)
  await populatedBoard(page, true)
  await page.evaluate(async () => {
    const app = (await import("/src/test/stateFixture.ts")).useTincanban()
    const identity = await import("/src/domain/identity.ts")
    const proofs = await import("/src/domain/proofs.ts")
    const profile = app.getCurrentProfile()!
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair
    const key = identity.toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)))
    const second = await proofs.createDelegatedCertificate(profile.privateKeys.devicePrivateKey, profile.device.deviceId,
      profile.identity.personId, await identity.publicKeyId(key), key, await proofs.certHashDefault(profile.certificate))
    const certificates = [profile.certificate, second].sort((a, b) => b.signature.localeCompare(a.signature))
    proofs.defaultProofStore.listCertificates = async () => certificates
    await app.reclassifyWorkspace(app.activeWorkspace.id)
    await (await import("/src/sync/changeAuthorization.ts")).workspaceRole(app.getActiveDoc()!, profile)
    ;(await import("/src/sync/meshTrace.ts")).clearMeshTrace()
  })
  const idleAccess = await page.evaluate(async () => {
    const app = (await import("/src/test/stateFixture.ts")).useTincanban()
    const { workspaceRole } = await import("/src/sync/changeAuthorization.ts")
    const now = Date.now, send = Worker.prototype.postMessage
    let requests = 0
    Worker.prototype.postMessage = function(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      if (message && typeof message === "object" && "kind" in message && message.kind === "access") requests++
      Reflect.apply(send, this, [message, options])
    }
    Date.now = () => now() + 600_000
    try { return { role: await workspaceRole(app.getActiveDoc()!, app.getCurrentProfile()!), requests } }
    finally { Date.now = now; Worker.prototype.postMessage = send }
  })
  expect(idleAccess).toEqual({ role: "owner", requests: 0 })
  const before = await savedJournal(page)
  await page.getByRole("button", { name: "Open Performance card 0", exact: true }).click()
  const detail = page.getByRole("dialog", { name: "Item overview", exact: true })
  const timings: Array<{ stage: string; elapsedMs: number }> = []
  for (const stage of ["Lead", "Applied", "Lead", "Applied", "Lead", "Applied"]) {
    const start = performance.now()
    await detail.getByRole("button", { name: stage, exact: true }).click()
    await expect(detail.getByRole("button", { name: stage, exact: true })).toHaveAttribute("aria-pressed", "true")
    await expect(detail.getByRole("status")).toHaveCount(0)
    await expect(detail.getByRole("alert")).toHaveCount(0)
    timings.push({ stage, elapsedMs: Math.round(performance.now() - start) })
  }
  const historyReplays = await page.evaluate(async () => (await import("/src/sync/meshTrace.ts")).meshTraceSnapshot()
    .filter(event => event.event === "workspace.admission.started"))
  expect(historyReplays).toEqual([])
  const after = await savedJournal(page)
  expect(after.savedAt).toBe(before.savedAt)
  expect(after.snapshotHash).toBe(before.snapshotHash)
  expect(after.basisProofCount).toBe(before.basisProofCount)
  expect(after.revision).toBe(before.revision + 6)
  await info.attach("repeated-save-timings", { body: JSON.stringify(timings), contentType: "application/json" })
  await page.reload()
  await expect(page.getByRole("region", { name: "Applied", exact: true }).getByRole("button", { name: "Open Performance card 0", exact: true })).toBeVisible({ timeout: 30_000 })
  const coldReplays = await page.evaluate(async () => (await import("/src/sync/meshTrace.ts")).meshTraceSnapshot()
    .filter(event => event.event === "workspace.admission.started"))
  expect(coldReplays).toEqual([])
})
