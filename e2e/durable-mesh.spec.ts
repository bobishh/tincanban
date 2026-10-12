import * as Automerge from "@automerge/automerge"
import { expect, test, type Browser, type BrowserContext, type Page } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"
import { captureRealIrohNodes, captureSavedAcknowledgements, closeLatestRealIrohNode, documentReceiveAttempts, realIrohNodeOwnership } from "./support/recovery"
import { captureMeshResources, meshResourceCounts } from "./support/meshResources"
import { expectFaviconColor, faviconColor, faviconChanges } from "./support/favicon"

async function addLead(page: Page, company: string) {
  await ensureJobSearchWorkspace(page)
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  await page.getByLabel("Company *").fill(company)
  await page.getByLabel("Role *").fill("Engineer")
  await page.getByRole("button", { name: "Create item" }).click()
  await page.getByRole("button", { name: "Close detail" }).click()
}

async function pairWorkspace(host: Page, guest: Page) {
  await ensureJobSearchWorkspace(host)
  await host.getByRole("button", { name: "Sync", exact: true }).click()
  const hostDialog = host.getByRole("dialog", { name: "Device sync" })
  await hostDialog.getByRole("button", { name: "Add someone" }).click()
  await hostDialog.getByRole("button", { name: "Generate link" }).click()
  const invite = await hostDialog.getByLabel("Pairing link").inputValue()
  await guest.goto(invite)
  const guestDialog = guest.getByRole("dialog", { name: "Device sync" })
  await guestDialog.getByRole("button", { name: "Accept and join" }).click()
  await host.getByLabel("Participant role").selectOption("editor")
  await host.getByRole("button", { name: "Approve access" }).click()
  await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
  await expect(guest.getByLabel("Workspace role: editor")).toBeVisible()
  if (await guestDialog.isVisible()) await guestDialog.getByRole("button", { name: "Close", exact: true }).first().click()
  if (await hostDialog.isVisible()) await hostDialog.getByRole("button", { name: "Close", exact: true }).first().click()
  return invite
}

async function isolatedContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext()
  await context.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  return context
}

async function journalChangeIds(page: Page, workspaceId: string): Promise<string[]> {
  return page.evaluate(async id => {
    const { openWorkspaceJournal, recordsForWorkspace } = await import("/src/storageJournal.ts")
    // The journal module owns this cached connection; observation borrows it.
    const db = await openWorkspaceJournal()
    const records = await recordsForWorkspace<{ changeHash: string }>(db, "changes", id)
    return records.map(record => record.changeHash).sort()
  }, workspaceId)
}

async function persistedLeadExists(page: Page, workspaceId: string, title: string): Promise<boolean> {
  return page.evaluate(async ({ id, expectedTitle }) => {
    const { WorkspaceStorage } = await import("/src/storage.ts")
    const stored = await new WorkspaceStorage().loadWorkspaceDoc(id)
    return Object.values(stored?.doc.entities ?? {}).some(entity => {
      const candidate = entity as { archivedAt?: string | null; title?: string }
      return !candidate.archivedAt && candidate.title === expectedTitle
    })
  }, { id: workspaceId, expectedTitle: title })
}

async function targetDocumentReceives(page: Page, title: string) {
  const records = await documentReceiveAttempts(page)
  return records.filter(record => {
    const doc = Automerge.load<{ entities: Record<string, { archived?: boolean; title?: string }> }>(new Uint8Array(record.document))
    try { return Object.values(doc.entities).some(entity => !entity.archivedAt && entity.title === title) }
    finally { Automerge.free(doc) }
  })
}

async function discardTransportState(page: Page) {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("tincanban-peer-catalog-v1")
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = db.transaction(["node", "peers"], "readwrite")
    const node = transaction.objectStore("node")
    const records = await new Promise<Array<{ key: string }>>((resolve, reject) => {
      const request = node.getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    for (const record of records) if (record.key.startsWith("workspace:")) node.delete(record.key)
    transaction.objectStore("peers").clear()
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    db.close()
  })
}

async function storeUnadmittedRawTitle(page: Page, workspaceId: string, title: string) {
  const snapshot = await page.evaluate(async id => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("tincanban-workspace-state")
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = db.transaction("snapshots", "readonly")
    const request = transaction.objectStore("snapshots").get(id)
    const value = await new Promise<{ bytes: number[] }>((resolve, reject) => {
      request.onsuccess = () => resolve({ bytes: Array.from(request.result.bytes as Uint8Array) })
      request.onerror = () => reject(request.error)
    })
    db.close()
    return value
  }, workspaceId)
  const base = Automerge.load<{ title: string }>(new Uint8Array(snapshot.bytes))
  const candidate = Automerge.change(base, draft => { draft.title = title })
  const changeBytes = Automerge.getLastLocalChange(candidate)
  if (!changeBytes) throw new Error("Expected an unadmitted raw change")
  const changeHash = Automerge.decodeChange(changeBytes).hash
  const rawHeads = Automerge.getHeads(candidate)
  const rawBytes = Array.from(Automerge.save(candidate))
  Automerge.free(candidate)
  await page.evaluate(async ({ id, bytes, hash }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("tincanban-workspace-state")
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = db.transaction("snapshots", "readwrite")
    const store = transaction.objectStore("snapshots")
    const snapshot = await new Promise<{ [key: string]: unknown; causalEvidence?: {
      decisions?: Array<{ hash: string; status: { type: string; reason: string } }>
      authorizationEvidence?: unknown[]
      bytes?: Uint8Array
    } }>((resolve, reject) => {
      const request = store.get(id)
      request.onsuccess = () => resolve(request.result as {
        [key: string]: unknown
        causalEvidence?: { decisions?: Array<{ hash: string; status: { type: string; reason: string } }>; authorizationEvidence?: unknown[]; bytes?: Uint8Array }
      })
      request.onerror = () => reject(request.error)
    })
    const evidence = snapshot.causalEvidence ?? { decisions: [], authorizationEvidence: [] }
    snapshot.causalEvidence = { ...evidence, bytes: new Uint8Array(bytes), decisions: [...(evidence.decisions ?? []),
      { hash, status: { type: "pending", reason: "Untrusted raw candidate" } }]
    }
    store.put(snapshot)
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    db.close()
  }, { id: workspaceId, bytes: rawBytes, hash: changeHash })
  return rawHeads
}

test("Given paired browsers, when a lead changes, then the peer receives the durable board update", async ({ browser, page }) => {
  test.setTimeout(90_000)
  const context = await isolatedContext(browser)
  const guest = await context.newPage()
  try {
    await Promise.all([page.goto("/"), guest.goto("/")])
    await pairWorkspace(page, guest)
    const handoffTrace = await page.evaluate(async () => {
      const { meshTraceSnapshot } = await import("/src/sync/meshTrace.ts")
      return meshTraceSnapshot().filter(event => event.event === "live.session.failed")
    })
    expect(handoffTrace.filter(event => String(event.reason ?? "").includes("mesh-handoff-confirmed")), JSON.stringify(handoffTrace)).toHaveLength(0)
    await addLead(page, "Gossip production path")

    await expect(guest.getByRole("button", { name: "Open Gossip production path — Engineer" })).toBeVisible({ timeout: 30_000 })
  } finally { await context.close() }
})

test("Given a legacy local device without metadata, when Sync opens in a known browser, then it shows the current browser and OS", async ({ browser }) => {
  test.setTimeout(120_000)
  const hostContext = await isolatedContext(browser)
  const guestContext = await isolatedContext(browser)
  await hostContext.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "userAgent", { configurable: true, get: () => "" })
  })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  try {
    await Promise.all([host.goto("/"), guest.goto("/")])
    await pairWorkspace(host, guest)
    await host.evaluate(() => {
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
      })
    })

    await host.getByRole("button", { name: "Sync", exact: true }).click()
    const dialog = host.getByRole("dialog", { name: "Device sync" })
    await dialog.getByRole("list", { name: "Mesh members" }).getByRole("button").filter({ hasText: "You" }).click()
    await expect(dialog.getByRole("list", { name: /Devices for/ })).toContainText("Likely Chrome · Linux")
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()])
  }
})

test("Given a joined workspace with local data, when an editor leaves the mesh, then its copy remains and rejoining requires merge confirmation", async ({ browser, page }) => {
  test.setTimeout(120_000)
  const context = await isolatedContext(browser)
  const guest = await context.newPage()
  try {
    await Promise.all([page.goto("/"), guest.goto("/")])
    await addLead(page, "Kept locally")
    await pairWorkspace(page, guest)

    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const ownerDialog = page.getByRole("dialog", { name: "Device sync" })
    await ownerDialog.getByText("Advanced", { exact: true }).click()
    await expect(ownerDialog.getByRole("button", { name: "Leave mesh" })).toBeDisabled()
    await expect(ownerDialog.getByText("Transfer ownership in Participants before leaving this workspace.", { exact: true })).toBeVisible()
    await expect(ownerDialog.getByRole("button", { name: "Close", exact: true }).first()).toBeEnabled()
    await ownerDialog.getByRole("button", { name: "Close", exact: true }).first().click()

    await guest.getByRole("button", { name: "Sync", exact: true }).click()
    const guestDialog = guest.getByRole("dialog", { name: "Device sync" })
    await guestDialog.getByText("Advanced", { exact: true }).click()
    await guestDialog.getByRole("button", { name: "Leave mesh" }).click()
    await expect(guestDialog.getByText(/Your identity leaves this workspace on all its devices/)).toBeVisible()
    await guestDialog.getByRole("button", { name: "Leave mesh, keep copy" }).click()
    await expect(guest.getByLabel("Mesh empty")).toBeVisible({ timeout: 20_000 })
    await expect(guestDialog.getByText(/^Reconnect:/)).toHaveCount(0)
    await expect(guestDialog.getByRole("alert")).toHaveCount(0)
    await expect(guestDialog.getByRole("button", { name: "Leave mesh" })).toHaveCount(0)
    await guestDialog.getByRole("tab", { name: "Participants" }).click()
    const localMembers = guestDialog.getByRole("list", { name: "Mesh members" }).getByRole("button")
    await expect(localMembers).toHaveCount(1)
    await expect(localMembers).toContainText("You")
    await expect(guest.getByRole("button", { name: /Add lead to/ })).toHaveCount(0)
    await expect(guestDialog.getByRole("button", { name: "Leave mesh" })).toHaveCount(0)
    await guestDialog.getByRole("button", { name: "Close", exact: true }).first().click()
    await expect(guest.getByRole("button", { name: "Open Kept locally — Engineer" })).toBeVisible()

    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const hostDialog = page.getByRole("dialog", { name: "Device sync" })
    await hostDialog.getByRole("button", { name: "Add someone" }).click()
    await hostDialog.getByRole("button", { name: "Generate link" }).click()
    await guest.goto(await hostDialog.getByLabel("Pairing link").inputValue())
    await expect(guestDialog.getByRole("heading", { name: "Merge local copy?" })).toBeVisible()
    await expect(guestDialog.getByText("Existing local changes and incoming workspace history will be merged.")).toBeVisible()
    await guestDialog.getByRole("button", { name: "Merge and join" }).click()
    await hostDialog.getByLabel("Participant role").selectOption("editor")
    await hostDialog.getByRole("button", { name: "Approve access" }).click()
    await expect(guestDialog.getByText(/Connected to/)).toBeVisible({ timeout: 30_000 })
  } finally { await context.close() }
})

