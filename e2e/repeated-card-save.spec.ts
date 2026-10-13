import { expect, test } from "./support/coverage"
import { populatedBoard } from "./support/detailedBoard"

test("Given a detailed board and two enrolled device certificates, when Archive and Applied alternate repeatedly, then every transition persists without history replay", async ({ page }, info) => {
  test.setTimeout(120_000)
  await populatedBoard(page, true)
  await page.evaluate(async () => {
    const app = (await import("/src/state.ts")).useTincanban()
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
    ;(await import("/src/sync/meshTrace.ts")).clearMeshTrace()
  })
  await page.getByRole("button", { name: "Open Performance card 0", exact: true }).click()
  const detail = page.getByRole("dialog", { name: "Lead details", exact: true })
  const timings: Array<{ stage: string; elapsedMs: number }> = []
  for (const stage of ["Archive", "Applied", "Archive", "Applied", "Archive", "Applied"]) {
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
  await info.attach("repeated-save-timings", { body: JSON.stringify(timings), contentType: "application/json" })
  await page.reload()
  await expect(page.getByRole("region", { name: "Applied", exact: true }).getByRole("button", { name: "Open Performance card 0", exact: true })).toBeVisible({ timeout: 30_000 })
})
