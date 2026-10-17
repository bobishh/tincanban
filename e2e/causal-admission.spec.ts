import { expect, test } from "./support/coverage"

test("Given an offline editor change accepted before revocation, when the signed revocation arrives, then the projection retracts and review creates a new authorized change", async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()

  const fixture = await page.evaluate(async () => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    const { executeCommand } = await import("/src/domain/commands.ts")
    const { createWorkspaceGrant, createWorkspaceDeviceRevocation } = await import("/vendor/meta-mesh/packages/mesh-workspace/src/index.ts")
    const { profileFromIdentitySeedForDevice } = await import("/vendor/meta-mesh/packages/mesh-identity/src/index.ts")
    const { canonicalizeJson, sha256Base64Url, signEnvelope } = await import("/src/domain/identity.ts")
    const { resolveSigningContext } = await import("/src/domain/signingContext.ts")
    const { exportAuthorizationBundle, prepareLocalChangeAuthorizations } = await import("/src/sync/changeAuthorization.ts")
    const { peerStore } = await import("/src/sync/peerStore.ts")
    const A = await import("/@id/@automerge/automerge/slim")
    let stage = "initialize"
    try {

    const app = useTincanban()
    await app.whenReady()
    const owner = app.getCurrentProfile()!
    let base = app.getActiveDoc()!
    const column = Object.values(base.entities).find(entity => entity.kind === "column")!
    stage = "seed owner item"
    await app.executeCommandAsync({ kind: "createItem", parentId: column.id, title: "Baseline item" })
    base = app.getActiveDoc()!
    const item = Object.values(base.entities).find(entity => "title" in entity && entity.title === "Baseline item")!
    const originalTitle = base.title
    const editor = await profileFromIdentitySeedForDevice(new Uint8Array(32).fill(31), "Offline editor", new Uint8Array(32).fill(32))
    const grant = await createWorkspaceGrant(owner, base.id, editor.identity.personId, "editor", 1)
    const grantHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(grant)))
    // Automerge actor IDs are hex strings; device IDs are base64url hashes.
    const editorBase = A.clone(base, crypto.randomUUID().replaceAll("-", ""))
    stage = "create editor change"
    const editorSigningContext = async (purpose: "actor-binding" | "change-proof", binding: Record<string, string | number>) =>
      resolveSigningContext({ profile: editor, certificates: [editor.certificate], purpose, binding, authorityRevision: "fixture-authorized-editor",
        current: async () => ({ personId: editor.identity.personId, deviceId: editor.device.deviceId, authorityRevision: "fixture-authorized-editor" }) })
    const command = await executeCommand(editorBase, { kind: "patchItem", entityId: item.id, title: "Offline editor draft" }, editor, editor.device.deviceId, grantHash, editorSigningContext)
    if (!command.ok) throw new Error(command.error.message)
    const changeHash = command.value.receipt.changeHash
    const proof = await signEnvelope(editor.privateKeys.devicePrivateKey, {
      kind: "workspace-changes" as const, version: 1 as const, workspaceId: base.id,
      hashes: [changeHash], personId: editor.identity.personId, deviceId: editor.device.deviceId,
    }, editor.device.deviceId)
    const authorization = {
      signed: proof, publicKey: editor.identity.publicKey, certificates: [editor.certificate], grant,
      ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate],
    }
    const remoteBytes = A.save(command.value.newDoc)
    const bundle = await exportAuthorizationBundle(A.save(base), owner)
    stage = "accept pre-revocation editor change"
    await app.mergeAuthorizedWorkspace(base.id, remoteBytes, { ...bundle, records: [...bundle.records, authorization] })

    // A valid owner change depends on the editor's accepted change. It must
    // become dependency-pending when that parent is later quarantined.
    const ownerBranch = A.clone(command.value.newDoc, crypto.randomUUID().replaceAll("-", ""))
    const ownerCommand = await executeCommand(ownerBranch,
      { kind: "patchItem", entityId: item.id, body: "Owner follow-up waits for review" }, owner, owner.device.deviceId)
    if (!ownerCommand.ok) throw new Error(ownerCommand.error.message)
    const dependentHash = ownerCommand.value.receipt.changeHash
    const ownerProof = await prepareLocalChangeAuthorizations(ownerCommand.value.newDoc, owner, [dependentHash])
    const dependentBytes = A.save(ownerCommand.value.newDoc)
    const dependentBundle = await exportAuthorizationBundle(dependentBytes, owner)
    stage = "accept owner descendant before revocation"
    await app.mergeAuthorizedWorkspace(base.id, dependentBytes,
      { ...dependentBundle, records: [...dependentBundle.records, ...ownerProof] })

    stage = "sign owner revocation"
    const revocation = await createWorkspaceDeviceRevocation(owner, base.id, editor.identity.personId,
      editor.device.deviceId, A.getHeads(base), [owner.certificate])
    const authority = await peerStore.getWorkspaceAuthority(base.id)
    if (!authority) throw new Error("Owner workspace authority is missing")
    const catalog = (authority.catalog ?? {}) as { deviceRevocations?: unknown[] }
    stage = "persist owner revocation"
    await peerStore.putWorkspaceAuthority({ ...authority, updatedAt: new Date().toISOString(), catalog: {
      ...catalog, deviceRevocations: [...(catalog.deviceRevocations ?? []), { record: revocation.record, authority: revocation.authority }],
    } })

    // Re-run admission over the already persisted raw history using the newly
    // durable owner-signed frontier. This is the late-evidence arrival order.
    stage = "reclassify after revocation"
    await app.reclassifyWorkspace(base.id)
    const { WorkspaceStorage } = await import("/src/storage.ts")
    const storage = new WorkspaceStorage()
    const raw = await storage.loadCausalEvidence(base.id)
    const projected = await storage.loadWorkspaceDoc(base.id)
    if (!raw || !projected) throw new Error("Causal evidence was not durably committed")
    stage = "verify raw evidence"
    stage = "return fixture"
    return {
      workspaceId: base.id,
      originalTitle,
      changeHash,
      dependentHash,
      rawBytes: Array.from(raw.bytes),
      decision: raw.decisions.find(item => item.hash === changeHash)?.status.type,
      dependentDecision: raw.decisions.find(item => item.hash === dependentHash)?.status.type,
      projectedTitle: projected.doc.title,
      projectedItemTitle: (projected.doc.entities[item.id] as { title?: string } | undefined)?.title,
      baselineItemTitle: item.title,
      itemId: item.id,
    }
    } catch (error) { throw new Error(`${stage}: ${error instanceof Error ? error.stack : String(error)}`, { cause: error }) }
  })

  await expect(page.getByRole("region", { name: "Workspace change review" })).toBeVisible()
  const review = page.getByRole("region", { name: "Workspace change review" })
  await review.getByText("2 workspace changes need review", { exact: true }).click()
  const originalEntry = review.locator("li").filter({ hasText: fixture.changeHash })
  await expect(originalEntry.getByRole("list", { name: "Draft field changes" })).toContainText("Offline editor draft")
  const dependentEntry = review.locator("li").filter({ hasText: fixture.dependentHash })
  await expect(dependentEntry.getByText("Waiting for dependency", { exact: true })).toBeVisible()
  await expect(dependentEntry.getByRole("list", { name: "Draft field changes" })).toContainText("Owner follow-up waits for review")
  await expect(dependentEntry.getByRole("button", { name: "Create authorized change from this review" })).toHaveCount(0)
  expect(fixture.decision).toBe("quarantined")
  expect(fixture.dependentDecision).toBe("pending")
  expect(fixture.projectedTitle).toBe(fixture.originalTitle)
  expect(fixture.projectedItemTitle).toBe(fixture.baselineItemTitle)
  await expect.poll(() => page.evaluate(async () => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    await useTincanban().whenReady()
    return useTincanban().getActiveDoc()!.title
  })).toBe(fixture.originalTitle)

  // The raw graph, its immutable change bytes, and classification survive a
  // cold reload even though the user-facing projection excluded that change.
  await page.reload()
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
  const reloadedReview = page.getByRole("region", { name: "Workspace change review" })
  await reloadedReview.getByText("2 workspace changes need review", { exact: true }).click()
  const afterReload = await page.evaluate(async hash => {
    const { WorkspaceStorage } = await import("/src/storage.ts")
    const evidence = await new WorkspaceStorage().loadCausalEvidence((await import("/src/test/stateFixture.ts")).useTincanban().activeWorkspace.id)
    if (!evidence) throw new Error("Causal evidence disappeared on reload")
    return { sameRawBytes: Array.from(evidence.bytes).join(",") === hash.rawBytes.join(","),
      decision: evidence.decisions.find(item => item.hash === hash.changeHash)?.status.type,
      dependentDecision: evidence.decisions.find(item => item.hash === hash.dependentHash)?.status.type }
  }, fixture)
  expect(afterReload).toEqual({ sameRawBytes: true, decision: "quarantined", dependentDecision: "pending" })
  await expect(reloadedReview.locator("li").filter({ hasText: fixture.changeHash })
    .getByRole("list", { name: "Draft field changes" })).toContainText("Offline editor draft")

  // A checkpoint from an older policy requires a new durable classification.
  // Unchanged current-policy reads no longer need a storage write at all.
  await page.evaluate(async () => {
    const app = (await import("/src/test/stateFixture.ts")).useTincanban()
    const storage = (await import("/src/storage.ts")).defaultStorage
    const A = await import("/@id/@automerge/automerge/slim")
    const doc = app.getActiveDoc()!
    const evidence = (await storage.loadCausalEvidence(doc.id))!
    evidence.admissionCheckpoint!.policy = "previous-policy"
    await storage.commitWorkspace(doc.id, doc, A.save(doc), [], undefined, evidence)
    ;(window as Window & { __TINCANBAN_INJECT_STORAGE_FAILURE__?: boolean }).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true
  })
  const retryError = await page.evaluate(async id => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    try { await useTincanban().reclassifyWorkspace(id); return "unexpected success" }
    catch (error) { return String(error) }
  }, fixture.workspaceId)
  expect(retryError).toMatch(/Storage failure injected/)
  await expect(page.getByRole("alert")).toContainText(/Access update pending|could not be reclassified/i)
  await page.evaluate(() => { delete (window as Window & { __TINCANBAN_INJECT_STORAGE_FAILURE__?: boolean }).__TINCANBAN_INJECT_STORAGE_FAILURE__ })
  await page.reload()
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
  const retriedReview = page.getByRole("region", { name: "Workspace change review" })
  await retriedReview.getByText("2 workspace changes need review", { exact: true }).click()
  await expect(retriedReview.locator("li").filter({ hasText: fixture.changeHash })
    .getByRole("list", { name: "Draft field changes" })).toContainText("Offline editor draft")

  await page.getByRole("button", { name: "Create authorized change from this review" }).click()
  await expect.poll(() => page.evaluate(async hash => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    const { WorkspaceStorage } = await import("/src/storage.ts")
    const A = await import("/@id/@automerge/automerge/slim")
    const app = useTincanban()
    await app.whenReady()
    const doc = app.getActiveDoc()!
    const evidence = await new WorkspaceStorage().loadCausalEvidence(doc.id)
    if (!evidence) throw new Error("Missing causal evidence after review")
    const metadata = A.getChangesMetaSince(doc, []).map(change => ({ hash: change.hash, message: change.message }))
    const source = evidence.decisions.find(item => item.hash === hash.changeHash)
    const reviewChange = metadata.find(change => {
      try { return (JSON.parse(change.message ?? "") as { sourceChangeHash?: string }).sourceChangeHash === hash.changeHash }
      catch { return false }
    })
    return { sourceStatus: source?.status.type, reviewHash: reviewChange?.hash,
      projectedItemTitle: (doc.entities[hash.itemId] as { title?: string } | undefined)?.title,
      hasNewSignedAuthorization: evidence.authorizationEvidence.some(record => record.signed.payload.hashes.includes(reviewChange?.hash ?? "")) }
  }, fixture), { timeout: 15_000 }).toMatchObject({ sourceStatus: "quarantined", reviewHash: expect.any(String),
    projectedItemTitle: "Offline editor draft", hasNewSignedAuthorization: true })
  const reviewHistory = page.getByRole("region", { name: "Workspace review history" })
  await expect(reviewHistory).toContainText(fixture.changeHash)
  await expect(reviewHistory.locator("li").filter({ hasText: fixture.changeHash })).toContainText("Authorized change saved")
  await expect(page.getByRole("region", { name: "Workspace change review" })).toContainText(fixture.dependentHash)
  expect(fixture.rawBytes.length).toBeGreaterThan(0)
})