test("Given signed workspace authority, when transport state disappears, then owner and editor roles recover while forged authority stays read-only", async ({ browser, page }) => {
  test.setTimeout(120_000)
  const context = await isolatedContext(browser)
  const guest = await context.newPage()
  try {
    await Promise.all([page.goto("/"), guest.goto("/")])
    await pairWorkspace(page, guest)
    await addLead(guest, "Admitted before authority corruption")

    await Promise.all([discardTransportState(page), discardTransportState(guest)])
    await Promise.all([page.reload(), guest.reload()])

    await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
    await expect(guest.getByLabel("Workspace role: editor")).toBeVisible()
    await expect(page.getByLabel("Mesh empty")).toBeVisible()
    await expect(guest.getByLabel("Mesh empty")).toBeVisible()

    const workspaceId = await guest.evaluate(async () => (await import("/src/localDb.ts")).readLocal("tincanban.active_workspace_id"))
    if (!workspaceId) throw new Error("Active workspace missing")
    const unadmittedTitle = "Unadmitted raw title must stay hidden"
    await storeUnadmittedRawTitle(guest, workspaceId, unadmittedTitle)
    await guest.evaluate(async () => {
      const activeWorkspaceId = await (await import("/src/localDb.ts")).readLocal("tincanban.active_workspace_id")
      if (!activeWorkspaceId) throw new Error("Active workspace missing")
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("tincanban-peer-catalog-v1")
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const transaction = db.transaction("authority", "readwrite")
      const store = transaction.objectStore("authority")
      const authority = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const request = store.get(activeWorkspaceId)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      store.put({ ...authority, ownerPersonId: "forged-owner", ownerPublicKey: "forged-key" })
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
      db.close()
    })
    await guest.reload()
    await expect(guest.getByLabel("Workspace permissions: unavailable")).toBeVisible()
    await expect(guest.getByRole("alert").filter({ hasText: "Workspace authority could not be verified" })).toBeVisible()
    await expect(guest.getByRole("button", { name: "Open Admitted before authority corruption — Engineer" })).toBeVisible()
    await expect(guest.getByRole("button", { name: /Add lead to/ })).toHaveCount(0)
    await expect(guest.getByRole("button", { name: "Edit board" })).toHaveCount(0)
    await expect(guest.getByText(unadmittedTitle, { exact: true })).toHaveCount(0)
    const profileWriteError = await guest.evaluate(async () => {
      const { stateRuntime } = await import("/src/stateContext.ts")
      const { persistAuthorizedCommand } = await import("/src/statePersistence.ts")
      const { WorkspaceStorage } = await import("/src/storage.ts")
      try {
        await persistAuthorizedCommand(stateRuntime.activeDoc!, { kind: "setMemberAvatar", avatarData: null }, stateRuntime.currentProfile!, new WorkspaceStorage())
        return ""
      } catch (error) { return error instanceof Error ? error.message : String(error) }
    })
    expect(profileWriteError).toContain("Workspace authority could not be verified")
    const rawReviewCount = await guest.evaluate(async () => (await import("/src/state.ts")).useTincanban().causalReview.value.length)
    expect(rawReviewCount).toBe(0)
  } finally { await context.close() }
})

test("Given a current-owner revocation bound to quarantined history, when repair retries after reload, then owner access returns and revoked peer leaves roster", async ({ browser, page }) => {
  test.setTimeout(120_000)
  const context = await isolatedContext(browser)
  const guest = await context.newPage()
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey | IDBKeyRange) {
      const entry = value as { key?: string; credential?: { workspaceId?: string; catalog?: { revocationBoundaryHistory?: unknown[] } } }
      const workspaceKey = String(entry.key ?? key)
      const failKey = `fail-boundary-repair:${sessionStorage.getItem("boundary-repair-workspace") ?? ""}`
      if (workspaceKey === `workspace:${sessionStorage.getItem("boundary-repair-workspace") ?? ""}` &&
        sessionStorage.getItem(failKey) === "armed") {
        const attemptsKey = `${failKey}:attempts`
        sessionStorage.setItem(attemptsKey, String(Number(sessionStorage.getItem(attemptsKey) ?? 0) + 1))
        throw new DOMException("Injected revocation repair persistence failure", "QuotaExceededError")
      }
      return put.call(this, value, key)
    }
  })
  try {
    await Promise.all([page.goto("/"), guest.goto("/")])
    await pairWorkspace(page, guest)
    const workspaceId = await page.evaluate(async () => (await import("/src/localDb.ts")).readLocal("tincanban.active_workspace_id"))
    const keeperIdentity = await guest.evaluate(async () => {
      const profile = JSON.parse((await (await import("/src/localDb.ts")).readLocal("tincanban.local_profile.v1"))!)
      return { personId: profile.identity.personId as string, displayName: profile.identity.displayName as string }
    })
    const keeperPersonId = keeperIdentity.personId
    if (!workspaceId) throw new Error("Active workspace missing")
    const ownerEvidence = await page.evaluate(async id => {
      const { WorkspaceStorage } = await import("/src/storage.ts")
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { peerStore } = await import("/src/sync/peerStore.ts")
      const activeId = await (await import("/src/localDb.ts")).readLocal("tincanban.active_workspace_id")
      const stored = await new WorkspaceStorage().loadWorkspaceDoc(id)
      const profile = await bootstrapIdentity()
      const authority = await peerStore.getWorkspaceAuthority(id)
      return {
        activeId,
        loadedId: stored?.doc.id ?? "",
        documentOwnerMatchesProfile: stored?.doc.ownerPersonId === profile.identity.personId,
        authorityOwnerMatchesProfile: authority?.ownerPersonId === profile.identity.personId,
      }
    }, workspaceId)
    expect(ownerEvidence.activeId).toBe(workspaceId)
    expect(ownerEvidence.loadedId).toBe(workspaceId)
    expect(ownerEvidence.documentOwnerMatchesProfile).toBe(true)
    expect(ownerEvidence.authorityOwnerMatchesProfile).toBe(true)
    await guest.close()
    const rawHeads = await storeUnadmittedRawTitle(page, workspaceId, "Quarantined revocation boundary")
    const seeded = await page.evaluate(async ({ id, personId, heads }) => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { createWorkspaceRevocation } = await import("/src/sync/meshRecords.ts")
      const { peerStore } = await import("/src/sync/peerStore.ts")
      const profile = await bootstrapIdentity()
      const credential = await peerStore.getWorkspaceCredential(id)
      if (!credential) throw new Error("Workspace credential missing")
      const revocation = await createWorkspaceRevocation(profile, id, personId, 100, heads)
      await peerStore.putWorkspaceCredential({ ...credential, catalog: {
        ...(credential.catalog as Record<string, unknown> ?? {}),
        revocations: [...((credential.catalog as { revocations?: unknown[] } | undefined)?.revocations ?? []), revocation],
      } })
      sessionStorage.setItem("boundary-repair-workspace", id)
      sessionStorage.setItem(`fail-boundary-repair:${id}`, "armed")
      sessionStorage.removeItem(`fail-boundary-repair:${id}:attempts`)
      const storedAuthority = await peerStore.getWorkspaceAuthority(id)
      return {
        invalidCount: ((storedAuthority?.catalog as { revocations?: Array<{ payload: { personId: string } }> } | undefined)?.revocations ?? [])
          .filter(record => record.payload.personId === personId).length,
        currentHeads: (await import("/src/crdt.ts")).workspaceHeads(await (await import("/src/stateContext.ts")).stateRuntime.activeDoc!),
      }
    }, { id: workspaceId, personId: keeperPersonId, heads: rawHeads })
    expect(seeded.invalidCount).toBe(1)
    expect(rawHeads.some(head => seeded.currentHeads.includes(head))).toBe(false)

    await page.goto("/?syncTrace=1")
    await expect(page.getByRole("heading", { name: /TINCANBAN/ })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByLabel("Workspace role: owner").or(page.getByLabel("Workspace permissions: unavailable")))
      .toBeVisible({ timeout: 20_000 })
    const firstAttempt = await page.evaluate(async id => {
      await (await import("/src/crdt.ts")).initializeAutomerge()
      const { peerStore } = await import("/src/sync/peerStore.ts")
      const authority = await peerStore.getWorkspaceAuthority(id)
      const catalog = authority?.catalog as {
        revocationBoundaryHistory?: unknown[]
        revocations?: Array<{ payload?: { workspaceId?: string; workspaceHeads?: string[] } }>
      } | undefined
      const { WorkspaceStorage } = await import("/src/storage.ts")
      const activeId = await (await import("/src/localDb.ts")).readLocal("tincanban.active_workspace_id")
      const stored = await new WorkspaceStorage().loadWorkspaceDoc(id)
      const { workspaceHeads } = await import("/src/crdt.ts")
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const profile = await bootstrapIdentity()
      const documentHeads = workspaceHeads(stored!.doc)
      const invalidBoundaryCount = (catalog?.revocations ?? []).filter(record => record.payload?.workspaceId === id &&
        record.payload.workspaceHeads?.some(head => !documentHeads.includes(head))).length
      const { meshTraceSnapshot } = await import("/src/sync/meshTrace.ts")
      return { injected: sessionStorage.getItem(`fail-boundary-repair:${id}`), repairWriteAttempts: sessionStorage.getItem(`fail-boundary-repair:${id}:attempts`),
        historyCount: catalog?.revocationBoundaryHistory?.length ?? 0,
        revocationCount: ((authority?.catalog as { revocations?: unknown[] } | undefined)?.revocations ?? []).length,
        activeWorkspaceId: activeId ?? "", loadedWorkspaceId: stored?.doc.id ?? "",
        docOwnerMatchesProfile: stored?.doc.ownerPersonId === profile.identity.personId,
        authorityOwnerMatchesProfile: authority?.ownerPersonId === profile.identity.personId,
        invalidBoundaryCount,
        renderedRole: document.querySelector('[aria-label^="Workspace role:"]')?.getAttribute("aria-label") ?? "",
        accessEvents: meshTraceSnapshot().filter(event => event.event === "workspace.access.resolution").map(event => event.payload) }
    }, workspaceId)
    if (firstAttempt.injected !== "armed" || firstAttempt.activeWorkspaceId !== workspaceId || firstAttempt.loadedWorkspaceId !== workspaceId ||
      !firstAttempt.docOwnerMatchesProfile || !firstAttempt.authorityOwnerMatchesProfile || firstAttempt.invalidBoundaryCount !== 1 ||
      Number(firstAttempt.repairWriteAttempts) < 1 || firstAttempt.historyCount !== 0)
      throw new Error(`Boundary repair startup state mismatch: ${JSON.stringify(firstAttempt)}`)
    await expect(page.getByLabel("Workspace permissions: unavailable")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole("button", { name: "Edit board", exact: true })).toHaveCount(0)

    await page.evaluate(async id => sessionStorage.setItem(`fail-boundary-repair:${id}`, "released"), workspaceId)
    await page.reload()
    await expect(page.getByLabel("Workspace role: owner")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("button", { name: "Edit board", exact: true })).toBeVisible()
    const repaired = await page.evaluate(async id => {
      const { peerStore } = await import("/src/sync/peerStore.ts")
      const { WorkspaceStorage } = await import("/src/storage.ts")
      const { workspaceHeads } = await import("/src/crdt.ts")
      const authority = await peerStore.getWorkspaceAuthority(id)
      const stored = await new WorkspaceStorage().loadWorkspaceDoc(id)
      const revocations = (authority?.catalog as { revocations?: Array<{ payload: { personId: string; epoch: number; workspaceHeads: string[] } }> } | undefined)?.revocations ?? []
      const history = (authority?.catalog as { revocationBoundaryHistory?: Array<{ personId: string; removed: unknown[]; replacements: unknown[] }> } | undefined)?.revocationBoundaryHistory ?? []
      return { heads: workspaceHeads(stored!.doc), revocations, history }
    }, workspaceId)
    const targetRevocations = repaired.revocations.filter(record => record.payload.personId === keeperPersonId)
    expect(targetRevocations).toHaveLength(1)
    expect(targetRevocations[0]!.payload.workspaceHeads.every(head => repaired.heads.includes(head))).toBe(true)
    expect(repaired.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ personId: keeperPersonId, removed: expect.any(Array), replacements: expect.any(Array) }),
    ]))
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const members = page.getByRole("list", { name: "Mesh members" })
    await expect(members).toContainText("You", { timeout: 15_000 })
    await expect(members).not.toContainText(keeperIdentity.displayName)
  } finally { await context.close() }
})

test("Given a paired editor, when the invitation tab reloads repeatedly, then trust and editing survive and sync resumes without approval", async ({ browser, page }) => {
  test.setTimeout(120_000)
  const context = await isolatedContext(browser)
  const guest = await context.newPage()
  try {
    await Promise.all([page.goto("/"), guest.goto("/")])
    const invite = await pairWorkspace(page, guest)
    const identity = await guest.evaluate(async () => JSON.parse((await (await import("/src/localDb.ts")).readLocal("tincanban.local_profile.v1"))!).identity.personId)
    for (let i = 0; i < 2; i++) {
      await guest.reload()
      await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
      await expect(guest.getByLabel("Workspace role: editor")).toBeVisible()
      await expect(guest.getByRole("dialog", { name: "Device sync" })).toHaveCount(0)
      expect(await guest.evaluate(async () => JSON.parse((await (await import("/src/localDb.ts")).readLocal("tincanban.local_profile.v1"))!).identity.personId)).toBe(identity)
      await addLead(guest, `Reload ${i}`)
      await expect(page.getByRole("button", { name: `Open Reload ${i} — Engineer` })).toBeVisible({ timeout: 20_000 })
      await addLead(page, `Host after reload ${i}`)
      await expect(guest.getByRole("button", { name: `Open Host after reload ${i} — Engineer` })).toBeVisible({ timeout: 20_000 })
    }
    // An older client could leave the consumed invitation in its address bar.
    const stale = new URL(invite)
    const params = new URLSearchParams(stale.hash.slice(1))
    params.set("createdAt", "2019-12-31T00:00:00.000Z")
    params.set("expiresAt", "2020-01-01T00:00:00.000Z")
    stale.hash = params.toString()
    await guest.goto(stale.href)
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(guest.getByRole("dialog", { name: "Device sync" })).toHaveCount(0)
    await expect(guest.getByLabel("Workspace role: editor")).toBeVisible()
    expect(new URL(guest.url()).pathname).toBe("/")
  } finally { await context.close() }
})

test("Given two connected clients, when exactly one page reloads after a pending network state, then both sides restore live presence", async ({ browser }) => {
  test.setTimeout(120_000)
  const hostContext = await isolatedContext(browser)
  const guestContext = await isolatedContext(browser)
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  try {
    await Promise.all([host.goto("/"), guest.goto("/")])
    await pairWorkspace(host, guest)
    await expect(host.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(host.getByLabel("Workspace role: owner")).toBeVisible()
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })

    await guest.evaluate(() => window.dispatchEvent(new Event("offline")))
    await expect(guest.getByLabel("Mesh offline")).toBeVisible()
    await guest.getByRole("button", { name: "Sync", exact: true }).click()
    const offlineDialog = guest.getByRole("dialog", { name: "Device sync" })
    await expect(offlineDialog.getByText("Devices offline · Waiting for internet. Changes stay saved on this device.")).toBeVisible()
    await expect(offlineDialog.getByText(/Retrying in \d+s/)).toHaveCount(0)
    await guest.reload()

    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 35_000 })
    await expect(host.getByLabel("Mesh connected")).toBeVisible({ timeout: 35_000 })
    for (const client of [host, guest]) {
      await client.getByRole("button", { name: "Sync", exact: true }).click()
      const dialog = client.getByRole("dialog", { name: "Device sync" })
      await expect(dialog.getByText("Devices connected · Channel open on this device.")).toBeVisible()
      await expect(dialog.locator(".mesh-member-presence.is-online")).toHaveCount(2)
      await dialog.getByRole("button", { name: "Close", exact: true }).first().click()
    }

    await addLead(guest, "After one-sided reload")
    await expect(host.getByRole("button", { name: "Open After one-sided reload — Engineer" })).toBeVisible({ timeout: 20_000 })
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()])
  }
})

test("Given a paired editor, when its actual Iroh node closes unexpectedly, then a fresh node reconnects and syncs without reload or pairing", async ({ browser }) => {
  test.setTimeout(120_000)
  const hostContext = await isolatedContext(browser)
  const guestContext = await isolatedContext(browser)
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  try {
    await Promise.all([captureRealIrohNodes(host), captureRealIrohNodes(guest)])
    await Promise.all([host.goto("/"), guest.goto("/")])
    await pairWorkspace(host, guest)
    await guest.evaluate(() => { (window as Window & { __TINCANBAN_RECOVERY_SENTINEL__?: string }).__TINCANBAN_RECOVERY_SENTINEL__ = "still-running" })
    const ownershipBeforeClose = await realIrohNodeOwnership(guest)
    expect(ownershipBeforeClose.created).toBeGreaterThan(0)
    const before = await guest.evaluate(async () => {
      const { clearMeshTrace, meshTraceSnapshot } = await import("/src/sync/meshTrace.ts")
      const endpoint = meshTraceSnapshot().findLast(event => event.event === "node.started")?.endpoint
      clearMeshTrace()
      return { endpoint, href: window.location.href }
    })

    await closeLatestRealIrohNode(guest, before.endpoint)

    await expect.poll(async () => (await realIrohNodeOwnership(guest)).created, { timeout: 45_000 })
      .toBe(ownershipBeforeClose.created + 1)
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 45_000 })
    await expect(guest.getByLabel("Workspace role: editor")).toBeVisible()
    expect(await guest.evaluate(() => window.location.href)).toBe(before.href)
    expect(await guest.evaluate(() => (window as Window & { __TINCANBAN_RECOVERY_SENTINEL__?: string }).__TINCANBAN_RECOVERY_SENTINEL__)).toBe("still-running")

    await addLead(host, "After actual node recovery")
    await expect(guest.getByRole("button", { name: "Open After actual node recovery — Engineer" })).toBeVisible({ timeout: 30_000 })
    await addLead(guest, "Recovered node sends")
    await expect(host.getByRole("button", { name: "Open Recovered node sends — Engineer" })).toBeVisible({ timeout: 30_000 })

    const after = await guest.evaluate(async () => {
      const { meshTraceSnapshot } = await import("/src/sync/meshTrace.ts")
      return meshTraceSnapshot()
    })
    expect(after.some(event => event.event === "node.shutdown"), JSON.stringify(after)).toBe(true)
    const restarted = after.filter(event => event.event === "node.started")
    expect(restarted).toHaveLength(1)
    expect(after.filter(event => event.event === "run.start")).toHaveLength(1)
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()])
  }
})

test("Given a paired editor, when live receive persistence fails, then no saved state is acknowledged and reconnect replays it after storage recovers", async ({ browser }, testInfo) => {
  test.setTimeout(120_000)
  const hostContext = await isolatedContext(browser)
  const guestContext = await isolatedContext(browser)
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  try {
    await Promise.all([captureRealIrohNodes(guest), captureSavedAcknowledgements(guest)])
    await Promise.all([host.goto("/"), guest.goto("/")])
    await pairWorkspace(host, guest)
    await guest.waitForTimeout(1_000)
    await guest.evaluate(() => {
      window.__TINCANBAN_E2E_DOCUMENT_RECEIVES__ = []
    })
    const workspaceId = await guest.evaluate(async () => (await (await import("/src/localDb.ts")).readLocal("tincanban.active_workspace_id"))!)
    const journalBefore = await journalChangeIds(guest, workspaceId)
    await Promise.all([host, guest].map(target => target.evaluate(async () => {
      const { clearMeshTrace } = await import("/src/sync/meshTrace.ts")
      clearMeshTrace()
    })))

    await guest.evaluate(() => { window.__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })
    await addLead(host, "Replay after receive failure")
    // The same receive can arrive on an incoming stream or as a document
    // response. Observe the target persistence attempt, not either path's log.
    await expect.poll(async () => (await targetDocumentReceives(guest, "Replay after receive failure — Engineer"))
      .some(attempt => attempt.failed), { timeout: 25_000 }).toBe(true)
    await expect(guest.getByRole("button", { name: "Open Replay after receive failure — Engineer" })).toHaveCount(0)
    expect(await journalChangeIds(guest, workspaceId)).toEqual(journalBefore)
    expect(await persistedLeadExists(guest, workspaceId, "Replay after receive failure — Engineer")).toBe(false)
    const failedAttempts = await targetDocumentReceives(guest, "Replay after receive failure — Engineer")
    expect(failedAttempts.length).toBeGreaterThan(0)
    expect(failedAttempts.every(attempt => attempt.failed && !attempt.persisted && !attempt.responseSent)).toBe(true)

    await closeLatestRealIrohNode(guest)
    await guest.evaluate(() => { window.__TINCANBAN_INJECT_STORAGE_FAILURE__ = false })
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 40_000 })
    await expect(host.getByLabel("Mesh connected")).toBeVisible({ timeout: 40_000 })
    await expect(guest.getByRole("button", { name: "Open Replay after receive failure — Engineer" })).toBeVisible({ timeout: 40_000 })
    expect(await persistedLeadExists(guest, workspaceId, "Replay after receive failure — Engineer")).toBe(true)
    // Storage/UI commit precedes the asynchronous response send. Wait for
    // that send to complete rather than treating visible data as an ACK.
    await expect.poll(async () => (await targetDocumentReceives(guest, "Replay after receive failure — Engineer"))
      .some(attempt => attempt.persisted && attempt.responseSent), { timeout: 20_000 }).toBe(true)
  } finally {
    await testInfo.attach("storage-receives.json", { body: JSON.stringify({
      attempts: await documentReceiveAttempts(guest).catch(() => []),
      trace: await guest.evaluate(async () => (await import("/src/sync/meshTrace.ts")).meshTraceSnapshot()).catch(() => []),
    }), contentType: "application/json" })
    await Promise.all([hostContext.close(), guestContext.close()])
  }
})

test("Given two tabs for one editor device, when their real Iroh nodes disconnect repeatedly, then roles, edits, and node ownership recover without accumulation", async ({ browser }, testInfo) => {
  test.setTimeout(180_000)
  const hostContext = await isolatedContext(browser)
  const editorContext = await isolatedContext(browser)
  const host = await hostContext.newPage()
  const editor = await editorContext.newPage()
  let secondEditor: Page | undefined
  try {
    await Promise.all([captureRealIrohNodes(host), captureRealIrohNodes(editor), captureMeshResources(host), captureMeshResources(editor)])
    await Promise.all([host.goto("/"), editor.goto("/")])
    await pairWorkspace(host, editor)
    secondEditor = await editorContext.newPage()
    await Promise.all([captureRealIrohNodes(secondEditor), captureMeshResources(secondEditor)])
    await secondEditor.goto("/")
    await expect(secondEditor.getByLabel("Mesh connected")).toBeVisible({ timeout: 35_000 })
    await expect(secondEditor.getByLabel("Workspace role: editor")).toBeVisible()
    const people = await Promise.all([host, editor, secondEditor].map(page => page.evaluate(async () =>
      JSON.parse((await (await import("/src/localDb.ts")).readLocal("tincanban.local_profile.v1"))!).identity.personId)))
    expect(people[1]).toBe(people[2])

    for (const [cycle, target] of [editor, secondEditor, editor, secondEditor].entries()) {
      const before = await realIrohNodeOwnership(target)
      await target.evaluate(async () => {
        const { clearMeshTrace } = await import("/src/sync/meshTrace.ts")
        clearMeshTrace()
      })
      await closeLatestRealIrohNode(target)
      await expect.poll(async () => (await realIrohNodeOwnership(target)).created, { timeout: 45_000 }).toBe(before.created + 1)
      await expect(target.getByLabel("Mesh connected")).toBeVisible({ timeout: 45_000 })
      await expect(target.getByLabel("Workspace role: editor")).toBeVisible()
      const after = await realIrohNodeOwnership(target)
      expect(after.active).toBe(before.active)
      const startsAfter = await target.evaluate(async () => {
        const { meshTraceSnapshot } = await import("/src/sync/meshTrace.ts")
        return meshTraceSnapshot().filter(event => event.event === "run.start").length
      })
      expect(startsAfter).toBe(1)
      const title = `Two-tab recovery ${cycle}`
      await addLead(target, title)
      for (const page of [host, editor, secondEditor]) {
        await expect(page.getByRole("button", { name: `Open ${title} — Engineer` })).toBeVisible({ timeout: 30_000 })
      }
      await expect(host.getByLabel("Workspace role: owner")).toBeVisible()
      await Promise.all([editor, secondEditor].map(page => expect(page.getByLabel("Workspace role: editor")).toBeVisible()))
      expect(await Promise.all([host, editor, secondEditor].map(page => page.evaluate(async () =>
        JSON.parse((await (await import("/src/localDb.ts")).readLocal("tincanban.local_profile.v1"))!).identity.personId)))).toEqual(people)
      const sessions = await target.evaluate(async () => {
        const { meshTraceSnapshot } = await import("/src/sync/meshTrace.ts")
        const trace = meshTraceSnapshot()
        const active = new Set<string>()
        for (const event of trace) {
          if (event.event === "session.started") active.add(String(event.connectionId))
          if (event.event === "session.closed") active.delete(String(event.connectionId))
        }
        return active.size
      })
      expect(sessions).toBeGreaterThan(0)
      expect(sessions).toBeLessThanOrEqual(2)
      const resources = await meshResourceCounts(target)
      expect(resources.heartbeats).toBeGreaterThan(0)
      expect(resources.heartbeats).toBeLessThanOrEqual(2)
      expect(resources.retryWaits).toBeLessThanOrEqual(1)
    }
    await host.getByRole("button", { name: "Sync", exact: true }).click()
    const dialog = host.getByRole("dialog", { name: "Device sync" })
    await dialog.getByRole("list", { name: "Mesh members" }).getByRole("button").filter({ hasText: "editor" }).click()
    await expect(dialog.getByRole("list", { name: /Devices for/ })).toContainText("2 known browser sessions")
    await dialog.getByText("Advanced", { exact: true }).click()
    await dialog.getByRole("button", { name: "Stop live sync" }).click()
    for (const page of [editor, secondEditor]) {
      await page.getByRole("button", { name: "Sync", exact: true }).click()
      await page.getByRole("dialog", { name: "Device sync" }).getByText("Advanced", { exact: true }).click()
      await page.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Stop live sync" }).click()
    }
    await expect.poll(async () => (await Promise.all([host, editor, secondEditor].map(meshResourceCounts))).every(counts => counts.heartbeats === 0 && counts.retryWaits === 0), { timeout: 30_000 }).toBe(true)
    await expect.poll(async () => (await Promise.all([host, editor, secondEditor].map(realIrohNodeOwnership))).every(ownership => ownership.active === 0), { timeout: 30_000 }).toBe(true)
  } finally {
    const traces = await Promise.all([host, editor, secondEditor].filter((page): page is Page => Boolean(page)).map(async page => ({
      url: page.url(),
      dial: await page.evaluate(() => (window as Window & { __meshDialInput?: unknown }).__meshDialInput).catch(() => undefined),
      peers: await page.evaluate(async () => (await (await import("/src/sync/peerStore.ts")).peerStore.listPeerInstances()).map(peer => ({ workspaceId: peer.workspaceId, deviceId: peer.deviceId, instanceId: peer.instanceId, endpoint: peer.endpoint, revokedAt: peer.revokedAt }))).catch(() => []),
      trace: await page.evaluate(async () => (await import("/src/sync/meshTrace.ts")).meshTraceSnapshot()).catch(() => []),
    })))
    await testInfo.attach("mesh-traces.json", { body: JSON.stringify(traces), contentType: "application/json" })
    await Promise.all([hostContext.close(), editorContext.close()])
  }
})

test("Given a mobile peer with 32 leads and 9 applied cards, when desktop moves cards while it is offline, then both persist 23 leads and 12 applied without reloading to sync", async ({ browser }, info) => {
  test.setTimeout(120_000)
  const hostContext = await isolatedContext(browser)
  const guestContext = await isolatedContext(browser)
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  try {
    await guest.setViewportSize({ width: 390, height: 844 })
    await Promise.all([host.goto("/"), guest.goto("/")])
    await ensureJobSearchWorkspace(host)
    const fixture = await host.evaluate(async () => {
      const app = (await import("/src/state.ts")).useTincanban()
      await app.whenReady()
      const doc = app.getActiveDoc()!
      const columns = Object.values(doc.entities).filter(entity => entity.kind === "column")
      const lead = columns.find(column => column.title === "Lead")!
      const applied = columns.find(column => column.title === "Applied")!
      for (let index = 0; index < 32; index++) {
        await app.executeCommandAsync({ kind: "createItem", id: `sync-lead-${index}`, parentId: lead.id, title: `Sync lead ${index} — Engineer` })
      }
      for (let index = 0; index < 9; index++) {
        await app.executeCommandAsync({ kind: "createItem", id: `sync-applied-${index}`, parentId: applied.id, title: `Applied ${index} — Engineer` })
      }
      return { workspaceId: doc.id, appliedId: applied.id }
    })
    await pairWorkspace(host, guest)
    const count = (page: Page, column: string) => page.getByRole("region", { name: column, exact: true }).locator(".column-header .count")
    await expect(count(guest, "Lead")).toHaveText("32", { timeout: 30_000 })
    await expect(count(guest, "Applied")).toHaveText("9")
    await guestContext.setOffline(true)
    await expect(guest.getByLabel("Mesh offline")).toBeVisible({ timeout: 20_000 })
    await host.evaluate(async ({ appliedId }) => {
      const app = (await import("/src/state.ts")).useTincanban()
      for (let index = 0; index < 9; index++) {
        await app.executeCommandAsync(index < 3
          ? { kind: "moveEntity", entityId: `sync-lead-${index}`, parentId: appliedId }
          : { kind: "setEntityArchived", entityId: `sync-lead-${index}`, archived: true })
      }
    }, fixture)
    await expect(count(host, "Lead")).toHaveText("23")
    await expect(count(host, "Applied")).toHaveText("12")
    await expect(count(guest, "Lead")).toHaveText("32")
    await expect(count(guest, "Applied")).toHaveText("9")
    await guestContext.setOffline(false)
    await expect(count(guest, "Lead")).toHaveText("23", { timeout: 35_000 })
    await expect(count(guest, "Applied")).toHaveText("12")
    const placements = (page: Page) => page.evaluate(async workspaceId => {
      const storage = new (await import("/src/storage.ts")).WorkspaceStorage()
      const { isItemArchived } = await import("/src/domain/archive.ts")
      const { isItem } = await import("/src/domain/model.ts")
      const snapshot = await storage.loadWorkspaceDoc(workspaceId)
      return Object.values(snapshot?.doc.entities ?? {}).filter(isItem)
        .map(entity => ({ id: entity.id, parentId: entity.placement.parentId, archived: isItemArchived(entity) })).sort((a, b) => a.id.localeCompare(b.id))
    }, fixture.workspaceId)
    const expected = await placements(host)
    expect(expected).toHaveLength(41)
    await expect.poll(() => placements(guest), { timeout: 15_000 }).toEqual(expected)
    await guest.screenshot({ path: info.outputPath("mobile-caught-up-cards.png") })
    await guest.reload()
    await expect(count(guest, "Lead")).toHaveText("23", { timeout: 30_000 })
    await expect(count(guest, "Applied")).toHaveText("12")
    expect(await placements(guest)).toEqual(expected)
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()])
  }
})

test("Given a paired editor goes offline, when both sides edit and it comes online, then persisted changes converge without reloading", async ({ browser }) => {
  test.setTimeout(120_000)
  const hostContext = await isolatedContext(browser)
  const guestContext = await isolatedContext(browser)
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  try {
    await captureMeshResources(guest)
    await Promise.all([host.goto("/"), guest.goto("/")])
    await pairWorkspace(host, guest)
    await expect(host.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => (await meshResourceCounts(guest)).heartbeats, { timeout: 20_000 }).toBeGreaterThan(0)

    const before = await Promise.all([host, guest].map((target, index) => target.evaluate(async sentinel => {
      const current = window as Window & { __TINCANBAN_RECONNECT_SENTINEL__?: string }
      current.__TINCANBAN_RECONNECT_SENTINEL__ = sentinel
      const { readLocal } = await import("/src/localDb.ts")
      const profile = JSON.parse((await readLocal("tincanban.local_profile.v1"))!) as { identity: { personId: string } }
      const { useTincanban } = await import("/src/state.ts")
      const workspaceId = useTincanban().getActiveDoc()!.id
      const { meshTraceSnapshot, clearMeshTrace } = await import("/src/sync/meshTrace.ts")
      const session = meshTraceSnapshot().findLast(event => event.event === "session.started")
      clearMeshTrace()
      return { sentinel, personId: profile.identity.personId, workspaceId, connectionId: session?.connectionId }
    }, `reconnect-${index}`)))
    expect(before[0].workspaceId).toBe(before[1].workspaceId)
    expect(before[1].connectionId).toEqual(expect.any(String))
    const guestJournalBefore = await journalChangeIds(guest, before[1].workspaceId)

    // Chromium's network emulation emits the production offline event. tincanban's
    // handler closes the real Iroh session even when WebRTC itself stays viable.
    await guestContext.setOffline(true)
    await expect(guest.getByLabel("Mesh offline")).toBeVisible({ timeout: 20_000 })
    // Transport teardown may finish before the baseline trace is cleared.
    // Require stopped live resources rather than a particular close event.
    await expect.poll(async () => (await meshResourceCounts(guest)).heartbeats, { timeout: 20_000 }).toBe(0)

    await addLead(guest, "Guest queued offline")
    await addLead(host, "Host queued remotely")
    const guestJournalOffline = await journalChangeIds(guest, before[1].workspaceId)
    expect(guestJournalOffline.length).toBeGreaterThan(guestJournalBefore.length)

    await guestContext.setOffline(false)
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 35_000 })
    await expect(host.getByLabel("Mesh connected")).toBeVisible({ timeout: 35_000 })
    await expect(host.getByRole("button", { name: "Open Guest queued offline — Engineer" })).toBeVisible({ timeout: 30_000 })
    await expect(guest.getByRole("button", { name: "Open Host queued remotely — Engineer" })).toBeVisible({ timeout: 30_000 })

    const after = await Promise.all([host, guest].map(target => target.evaluate(async () => {
      const current = window as Window & { __TINCANBAN_RECONNECT_SENTINEL__?: string }
      const { readLocal } = await import("/src/localDb.ts")
      const profile = JSON.parse((await readLocal("tincanban.local_profile.v1"))!) as { identity: { personId: string } }
      const { meshTraceSnapshot } = await import("/src/sync/meshTrace.ts")
      return { sentinel: current.__TINCANBAN_RECONNECT_SENTINEL__, personId: profile.identity.personId,
        trace: meshTraceSnapshot() }
    })))
    expect(after.map(value => value.sentinel)).toEqual(before.map(value => value.sentinel))
    expect(after.map(value => value.personId)).toEqual(before.map(value => value.personId))
    await expect(host.getByLabel("Workspace role: owner")).toBeVisible()
    await expect(guest.getByLabel("Workspace role: editor")).toBeVisible()

    const reconnect = after[1].trace.find(event => event.event === "session.started")
    expect(reconnect, JSON.stringify(after[1].trace)).toBeDefined()
    expect(reconnect?.connectionId).not.toBe(before[1].connectionId)
    expect(after[1].trace.some(event => event.event === "node.shutdown"), JSON.stringify(after[1].trace)).toBe(false)
    expect(after[1].trace.some(event => event.event === "run.start"), JSON.stringify(after[1].trace)).toBe(false)

    // tincanban currently replays persisted Automerge state; it does not drain a
    // separate outbox. The committed offline change therefore remains journaled.
    const guestJournalAfter = await journalChangeIds(guest, before[1].workspaceId)
    expect(guestJournalAfter).toEqual(guestJournalOffline)
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()])
  }
})

test("Given a connected peer misses a local change notification, then periodic anti-entropy converges without adding another device", async ({ browser }) => {
  test.setTimeout(90_000)
  const hostContext = await isolatedContext(browser)
  const guestContext = await isolatedContext(browser)
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  try {
    await Promise.all([host.goto("/"), guest.goto("/")])
    await pairWorkspace(host, guest)
    await expect(host.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await guest.evaluate(async () => {
      const { stateRuntime } = await import("/src/stateContext.ts")
      stateRuntime.localChangeListeners.clear()
    })

    await addLead(guest, "Recovered without third device")

    await expect(host.getByRole("button", { name: "Open Recovered without third device — Engineer" }))
      .toBeVisible({ timeout: 20_000 })
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()])
  }
})

test("Given an existing editor, when the owner enrolls another device, then the owner device verifies that editor after reload", async ({ browser, page }) => {
  test.setTimeout(120_000)
  const editorContext = await isolatedContext(browser)
  const phoneContext = await isolatedContext(browser)
  const editor = await editorContext.newPage()
  const phone = await phoneContext.newPage()
  try {
    await Promise.all([page.goto("/"), editor.goto("/"), phone.goto("/")])
    await addLead(page, "Before owner enrollment")
    await pairWorkspace(page, editor)

    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const hostDialog = page.getByRole("dialog", { name: "Device sync" })
    await hostDialog.getByRole("button", { name: "Add someone" }).click()
    await hostDialog.getByRole("button", { name: "Add my device", exact: true }).click()
    await phone.goto(await hostDialog.getByLabel("Pairing link").inputValue())
    const phoneDialog = phone.getByRole("dialog", { name: "Device sync" })
    await phoneDialog.getByRole("button", { name: "Add this device" }).waitFor({ state: "visible" })
    if (await phoneDialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).count()) await phoneDialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).check()
    await phoneDialog.getByRole("button", { name: "Add this device" }).click()
    await hostDialog.getByRole("button", { name: "Approve device" }).click()
    await expect(phoneDialog.getByText("Device enrolled", { exact: true })).toBeVisible({ timeout: 30_000 })
    await phoneDialog.getByRole("button", { name: "Close", exact: true }).first().click()
    await hostDialog.getByRole("button", { name: "Close", exact: true }).first().click()

    await phone.reload()
    await expect(phone.getByLabel("Workspace role: owner")).toBeVisible()
    await expect(phone.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(phone.getByText(/Invalid workspace grant signature/)).toHaveCount(0)
    await phone.getByRole("button", { name: "Settings" }).click()
    const phoneSettings = phone.getByRole("dialog", { name: "Settings" })
    await phoneSettings.getByRole("tab", { name: "Identity" }).click()
    await phoneSettings.getByRole("textbox", { name: "Name", exact: true }).fill("Enrolled owner")
    await phoneSettings.getByRole("button", { name: "Save name", exact: true }).click()
    await expect(phoneSettings.getByRole("button", { name: "Save name", exact: true })).toBeEnabled()
    await expect(phoneSettings.getByRole("alert")).toHaveCount(0)
    await phoneSettings.getByRole("button", { name: "Dismiss", exact: true }).click()
    await phone.reload()
    await phone.getByRole("button", { name: "Settings" }).click()
    await phoneSettings.getByRole("tab", { name: "Identity" }).click()
    await expect(phoneSettings.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Enrolled owner")
    await phoneSettings.getByRole("button", { name: "Dismiss", exact: true }).click()
    await addLead(editor, "Editor after owner enrollment")
    await expect(phone.getByRole("button", { name: "Open Editor after owner enrollment — Engineer" })).toBeVisible({ timeout: 20_000 })
  } finally {
    await Promise.all([editorContext.close(), phoneContext.close()])
  }
})

test("Given trusted devices and multiple tabs, when tabs close and reopen, then each tab keeps an independent channel under one device", async ({ browser, page }) => {
  test.setTimeout(120_000)
  await page.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  const guestContext = await isolatedContext(browser)
  let guest = await guestContext.newPage()
  try {
    await page.goto("/")
    await addLead(page, "Before restart")
    await guest.goto("/")
    await pairWorkspace(page, guest)

    const hostContext = page.context()
    await guest.close()
    await page.close()

    const host = await hostContext.newPage()
    await host.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
    guest = await guestContext.newPage()
    await Promise.all([host.goto("/"), guest.goto("/")])
    await expect(host.getByLabel("Mesh connected")).toBeVisible({ timeout: 35_000 })
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 35_000 })

    await addLead(guest, "After restart")
    await expect(host.getByRole("button", { name: "Open After restart — Engineer" })).toBeVisible({ timeout: 20_000 })

    const secondTab = await hostContext.newPage()
    await secondTab.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
    await secondTab.goto("/")
    await expect(secondTab.getByLabel("Mesh connected")).toBeVisible({ timeout: 35_000 })
    await addLead(secondTab, "From second tab")
    await expect(guest.getByRole("button", { name: "Open From second tab — Engineer" })).toBeVisible({ timeout: 20_000 })

    await guest.getByRole("button", { name: "Sync", exact: true }).click()
    const guestDialog = guest.getByRole("dialog", { name: "Device sync" })
    await guestDialog.getByRole("list", { name: "Mesh members" }).getByRole("button").filter({ hasText: "OWNER" }).click()
    await expect(guestDialog.getByText(/2 known browser sessions/)).toBeVisible({ timeout: 20_000 })
    await guestDialog.getByRole("button", { name: "Close", exact: true }).first().click()

    await host.close()
    await addLead(guest, "After first tab closed")
    await expect(secondTab.getByRole("button", { name: "Open After first tab closed — Engineer" })).toBeVisible({ timeout: 30_000 })
    await secondTab.close()
  } finally {
    await guestContext.close()
  }
})

test("Given a connected peer closes its tab, when it returns, then presence turns offline and queued changes sync", async ({ browser, page }) => {
  test.setTimeout(90_000)
  await page.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  const guestContext = await isolatedContext(browser)
  let guest = await guestContext.newPage()
  try {
    await Promise.all([page.goto("/"), guest.goto("/")])
    await pairWorkspace(page, guest)
    await expect(page.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expectFaviconColor(page, "#69db7c")

    await guest.close()
    await expect(page.getByLabel("Mesh reconnecting")).toBeVisible({ timeout: 20_000 })
    const firstFrame = await faviconColor(page)
    expect(["#ffd43b", "#f3f0e8"]).toContain(firstFrame)
    await expect.poll(() => faviconColor(page), { timeout: 2_000 }).not.toBe(firstFrame)
    expect(["#ffd43b", "#f3f0e8"]).toContain(await faviconColor(page))
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const syncDialog = page.getByRole("dialog", { name: "Device sync" })
    await expect(syncDialog.getByText("Devices reconnecting · Checking live channel. Changes stay saved on this device.")).toBeVisible()
    await expect(syncDialog.getByRole("list", { name: "Mesh members" }).locator(".mesh-member-presence.is-reconnecting")).toHaveCount(1)
    await expect(page.getByLabel("Mesh offline")).toBeVisible({ timeout: 20_000 })
    await expectFaviconColor(page, "#ff5a36")
    await page.emulateMedia({ reducedMotion: "reduce" })
    await expect(syncDialog.getByText(/^Devices offline · No live channel\. (?:Retrying in \d+s\.|Reconnecting automatically\.)$/)).toBeVisible()
    await expect(syncDialog.getByText(/^Reconnect:/)).toHaveCount(0)
    await expect(syncDialog.locator(".mesh-member-presence.is-online")).toHaveCount(1)
    await expect(syncDialog.locator(".mesh-member-presence.is-offline")).toHaveCount(1)
    const members = syncDialog.getByRole("list", { name: "Mesh members" })
    const selfMember = members.getByRole("button").filter({ hasText: "You" })
    const remoteMember = members.getByRole("button").filter({ hasNotText: "You" })
    await expect(selfMember).toContainText("1 known device · You")
    await expect(remoteMember).toContainText("1 known device")
    await remoteMember.click()
    await expect(syncDialog.getByRole("list", { name: /Devices for/ })).toContainText("No connection")
    await selfMember.click()
    const selectedMemberFits = await selfMember.evaluate(member => {
      const list = member.parentElement!.getBoundingClientRect()
      const card = member.getBoundingClientRect()
      return card.left >= list.left && card.right + 3 <= list.right && card.bottom + 3 <= list.bottom
    })
    expect(selectedMemberFits).toBe(true)
    await syncDialog.getByRole("button", { name: "Close", exact: true }).last().click()
    await addLead(page, "Queued while closed")

    guest = await guestContext.newPage()
    await guest.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
    await guest.goto("/")
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expectFaviconColor(page, "#69db7c")
    await expect(guest.getByRole("button", { name: "Open Queued while closed — Engineer" })).toBeVisible({ timeout: 20_000 })
    await guest.close()
    await expect(page.getByLabel("Mesh reconnecting")).toBeVisible({ timeout: 20_000 })
    await expectFaviconColor(page, "#ffd43b")
    expect(await faviconChanges(page)).toBe(0)
    await expectFaviconColor(page, "#ffd43b")
  } finally {
    await guestContext.close()
  }
})

test("Given owner introduced two editors, when owner goes offline, then editors discover each other and keep syncing", async ({ browser, page }) => {
  test.setTimeout(150_000)
  await page.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  const bContext = await isolatedContext(browser)
  const cContext = await isolatedContext(browser)
  const b = await bContext.newPage()
  const c = await cContext.newPage()
  try {
    await Promise.all([page.goto("/"), b.goto("/"), c.goto("/")])
    await pairWorkspace(page, b)
    await pairWorkspace(page, c)
    await page.close()

    await expect(b.getByLabel("Mesh connected")).toBeVisible({ timeout: 40_000 })
    await expect(c.getByLabel("Mesh connected")).toBeVisible({ timeout: 40_000 })
    await addLead(b, "B without owner")
    await expect(c.getByRole("button", { name: "Open B without owner — Engineer" })).toBeVisible({ timeout: 25_000 })
  } finally {
    await Promise.all([bContext.close(), cContext.close()])
  }
})

test("Given an editor has synced changes, when owner removes access, then writes stop and a new peer retains accepted history", async ({ browser, page }) => {
  test.setTimeout(100_000)
  await page.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  const guestContext = await isolatedContext(browser)
  const freshContext = await isolatedContext(browser)
  const guest = await guestContext.newPage()
  try {
    await Promise.all([page.goto("/"), guest.goto("/")])
    await pairWorkspace(page, guest)
    await addLead(guest, "Accepted editor history")
    await expect(page.getByRole("button", { name: "Open Accepted editor history — Engineer" })).toBeVisible({ timeout: 20_000 })
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const settings = page.getByRole("dialog", { name: "Device sync" })
    await settings.getByRole("list", { name: "Mesh members" }).getByRole("button").filter({ hasText: "editor" }).click()
    await settings.getByRole("button", { name: "Remove participant", exact: true }).click()
    const confirmation = settings.getByRole("region", { name: "Remove participant confirmation" })
    await expect(confirmation).toContainText("all their devices")
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(guest.getByRole("button", { name: /Add lead to/ }).first()).toBeVisible()
    await settings.getByRole("button", { name: "Remove participant", exact: true }).click()
    await confirmation.getByRole("button", { name: "Remove participant and all devices", exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    await expect(guest.getByLabel("Mesh offline")).toBeVisible({ timeout: 20_000 })

    await expect(guest.getByRole("button", { name: /Add lead to/ })).toHaveCount(0)
    await settings.getByRole("button", { name: "Close", exact: true }).click()
    const fresh = await freshContext.newPage()
    await pairWorkspace(page, fresh)
    await expect(fresh.getByRole("button", { name: "Open Accepted editor history — Engineer" })).toBeVisible()
    await addLead(fresh, "New editor after revocation")
    await expect(page.getByRole("button", { name: "Open New editor after revocation — Engineer" })).toBeVisible({ timeout: 20_000 })
  } finally {
    await Promise.all([guestContext.close(), freshContext.close()])
  }
})

test("Given an online editor, when owner selects them in mesh members and transfers ownership, then roles swap across devices", async ({ browser, page }) => {
  test.setTimeout(120_000)
  await page.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  const guestContext = await isolatedContext(browser)
  await guestContext.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "userAgent", { configurable: true, get: () => "" })
  })
  const guest = await guestContext.newPage()
  try {
    await Promise.all([page.goto("/"), guest.goto("/")])
    await pairWorkspace(page, guest)
    await expect(page.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })

    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Device sync" })
    const members = dialog.getByRole("list", { name: "Mesh members" })
    await expect(members.locator(".mesh-member")).toHaveCount(2)
    await members.getByRole("button").filter({ hasText: "editor" }).click()
    const unknownDevices = dialog.getByRole("list", { name: /Devices for/ })
    await expect(unknownDevices.getByRole("listitem")).toHaveCount(1)
    await expect(unknownDevices).toContainText("Browser / OS unknown")
    await expect(dialog.getByRole("button", { name: "Transfer ownership" })).toBeEnabled()
    await dialog.getByRole("button", { name: "Transfer ownership" }).click()

    await expect(page.getByLabel("Workspace role: editor")).toBeVisible({ timeout: 20_000 })
    await expect(guest.getByLabel("Workspace role: owner")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole("button", { name: "Edit board", exact: true })).toHaveCount(0)
    await expect(guest.getByRole("button", { name: "Edit board", exact: true })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Add someone" })).toHaveCount(0)
    await expect(dialog.getByRole("button", { name: /^Vote for/ })).toHaveCount(0)
    await dialog.getByRole("tab", { name: "Advanced", exact: true }).click()
    await expect(dialog.getByText("No recovery policy.", { exact: false })).toBeVisible()
    await guest.getByRole("button", { name: "Sync", exact: true }).click()
    const newOwnerDialog = guest.getByRole("dialog", { name: "Device sync" })
    await newOwnerDialog.getByRole("list", { name: "Mesh members" }).getByRole("button").filter({ hasText: "editor" }).click()
    const knownDevices = newOwnerDialog.getByRole("list", { name: /Devices for/ })
    await expect(knownDevices).toContainText(/Likely Chrome ·/)
    await expect(knownDevices).toContainText("User agent available in Advanced.")
    await newOwnerDialog.getByRole("button", { name: "Add someone" }).click()
    await expect(newOwnerDialog.getByRole("button", { name: "Generate link" })).toBeEnabled()
    await newOwnerDialog.getByRole("button", { name: "Generate link" }).click()
    await expect(newOwnerDialog.getByLabel("Pairing link")).toHaveValue(/workspace-join/)

    await Promise.all([page.reload(), guest.reload()])
    await expect(page.getByLabel("Workspace role: editor")).toBeVisible({ timeout: 20_000 })
    await expect(guest.getByLabel("Workspace role: owner")).toBeVisible({ timeout: 20_000 })
    await guest.getByRole("button", { name: "Settings" }).click()
    const profile = guest.getByRole("dialog", { name: "Settings" })
    await profile.getByRole("tab", { name: "Identity" }).click()
    await profile.getByRole("textbox", { name: "Name", exact: true }).fill("Successor owner")
    await profile.getByRole("button", { name: "Save name", exact: true }).click()
    await expect(profile.getByRole("button", { name: "Save name", exact: true })).toBeEnabled()
    await expect(profile.getByRole("alert")).toHaveCount(0)

    await page.getByRole("button", { name: "Settings" }).click()
    const formerOwnerProfile = page.getByRole("dialog", { name: "Settings" })
    await formerOwnerProfile.getByRole("tab", { name: "Identity" }).click()
    await formerOwnerProfile.getByRole("textbox", { name: "Name", exact: true }).fill("Former owner editor")
    await formerOwnerProfile.getByRole("button", { name: "Save name", exact: true }).click()
    await expect(formerOwnerProfile.getByRole("button", { name: "Save name", exact: true })).toBeEnabled()
    await expect(formerOwnerProfile.getByRole("alert")).toHaveCount(0)
    await Promise.all([page.reload(), guest.reload()])
    for (const [device, name] of [[page, "Former owner editor"], [guest, "Successor owner"]] as const) {
      await device.getByRole("button", { name: "Settings" }).click()
      const identity = device.getByRole("dialog", { name: "Settings" })
      await identity.getByRole("tab", { name: "Identity" }).click()
      await expect(identity.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name)
    }
  } finally {
    await guestContext.close()
  }
})


test("Given sibling tabs on both devices, when mesh reconnects concurrently, then connections settle without repeated closure", async ({ browser, page }) => {
  test.setTimeout(100_000)
  const context = await isolatedContext(browser)
  const guest = await context.newPage()
  const messages: string[] = []
  const observe = (target: Page) => target.on("console", message => {
    if (message.text().includes("[tincanban.mesh]")) messages.push(message.text())
  })
  observe(page); observe(guest)
  try {
    await Promise.all([page.goto("/"), guest.goto("/")])
    await pairWorkspace(page, guest)
    const sibling = await context.newPage()
    const ownSibling = await page.context().newPage()
    observe(sibling); observe(ownSibling)
    await Promise.all([sibling.goto("/"), ownSibling.goto("/")])
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(sibling.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(ownSibling.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(5_000)
    messages.length = 0
    await page.waitForTimeout(12_000)
    const failures = messages.filter(message => /session\.(receive|publish|heartbeat)\.failed/.test(message))
    expect(failures, messages.join("\n")).toHaveLength(0)
    await addLead(ownSibling, "Stable sibling")
    await expect(sibling.getByRole("button", { name: "Open Stable sibling — Engineer" })).toBeVisible({ timeout: 20_000 })
    await ownSibling.close()
  } finally { await context.close() }
})

test("Given an editor has an unsigned raw branch, when it is reloaded, then it stays quarantined and valid sync continues", async ({ browser, page }) => {
  test.setTimeout(90_000)
  const context = await isolatedContext(browser)
  const guest = await context.newPage()
  let reviewStage = "pair peers"
  try {
    await Promise.all([page.goto("/"), guest.goto("/")])
    await pairWorkspace(page, guest)
    reviewStage = "seed unsigned branch"
    await guest.evaluate(async () => {
      const state = await import("/src/state.ts")
      const storage = await import("/src/storage.ts")
      const A = await import("/@id/@automerge/automerge/slim")
      const doc = state.useTincanban().getActiveDoc()!
      const unsigned = A.change(A.clone(doc), {message:"Regression unsigned edit"}, (draft: { title: string }) => { draft.title = "Untrusted title" })
      const change = A.getLastLocalChange(unsigned)
      if (!change) throw new Error("Expected unsigned local change")
      const existing = await storage.defaultStorage.loadCausalEvidence(doc.id)
      await storage.defaultStorage.commitWorkspace(doc.id, doc, A.save(doc), [], undefined, {
        bytes: A.save(unsigned), decisions: existing?.decisions ?? [],
        authorizationEvidence: existing?.authorizationEvidence ?? [],
      })
    })
    let failReviewModule!: () => void
    const reviewModuleGate = new Promise<void>(resolve => { failReviewModule = resolve })
    let firstReviewRequest = true
    reviewStage = "force review chunk failure"
    await guest.route(/CausalChangeReview\.vue/, async route => {
      if (firstReviewRequest) {
        firstReviewRequest = false
        await reviewModuleGate
        await route.abort()
      } else await route.continue()
    })
    await guest.reload()
    await expect(guest.getByRole("status").filter({ hasText: "Loading workspace change review" })).toBeVisible()
    failReviewModule()
    await expect(guest.getByRole("alert").filter({ hasText: "Workspace change review could not load" })).toBeVisible()
    await expect(guest.getByRole("button", { name: "Dismiss review error" })).toBeVisible()
    await guest.getByRole("button", { name: "Dismiss review error" }).click()
    await expect(guest.getByRole("alert").filter({ hasText: "Workspace change review could not load" })).toHaveCount(0)
    await expect(guest.getByRole("button", { name: "Reload review" })).toBeVisible()
    await guest.getByRole("button", { name: "Reload review" }).click()
    reviewStage = "load and dismiss quarantined change"
    const review = guest.getByRole("region", {name:"Workspace change review"})
    await expect(review).toBeVisible()
    await expect(review.getByText("1 workspace changes need review")).toBeVisible()
    await review.getByText("1 workspace changes need review").click()
    await expect(review.getByText("Quarantined", {exact:true})).toBeVisible()
    await expect(review.getByText(/Untrusted title/)).toBeVisible()
    await guest.evaluate(async () => { (await import("/src/storage.ts")).setStorageFailureHookForTest(true) })
    await review.getByRole("button", { name: "Dismiss review" }).click()
    await expect(guest.getByRole("region", { name: "Workspace change review" })).toHaveCount(0)
    await expect(guest.getByRole("alert").filter({ hasText: "Dismissal could not be saved" })).toBeVisible()
    const reviewHistory = guest.getByRole("region", { name: "Workspace review history" })
    await expect(reviewHistory.getByText("1 change in review history", { exact: true })).toBeVisible()
    await guest.getByRole("button", { name: "Dismiss review error" }).click()
    await expect(guest.getByRole("alert").filter({ hasText: "Dismissal could not be saved" })).toHaveCount(0)
    await guest.evaluate(async () => { (await import("/src/storage.ts")).setStorageFailureHookForTest(false) })
    await reviewHistory.getByText("1 change in review history", { exact: true }).click()
    const dismissedHash = await reviewHistory.locator("code").textContent()
    if (!dismissedHash) throw new Error("Dismissed review hash missing before retry")
    await reviewHistory.getByRole("button", { name: "Retry save dismissal" }).click()
    await expect(reviewHistory.getByRole("button", { name: "Retry save dismissal" })).toHaveCount(0)
    const dismissalBeforeReload = await guest.evaluate(async () => {
      const state = (await import("/src/state.ts")).useTincanban()
      return (await new (await import("/src/storage.ts")).WorkspaceStorage().loadCausalEvidence(state.getActiveDoc()!.id))?.dismissedHashes ?? []
    })
    expect(dismissalBeforeReload).toContain(dismissedHash)
    await guest.reload()
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    const dismissalAfterReload = await guest.evaluate(async () => {
      const state = (await import("/src/state.ts")).useTincanban()
      return (await new (await import("/src/storage.ts")).WorkspaceStorage().loadCausalEvidence(state.getActiveDoc()!.id))?.dismissedHashes ?? []
    })
    expect(dismissalAfterReload).toContain(dismissedHash)
    await expect(guest.getByRole("region", { name: "Workspace change review" })).toHaveCount(0)
    await reviewHistory.getByText("1 change in review history", { exact: true }).click()
    await expect(reviewHistory.getByText(/Untrusted title/)).toBeVisible()
    await reviewHistory.getByRole("button", { name: "Restore review" }).click()
    await expect(guest.getByRole("region", { name: "Workspace change review" })).toBeVisible()
    await expect(guest.getByRole("region", { name: "Workspace change review" }).getByText("1 workspace changes need review")).toBeVisible()
    const persistedTitles = async (peer: Page) => peer.evaluate(async () => {
      const state = (await import("/src/state.ts")).useTincanban()
      const doc = (await new (await import("/src/storage.ts")).WorkspaceStorage().loadWorkspaceDoc(state.getActiveDoc()!.id))?.doc
      return { title: doc?.title, untrustedItem: Object.values(doc?.entities ?? {}).some(entity =>
        (entity as { title?: string }).title === "Untrusted title") }
    })
    expect(await persistedTitles(guest)).toEqual({title:"Job search", untrustedItem:false})
    expect(await persistedTitles(page)).toEqual({title:"Job search", untrustedItem:false})
    await expect(page.getByLabel("Mesh connected")).toBeVisible()
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    reviewStage = "sync valid command while review remains"
    await addLead(guest, "Authorized after quarantine")
    await expect(page.getByRole("button", {name:"Open Authorized after quarantine — Engineer"})).toBeVisible({timeout:20_000})
    await guest.reload()
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({timeout:30_000})
    await expect(guest.getByRole("region", {name:"Workspace change review"})).toBeVisible()
    expect(await persistedTitles(guest)).toEqual({title:"Job search", untrustedItem:false})
    expect(await persistedTitles(page)).toEqual({title:"Job search", untrustedItem:false})
    await expect(page.getByRole("button", {name:"Open Authorized after quarantine — Engineer"})).toBeVisible()
    const activeReview = guest.getByRole("region", { name: "Workspace change review" })
    await activeReview.getByText("1 workspace changes need review").click()
    const sourceHash = await activeReview.locator("code").textContent()
    if (!sourceHash) throw new Error("Quarantined review hash missing")
    const changesBeforeReview = await guest.evaluate(async () => {
      const state = (await import("/src/state.ts")).useTincanban()
      return (await new (await import("/src/storage.ts")).WorkspaceStorage().listChanges(state.getActiveDoc()!.id)).length
    })
    reviewStage = "authorize quarantined change"
    const authorizeReview = activeReview.getByRole("button", { name: "Create authorized change from this review" })
    await expect(authorizeReview).toBeVisible({ timeout: 8_000 })
    await expect(authorizeReview).toBeEnabled({ timeout: 8_000 })
    await authorizeReview.click()
    await expect(guest.getByRole("region", { name: "Workspace change review" })).toHaveCount(0, { timeout: 15_000 })
    await expect.poll(() => persistedTitles(guest)).toEqual({title:"Untrusted title", untrustedItem:false})
    const reviewOutcome = await guest.evaluate(async () => {
      const state = (await import("/src/state.ts")).useTincanban()
      const evidence = await new (await import("/src/storage.ts")).WorkspaceStorage().loadCausalEvidence(state.getActiveDoc()!.id)
      const changes = await new (await import("/src/storage.ts")).WorkspaceStorage().listChanges(state.getActiveDoc()!.id)
      return { decisions: evidence?.decisions, resolvedReviews: evidence?.resolvedReviews ?? [], changeCount: changes.length }
    })
    expect(reviewOutcome.decisions?.find(decision => decision.hash === sourceHash)?.status.type).toBe("quarantined")
    expect(reviewOutcome.resolvedReviews).toEqual([{ sourceHash, authorizedChangeHash: expect.any(String) }])
    expect(reviewOutcome.changeCount).toBe(changesBeforeReview + 1)
    await guest.evaluate(async () => {
      const state = (await import("/src/state.ts")).useTincanban()
      const storage = new (await import("/src/storage.ts")).WorkspaceStorage()
      const workspaceId = state.getActiveDoc()!.id
      const evidence = await storage.loadCausalEvidence(workspaceId)
      const doc = (await storage.loadWorkspaceDoc(workspaceId))?.doc
      if (!evidence || !doc) throw new Error("Review history missing before legacy-link check")
      const A = await import("/@id/@automerge/automerge/slim")
      await storage.commitWorkspace(workspaceId, doc, A.save(doc), [], undefined,
        { ...evidence, dismissedHashes: [], resolvedReviews: [] })
    })
    await guest.reload()
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    const legacyLinkEvidence = await guest.evaluate(async () => {
      const state = (await import("/src/state.ts")).useTincanban()
      return state.causalReview.value.map(change => ({ hash: change.hash, dismissed: change.dismissed, resolved: change.resolved }))
    })
    expect(legacyLinkEvidence).toContainEqual({ hash: sourceHash, dismissed: true, resolved: true })
    await expect(guest.getByRole("region", { name: "Workspace change review" })).toHaveCount(0)
    const resolvedHistory = guest.getByRole("region", { name: "Workspace review history" })
    await resolvedHistory.getByText("1 change in review history", { exact: true }).click()
    await expect(resolvedHistory.getByText("Authorized change saved", { exact: true })).toBeVisible()
    await expect(resolvedHistory.getByRole("button", { name: "Create authorized change from this review" })).toHaveCount(0)
    const duplicateReviewResult = await guest.evaluate(async hash => {
      const state = (await import("/src/state.ts")).useTincanban()
      try { await state.reviewCausalChange(hash); return "unexpected success" }
      catch (error) { return error instanceof Error ? error.message : String(error) }
    }, sourceHash)
    expect(duplicateReviewResult).toContain("already has an authorized change")
    const changesAfterDuplicateAttempt = await guest.evaluate(async () => {
      const state = (await import("/src/state.ts")).useTincanban()
      return (await new (await import("/src/storage.ts")).WorkspaceStorage().listChanges(state.getActiveDoc()!.id)).length
    })
    expect(changesAfterDuplicateAttempt).toBe(reviewOutcome.changeCount)
    expect(await persistedTitles(guest)).toEqual({title:"Untrusted title", untrustedItem:false})
  } catch (error) {
    throw new Error(`Review lifecycle failed during ${reviewStage}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  } finally { await context.close().catch(() => {}) }
})

test("Given chat history exceeds one control frame, when paired peers reconnect, then history and subsequent edits sync", async ({ browser, page }) => {
  test.setTimeout(90_000)
  const context = await isolatedContext(browser)
  const guest = await context.newPage()
  const failures: string[] = []
  for (const peer of [page, guest]) peer.on("console", message => {
    if (message.text().includes("Mesh control frame exceeds")) failures.push(message.text())
  })
  try {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    const before = await page.evaluate(async () => {
      const { useTincanban } = await import("/src/state.ts")
      const { sendChatMessage, exportChat, loadChat } = await import("/src/chat/service.ts")
      const id = useTincanban().getActiveDoc()!.id
      for (let i = 0; i < 40; i++) await sendChatMessage(id, `${i}: ${"x".repeat(7500)}`)
      const exported = await exportChat(id)
      return { id, size: new TextEncoder().encode(JSON.stringify(exported)).length,
        count: (await loadChat(id)).messages.length }
    })
    expect(before.size).toBeGreaterThan(256 * 1024)
    expect(before.count).toBe(40)
    await guest.goto("/")
    await pairWorkspace(page, guest)
    expect(await page.evaluate(async () => (await import("/src/state.ts")).useTincanban().getActiveDoc()!.id)).toBe(before.id)
    const chatCount = () => guest.evaluate(async () => {
      const { useTincanban } = await import("/src/state.ts")
      const { loadChat } = await import("/src/chat/service.ts")
      return (await loadChat(useTincanban().getActiveDoc()!.id)).messages.length
    })
    await expect.poll(chatCount, { timeout: 20_000 }).toBe(40)
    await guest.reload()
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect.poll(chatCount, { timeout: 20_000 }).toBe(40)
    await addLead(guest, "After large control")
    await expect(page.getByRole("button", { name: "Open After large control — Engineer" })).toBeVisible({ timeout: 20_000 })
    expect(failures).toEqual([])
  } finally { await context.close() }
})
