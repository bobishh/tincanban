import { expect, test, type BrowserContext, type Page } from "./support/coverage"
import { approveRustyForFixture, readStoredBoardAccess } from "./support/identityRustyFixture"
import { createJobSearchWorkspace, ensureJobSearchWorkspace, addJobSearchLead as addLead } from "./support/workspaces"
import { startRustyService } from "./support/rustyService"

type PublicProfile = { identity: { personId: string }; device: { deviceId: string; publicKey: string } }

async function profile(page: Page): Promise<PublicProfile> {
  return page.evaluate(async () => {
    const raw = await (await import("/src/localDb.ts")).readLocal("tincanban.local_profile.v1")
    if (!raw) throw new Error("Local identity profile was not saved")
    return JSON.parse(raw) as PublicProfile
  })
}

type PageFailure = { label: string; event: "crash" } | { label: string; event: "pageerror"; name: string }

type ReconnectDiagnostic = {
  label: string
  event: "workspace.frame.rejected" | "mesh.rusty.inventory.failed"
  workspaceId?: string
  peerId?: string
  reason?: string
  entityType?: string
  entityId?: string
  operation?: string
  phase?: string
  errorName?: string
  errorMessage?: string
}

type RustyHttpFailure = { label: string; method: string; path: string; status: number; message?: string }

function logPageFailure(page: Page, label: string, failures: PageFailure[]) {
  page.on("crash", () => {
    const failure = { label, event: "crash" } as const
    failures.push(failure)
    console.error(`[owner-reconnect.page] ${JSON.stringify(failure)}`)
  })
  page.on("pageerror", error => {
    const failure = { label, event: "pageerror", name: error.name } as const
    failures.push(failure)
    console.error(`[owner-reconnect.page] ${JSON.stringify(failure)}`)
  })
}

function captureReconnectDiagnostics(
  page: Page,
  label: string,
  events: ReconnectDiagnostic[],
  rustyOrigin: string | undefined,
  rustyFailures: RustyHttpFailure[],
  pendingRustyResponses: Promise<void>[],
) {
  page.on("console", message => {
    const match = message.text().match(/\[tincanban\.mesh\]\s+(\{.*\})/)
    if (!match) return
    let record: Record<string, unknown>
    try { record = JSON.parse(match[1]) as Record<string, unknown> }
    catch { return }
    const event = record.event
    if (event !== "workspace.frame.rejected" && event !== "mesh.rusty.inventory.failed") return
    const diagnostic: ReconnectDiagnostic = {
      label,
      event,
      ...(typeof record.workspaceId === "string" ? { workspaceId: record.workspaceId } : {}),
      ...(typeof record.peerId === "string" ? { peerId: record.peerId } : {}),
      ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
      ...(typeof record.entityType === "string" ? { entityType: record.entityType } : {}),
      ...(typeof record.entityId === "string" ? { entityId: record.entityId } : {}),
      ...(typeof record.operation === "string" ? { operation: record.operation } : {}),
      ...(typeof record.phase === "string" ? { phase: record.phase } : {}),
    }
    if (record.error && typeof record.error === "object") {
      const error = record.error as Record<string, unknown>
      if (typeof error.name === "string") diagnostic.errorName = error.name
      if (typeof error.message === "string") diagnostic.errorMessage = error.message.slice(0, 240)
    }
    events.push(diagnostic)
    console.error(`[owner-reconnect.diagnostic] ${JSON.stringify(diagnostic)}`)
  })

  if (!rustyOrigin) return
  page.on("response", response => {
    const pending = (async () => {
      const url = new URL(response.url())
      const request = response.request()
      if (url.origin !== rustyOrigin || request.method() !== "GET" ||
          !/^\/v2\/scopes\/[^/]+\/objects$/.test(url.pathname) || response.status() < 400) return
      const failure: RustyHttpFailure = {
        label,
        method: request.method(),
        path: `${url.pathname}${url.search}`,
        status: response.status(),
      }
      try {
        const body: unknown = await response.json()
        if (body && typeof body === "object" && "message" in body && typeof body.message === "string") {
          failure.message = body.message.slice(0, 240)
        }
      } catch { /* Keep status and path when the error response is not JSON. */ }
      rustyFailures.push(failure)
      console.error(`[owner-reconnect.rusty-http] ${JSON.stringify(failure)}`)
    })()
    pendingRustyResponses.push(pending)
  })
}

async function enrollDevice(hostPage: Page, recipient: Page) {
  await hostPage.getByRole("button", { name: "Sync", exact: true }).click()
  const host = hostPage.getByRole("dialog", { name: "Device sync" })
  await host.getByRole("button", { name: "Add someone", exact: true }).click()
  await host.getByRole("button", { name: "Add my device", exact: true }).click()
  await recipient.goto(await host.getByLabel("Pairing link").inputValue())
  const join = recipient.getByRole("dialog", { name: "Device sync" })
  await join.getByRole("button", { name: "Add this device", exact: true }).waitFor({ state: "visible" })
  if (await join.getByRole("checkbox", { name: /Replace this device.s identity/ }).count()) {
    await join.getByRole("checkbox", { name: /Replace this device.s identity/ }).check()
  }
  await join.getByRole("button", { name: "Add this device", exact: true }).click()
  await host.getByRole("button", { name: "Approve device", exact: true }).click()
  await expect(join.getByText("Device enrolled", { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(host.getByText("Device enrolled", { exact: true })).toBeVisible({ timeout: 30_000 })
  await join.getByRole("button", { name: "Close", exact: true }).click()
  await host.getByRole("button", { name: "Close", exact: true }).click()
}

async function connectRusty(page: Page, origin: string) {
  await approveRustyForFixture(page, origin)
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const panel = page.getByRole("region", { name: "Rusty", exact: true })
  await panel.getByRole("button", { name: "Add Rusty", exact: true }).click()
  await panel.getByLabel("Address", { exact: true }).fill(origin)
  await panel.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(panel.locator(".rusty-connection").getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(panel.getByRole("button", { name: "Sync now", exact: true })).toBeEnabled()
  await page.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Close", exact: true }).click()
  return panel
}


async function localReconnectState(page: Page) {
  return page.evaluate(async () => {
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const { defaultStorage } = await import("/src/storage.ts")
    const { getReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
    const profile = await bootstrapIdentity()
    const [root, workspaces, replicas] = await Promise.all([
      defaultStorage.loadPersonalRoot(), defaultStorage.listWorkspaces(), getReplicaConfigurations(profile.identity.personId),
    ])
    return {
      workspaceIds: workspaces.map(workspace => workspace.id).sort(),
      rootWorkspaceIds: Object.keys(root?.workspaces ?? {}).sort(),
      replicaWorkspaceIds: replicas.map(config => config.workspaceId).sort(),
    }
  })
}

async function participantReconnectSourceReady(page: Page, workspaceId: string): Promise<boolean> {
  return page.evaluate(async id => {
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const { defaultStorage } = await import("/src/storage.ts")
    const { getReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
    const { peerStore } = await import("/src/sync/peerStore.ts")
    const profile = await bootstrapIdentity()
    const [configurations, credential, authority, stored] = await Promise.all([
      getReplicaConfigurations(profile.identity.personId), peerStore.getWorkspaceCredential(id), peerStore.getWorkspaceAuthority(id),
      defaultStorage.loadWorkspaceDoc(id),
    ])
    const config = configurations.find(value => value.workspaceId === id && !value.removalPending && value.boardAccess)
    const access = config?.boardAccess
    const payload = access?.authorization.payload
    const grant = payload?.workspaceGrant ?? credential?.localGrant
    const ownerProofReady = payload?.version === 1
      ? typeof payload.writeTokenHash === "string"
      : payload?.version === 2 && Boolean(access?.principalGrant && payload.readTokenHash && payload.workspaceGrant)
    return Boolean(config && access?.mode === "write" && access.certificates.length && ownerProofReady &&
      payload?.workspaceId === id && payload.ownerPersonId === credential?.ownerPersonId &&
      payload.connection.scopeId === config.scopeId && payload.connection.origin === config.origin &&
      payload.connection.servicePublicKey === config.servicePublicKey && config.writeToken && config.readToken && config.contentKey &&
      grant?.payload.workspaceId === id && grant.payload.personId === profile.identity.personId &&
      credential?.workspaceId === id && authority?.workspaceId === id && credential.ownerPersonId === authority.ownerPersonId &&
      stored?.doc.id === id && stored.doc.ownerPersonId === credential.ownerPersonId)
  }, workspaceId)
}

async function participantReconnectSourceReadyWithoutRusty(page: Page, workspaceId: string): Promise<boolean> {
  return page.evaluate(async id => {
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const { defaultStorage } = await import("/src/storage.ts")
    const { getReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
    const { peerStore } = await import("/src/sync/peerStore.ts")
    const profile = await bootstrapIdentity()
    const [credential, authority, stored, configurations] = await Promise.all([
      peerStore.getWorkspaceCredential(id), peerStore.getWorkspaceAuthority(id), defaultStorage.loadWorkspaceDoc(id),
      getReplicaConfigurations(profile.identity.personId),
    ])
    return Boolean(credential && authority && stored?.doc.id === id && stored.doc.ownerPersonId === credential.ownerPersonId &&
      authority.workspaceId === id && authority.ownerPersonId === credential.ownerPersonId &&
      credential.localGrant?.payload.workspaceId === id && credential.localGrant.payload.personId === profile.identity.personId &&
      !configurations.some(config => config.workspaceId === id))
  }, workspaceId)
}

async function createSignedLegacyAccess(ownerPage: Page, workspaceId: string) {
  return ownerPage.evaluate(async id => {
    const { bootstrapIdentity, sha256Base64Url, signEnvelope } = await import("/src/domain/identity.ts")
    const { getReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
    const { readIdentityAuthorityView } = await import("/src/sync/identityAuthorityStore.ts")
    const profile = await bootstrapIdentity()
    const config = (await getReplicaConfigurations(profile.identity.personId))
      .find(value => value.workspaceId === id && !value.boardAccess && !value.removalPending)
    const authority = await readIdentityAuthorityView(profile.identity.personId)
    if (!config?.writeToken || !authority || !profile.privateKeys.devicePrivateKey) {
      throw new Error("Current owner storage material is not ready for the retained-v1 fixture")
    }
    const connection = Object.fromEntries(Object.entries(config)
      .filter(([key]) => !["boardAccess", "writeToken", "cursor", "lastUploaded", "preferenceRevision"].includes(key)))
    const authorization = await signEnvelope(profile.privateKeys.devicePrivateKey, {
      kind: "workspace-rusty-access", version: 1, workspaceId: id, ownerPersonId: profile.identity.personId,
      connection, writeTokenHash: await sha256Base64Url(new TextEncoder().encode(config.writeToken)),
    }, profile.device.deviceId)
    return { mode: "write" as const, authorization, certificates: authority.certificates }
  }, workspaceId)
}

async function installSignedLegacyAccess(participantPage: Page, workspaceId: string,
  ownerAccess: Awaited<ReturnType<typeof createSignedLegacyAccess>>): Promise<void> {
  await participantPage.evaluate(async ({ id, ownerAccess }) => {
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const { getReplicaConfigurations, setReplicaPreference } = await import("/src/sync/privateReplicaRepository.ts")
    const profile = await bootstrapIdentity()
    const config = (await getReplicaConfigurations(profile.identity.personId))
      .find(value => value.workspaceId === id && value.boardAccess && !value.removalPending)
    if (!config) throw new Error("Joined participant storage config is not ready for the retained-v1 fixture")
    await setReplicaPreference(profile.identity.personId, { ...config, boardAccess: ownerAccess })
  }, { id: workspaceId, ownerAccess })
}

async function retainLegacyOwnerAccess(ownerPage: Page, participantPage: Page, workspaceId: string) {
  await installSignedLegacyAccess(participantPage, workspaceId, await createSignedLegacyAccess(ownerPage, workspaceId))
}

for (const storageVersion of [1, 2, "none"] as const) {
const storageDescription = storageVersion === "none" ? "without Rusty storage access" : `with retained v${storageVersion} storage access`
test(`Given a participant copy and a current owner Identity device ${storageDescription}, when owner reconnect is offered, then wrong identities write nothing and the owner restores the same board`, async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000)
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const initialOwner = await profile(page)
  const rusty = storageVersion === "none" ? undefined : await startRustyService(
    { identity: initialOwner.identity, allowedControllerDeviceIds: [initialOwner.device.deviceId] }, baseURL!)
  const ownerDeviceContext = await browser.newContext()
  const wrongOwnerContext = await browser.newContext()
  const participantContext = await browser.newContext()
  const ownerDevice = await ownerDeviceContext.newPage()
  const wrongOwner = await wrongOwnerContext.newPage()
  const participant = await participantContext.newPage()
  const pageFailures: PageFailure[] = []
  const reconnectDiagnostics: ReconnectDiagnostic[] = []
  const rustyHttpFailures: RustyHttpFailure[] = []
  const pendingRustyResponses: Promise<void>[] = []
  const fixtureDevices: Record<string, { personId: string; deviceId: string }> = {}
  logPageFailure(page, "original-owner", pageFailures)
  logPageFailure(ownerDevice, "returning-owner-device", pageFailures)
  logPageFailure(wrongOwner, "wrong-identity", pageFailures)
  logPageFailure(participant, "retained-participant", pageFailures)
  captureReconnectDiagnostics(page, "original-owner", reconnectDiagnostics, rusty?.origin, rustyHttpFailures, pendingRustyResponses)
  captureReconnectDiagnostics(ownerDevice, "returning-owner-device", reconnectDiagnostics, rusty?.origin, rustyHttpFailures, pendingRustyResponses)
  captureReconnectDiagnostics(wrongOwner, "wrong-identity", reconnectDiagnostics, rusty?.origin, rustyHttpFailures, pendingRustyResponses)
  captureReconnectDiagnostics(participant, "retained-participant", reconnectDiagnostics, rusty?.origin, rustyHttpFailures, pendingRustyResponses)
  let wrongOwnerContextClosed = false
  let originalWorkspaceId: string | undefined
  try {
    // Enroll this current owner Identity device before creating the board to reconnect.
    // It has the active Identity authority but no local copy of that later board.
    await enrollDevice(page, ownerDevice)
    const initialOwnerProfile = await profile(page)
    const returningOwnerProfile = await profile(ownerDevice)
    fixtureDevices["initial-owner"] = { personId: initialOwnerProfile.identity.personId, deviceId: initialOwnerProfile.device.deviceId }
    fixtureDevices["returning-owner-device"] = { personId: returningOwnerProfile.identity.personId, deviceId: returningOwnerProfile.device.deviceId }
    await ownerDevice.goto("about:blank")
    await createJobSearchWorkspace(page, "Original board")
    originalWorkspaceId = await page.evaluate(async () =>
      (await import("/src/test/stateFixture.ts")).useTincanban().activeWorkspace.id)
    await addLead(page, "Owner restored")
    if (rusty) await connectRusty(page, rusty.origin)

    await participant.goto("/")
    await ensureJobSearchWorkspace(participant)
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const host = page.getByRole("dialog", { name: "Device sync" })
    await host.getByRole("button", { name: "Add someone", exact: true }).click()
    await host.getByRole("button", { name: "Generate link", exact: true }).click()
    await participant.goto(await host.getByLabel("Pairing link").inputValue())
    const join = participant.getByRole("dialog", { name: "Device sync" })
    await join.getByRole("button", { name: "Accept and join", exact: true }).click()
    await page.getByLabel("Participant role").selectOption("editor")
    await page.getByRole("button", { name: "Approve access", exact: true }).click()
    await expect(join.getByText("Connected to Original board", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(participant.getByRole("button", { name: "Open Owner restored — Engineer" })).toBeVisible({ timeout: 30_000 })
    const participantProfile = await profile(participant)
    fixtureDevices["retained-participant"] = { personId: participantProfile.identity.personId, deviceId: participantProfile.device.deviceId }
    const sourceReady = () => storageVersion === "none"
      ? participantReconnectSourceReadyWithoutRusty(participant, originalWorkspaceId)
      : participantReconnectSourceReady(participant, originalWorkspaceId)
    await expect.poll(sourceReady, { timeout: 30_000 }).toBe(true)
    if (storageVersion === 1) {
      await retainLegacyOwnerAccess(page, participant, originalWorkspaceId)
      await expect.poll(sourceReady, { timeout: 30_000 }).toBe(true)
    }
    await join.getByRole("button", { name: "Close", exact: true }).first().click()
    await host.getByRole("button", { name: "Close", exact: true }).first().click()
    await page.close()

    await participant.getByRole("button", { name: "Sync", exact: true }).click()
    const participantSync = participant.getByRole("dialog", { name: "Device sync" })
    await participantSync.getByRole("button", { name: "Connect owner device", exact: true }).click()
    const returnLink = await participantSync.getByLabel("Pairing link", { exact: true }).inputValue()

    await wrongOwner.goto("/")
    await ensureJobSearchWorkspace(wrongOwner)
    const wrongOwnerProfile = await profile(wrongOwner)
    fixtureDevices["wrong-identity"] = { personId: wrongOwnerProfile.identity.personId, deviceId: wrongOwnerProfile.device.deviceId }
    const wrongOwnerBefore = await localReconnectState(wrongOwner)
    const participantBeforeWrongOwner = await localReconnectState(participant)
    await wrongOwner.goto(returnLink)
    const wrongOwnerSync = wrongOwner.getByRole("dialog", { name: "Device sync" })
    await expect(wrongOwnerSync.getByRole("alert")).toContainText(/owner|Identity/i, { timeout: 30_000 })
    await expect.poll(() => localReconnectState(wrongOwner)).toEqual(wrongOwnerBefore)
    await expect.poll(() => localReconnectState(participant)).toEqual(participantBeforeWrongOwner)
    await wrongOwnerContext.close()
    wrongOwnerContextClosed = true

    await ownerDevice.goto(baseURL!)
    const ownerBeforeChallenge = await localReconnectState(ownerDevice)
    await ownerDevice.goto(returnLink)
    const ownerSync = ownerDevice.getByRole("dialog", { name: "Device sync" })
    await expect(ownerSync.getByText("Sync your existing board", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => localReconnectState(ownerDevice)).toEqual(ownerBeforeChallenge)
    await expect.poll(() => ownerDevice.evaluate(async workspaceId => {
      const { defaultStorage } = await import("/src/storage.ts")
      return (await defaultStorage.listWorkspaces()).some(workspace => workspace.id === workspaceId)
    }, originalWorkspaceId)).toBe(false)
    await ownerSync.getByRole("button", { name: "Continue", exact: true }).click()

    await expect(ownerDevice.getByRole("region", { name: "Original board", exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(ownerDevice.getByRole("button", { name: "Open Owner restored — Engineer" })).toBeVisible()
    const restored = await ownerDevice.evaluate(async workspaceId => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { defaultStorage } = await import("/src/storage.ts")
      const { getReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
      const profile = await bootstrapIdentity()
      const [root, workspaces] = await Promise.all([defaultStorage.loadPersonalRoot(), defaultStorage.listWorkspaces()])
      const stored = await defaultStorage.loadWorkspaceDoc(workspaceId)
      const replicas = await getReplicaConfigurations(profile.identity.personId)
      return {
        ids: workspaces.filter(workspace => workspace.id === workspaceId).map(workspace => workspace.id),
        rootReference: root?.workspaces[workspaceId],
        ownerPersonId: stored?.doc.ownerPersonId,
        currentPersonId: profile.identity.personId,
        ownerConfigCount: replicas.filter(config => config.workspaceId === workspaceId && !config.boardAccess).length,
      }
    }, originalWorkspaceId)
    expect(restored).toMatchObject({ ids: [originalWorkspaceId],
      rootReference: { workspaceId: originalWorkspaceId, documentId: originalWorkspaceId, forgotten: false },
      ownerPersonId: restored.currentPersonId, ownerConfigCount: storageVersion === "none" ? 0 : 1 })

    await ownerDevice.reload()
    await expect(ownerDevice.getByRole("region", { name: "Original board", exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(ownerDevice.getByRole("button", { name: "Open Owner restored — Engineer" })).toBeVisible({ timeout: 30_000 })
    await ownerDevice.getByRole("button", { name: "Sync", exact: true }).click()
    const ownerSyncAfterReload = ownerDevice.getByRole("dialog", { name: "Device sync" })
    await expect(ownerDevice.getByRole("img", { name: "Workspace role: owner", exact: true })).toBeVisible()
    const ownerMemberRole = ownerSyncAfterReload.locator(".mesh-member").filter({ hasText: /· You/ }).locator(".mesh-member-role")
    await expect(ownerMemberRole).toHaveText("owner")
    if (rusty) {
      const ownerRustyPanel = ownerDevice.getByRole("region", { name: "Rusty", exact: true })
      const ownerBoardStatus = ownerRustyPanel.locator(".rusty-connection").getByRole("status")
      await expect(ownerBoardStatus).toHaveText("Synced", { timeout: 30_000 })
      await ownerRustyPanel.getByRole("button", { name: "Sync now", exact: true }).click()
      await expect(ownerBoardStatus).toHaveText("Synced", { timeout: 30_000 })
    }
    await ownerSyncAfterReload.getByRole("button", { name: "Close", exact: true }).click()

    await addLead(ownerDevice, "Owner sync after reconnect")
    await expect(participant.getByRole("button", { name: "Open Owner sync after reconnect — Engineer" }))
      .toBeVisible({ timeout: 30_000 })

    if (rusty) {
      const ownerWorkspaceUrl = ownerDevice.url()
      await ownerDevice.goto("about:blank")
      await addLead(participant, "Ray sync after owner offline")
      await participant.getByRole("button", { name: "Sync", exact: true }).click()
      const participantSync = participant.getByRole("dialog", { name: "Device sync" })
      const rayRustyPanel = participantSync.getByRole("region", { name: "Rusty", exact: true })
      const rayBoardStatus = rayRustyPanel.locator(".rusty-connection").getByRole("status")
      await rayRustyPanel.locator("summary").filter({ hasText: "Rusty" }).click()
      const rayBoardLastSync = rayRustyPanel.locator("time")
      await expect(rayBoardStatus).toHaveText("Synced", { timeout: 30_000 })
      await expect(rayBoardLastSync).toHaveAttribute("datetime")
      const priorRaySync = Date.parse(await rayBoardLastSync.getAttribute("datetime") ?? "")
      expect(Number.isFinite(priorRaySync)).toBe(true)
      await rayRustyPanel.getByRole("button", { name: "Sync now", exact: true }).click()
      await expect(rayBoardStatus).toHaveText("Synced", { timeout: 30_000 })
      await expect.poll(async () => Date.parse(await rayBoardLastSync.getAttribute("datetime") ?? ""),
        { timeout: 30_000 }).toBeGreaterThan(priorRaySync)
      await participantSync.getByRole("button", { name: "Close", exact: true }).click()

      await ownerDevice.goto(ownerWorkspaceUrl)
      await expect(ownerDevice.getByRole("region", { name: "Original board", exact: true })).toBeVisible({ timeout: 30_000 })
      await ownerDevice.getByRole("button", { name: "Sync", exact: true }).click()
      const returningOwnerSync = ownerDevice.getByRole("dialog", { name: "Device sync" })
      await ownerDevice.getByRole("region", { name: "Rusty", exact: true })
        .getByRole("button", { name: "Sync now", exact: true }).click()
      await expect(ownerDevice.getByRole("button", { name: "Open Ray sync after owner offline — Engineer" }))
        .toBeVisible({ timeout: 30_000 })
      await returningOwnerSync.getByRole("button", { name: "Close", exact: true }).click()
    }

    await participant.getByRole("button", { name: "Sync", exact: true }).click()
    const memberRole = participant.getByRole("dialog", { name: "Device sync" })
      .locator(".mesh-member").filter({ hasText: /· You/ }).locator(".mesh-member-role")
    await expect(memberRole).toHaveText("editor")
    const returningOwnerDeviceId = fixtureDevices["returning-owner-device"]?.deviceId
    expect(returningOwnerDeviceId).toBeTruthy()
    expect(reconnectDiagnostics.filter(diagnostic =>
      diagnostic.label === "retained-participant" && diagnostic.event === "workspace.frame.rejected" &&
      diagnostic.peerId === returningOwnerDeviceId,
    )).toEqual([])
  } finally {
    await participantContext.close()
    if (!wrongOwnerContextClosed) await wrongOwnerContext.close()
    await ownerDeviceContext.close()
    if (rusty) await rusty.close()
    await Promise.allSettled(pendingRustyResponses)
    await test.info().attach("owner-reconnect-targeted-diagnostics.json", {
      body: Buffer.from(JSON.stringify({ storageVersion, workspaceId: originalWorkspaceId, fixtureDevices,
        events: reconnectDiagnostics, rustyHttpFailures }, null, 2)),
      contentType: "application/json",
    })
  }
  expect(pageFailures).toEqual([])
})
}

test("Given Bo and Ray already share a Rusty-backed board, when principal registration fails during owner reconnect, then P2P edits continue and Rusty accepts a retried grant", async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000)
  const rusty = await startRustyService({}, baseURL!)
  const rayContext = await browser.newContext()
  const ray = await rayContext.newPage()
  const ownerContext = page.context()
  let bo = page
  const origin = rusty.origin
  const principalFailures: string[] = []
  const principalSuccesses: number[] = []
  const legacyRayWrites: number[] = []
  let coldOwner: BrowserContext | undefined
  let coldRay: BrowserContext | undefined
  let registrationUnavailable = false
  let retainingLegacyAccess = false

  try {
    await page.context().route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
    await rayContext.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
    await Promise.all([page.goto("/"), ray.goto("/")])
    ray.on("response", response => {
      if (!retainingLegacyAccess) return
      const url = new URL(response.url())
      if (url.origin === origin && response.request().method() === "PUT" && /\/objects(?:\/|$)/u.test(url.pathname)) {
        legacyRayWrites.push(response.status())
      }
    })
    await createJobSearchWorkspace(page, "Bo and Ray")
    await approveRustyForFixture(page, origin)

    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const ownerSync = page.getByRole("dialog", { name: "Device sync" })
    const rustyPanel = ownerSync.getByRole("region", { name: "Rusty", exact: true })
    await rustyPanel.getByRole("button", { name: "Add Rusty", exact: true }).click()
    await rustyPanel.getByLabel("Address", { exact: true }).fill(origin)
    await rustyPanel.getByRole("button", { name: "Connect", exact: true }).click()
    await expect(rustyPanel.locator(".rusty-connections .rusty-connection").first().getByText("Synced", { exact: true }))
      .toBeVisible({ timeout: 30_000 })

    await ownerSync.getByRole("button", { name: "Add someone", exact: true }).click()
    await ownerSync.getByRole("button", { name: "Generate link", exact: true }).click()
    await ray.goto(await ownerSync.getByLabel("Pairing link").inputValue())
    const raySync = ray.getByRole("dialog", { name: "Device sync" })
    await raySync.getByRole("button", { name: "Accept and join", exact: true }).click()
    await ownerSync.getByLabel("Participant role").selectOption("editor")
    await ownerSync.getByRole("button", { name: "Approve access", exact: true }).click()
    await expect(raySync.getByText(/Connected to/)).toBeVisible({ timeout: 30_000 })
    await expect(ray.getByLabel("Workspace role: editor")).toBeVisible({ timeout: 30_000 })
    const workspaceId = await page.evaluate(async () => (await import("/src/state.ts")).useTincanban().activeWorkspace.id)
    await expect.poll(() => readStoredBoardAccess(ray, workspaceId), { timeout: 30_000 }).toMatchObject({
      version: 2, mode: "write",
    })
    const initialAccess = await readStoredBoardAccess(ray, workspaceId)
    expect(initialAccess.personId).toBeTruthy()
    expect(initialAccess.subjectPersonId).toBe(initialAccess.personId)
    expect(initialAccess.scopeId).toBeTruthy()
    await raySync.getByRole("button", { name: "Close", exact: true }).first().click()
    if (await raySync.isVisible()) await raySync.getByRole("button", { name: "Close", exact: true }).first().click()
    if (await ownerSync.isVisible()) await ownerSync.getByRole("button", { name: "Close", exact: true }).click()

    await ownerContext.route(`${origin}/v2/scopes/**/principals/**`, async route => {
      if (route.request().method() !== "PUT") return route.continue()
      if (registrationUnavailable) {
        principalFailures.push(route.request().url())
        return route.fulfill({ status: 503, body: JSON.stringify({ message: "Rusty principal registration unavailable" }) })
      }
      const response = await route.fetch()
      principalSuccesses.push(response.status())
      return route.fulfill({ response })
    })
    const scopeId = initialAccess.scopeId
    if (!scopeId) throw new Error("Shared board has no Rusty scope")
    const boardObjectsPath = `${origin}/v2/scopes/${encodeURIComponent(scopeId)}/objects**`
    const blockedBoardObjects: Array<{ method: string; url: string; status: 503 }> = []
    for (const context of [ownerContext, rayContext]) {
      await context.route(boardObjectsPath, async route => {
        const method = route.request().method()
        if (registrationUnavailable && (method === "GET" || method === "PUT")) {
          blockedBoardObjects.push({ method, url: route.request().url(), status: 503 })
          return route.fulfill({ status: 503, body: "Rusty board data temporarily unavailable" })
        }
        return route.continue()
      })
    }

    // A fresh owner runtime re-announces the retained peer and retries its
    // service grant independently of the workspace transfer.
    registrationUnavailable = true
    const legacyAccess = await createSignedLegacyAccess(bo, workspaceId)
    await bo.close()
    await installSignedLegacyAccess(ray, workspaceId, legacyAccess)
    retainingLegacyAccess = true
    const failuresBeforeFreshRuntime = principalFailures.length
    bo = await ownerContext.newPage()
    await bo.goto("/")
    await expect(bo.getByLabel("Workspace role: owner")).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => principalFailures.length, { timeout: 45_000 }).toBeGreaterThan(failuresBeforeFreshRuntime)
    await expect(bo.getByLabel(/^Devices connected/u)).toBeVisible({ timeout: 30_000 })
    await expect(ray.getByLabel(/^Devices connected/u)).toBeVisible({ timeout: 30_000 })
    await expect(ray.getByLabel("Workspace role: editor")).toBeVisible()
    await ray.getByRole("button", { name: "Sync", exact: true }).click()
    const legacyRusty = ray.getByRole("region", { name: "Rusty", exact: true })
    await expect(legacyRusty.getByText("Waiting for access", { exact: true })).toBeVisible({ timeout: 30_000 })
    if (await raySync.isVisible()) await raySync.getByRole("button", { name: "Close", exact: true }).first().click()

    await addLead(bo, "Bo edit during Rusty outage")
    await expect(ray.getByRole("button", { name: "Open Bo edit during Rusty outage — Engineer", exact: true }))
      .toBeVisible({ timeout: 30_000 })
    await addLead(ray, "Ray edit during Rusty outage")
    await expect(bo.getByRole("button", { name: "Open Ray edit during Rusty outage — Engineer", exact: true }))
      .toBeVisible({ timeout: 30_000 })
    expect(blockedBoardObjects.every(request => request.status === 503)).toBe(true)
    expect(await ray.evaluate(async id => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { getReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
      const profile = await bootstrapIdentity()
      const config = (await getReplicaConfigurations(profile.identity.personId)).find(value => value.workspaceId === id)
      return config?.boardAccess?.authorization.payload.version
    }, workspaceId)).toBe(1)
    expect(await bo.evaluate(async () => (await import("/src/state.ts")).useTincanban().activeWorkspace.id)).toBe(workspaceId)

    registrationUnavailable = false
    await expect.poll(() => principalSuccesses.some(status => status >= 200 && status < 300), { timeout: 60_000 }).toBe(true)
    await expect.poll(() => readStoredBoardAccess(ray, workspaceId), { timeout: 30_000 }).toMatchObject({
      version: 2, mode: "write",
    })
    const retriedAccess = await readStoredBoardAccess(ray, workspaceId)
    expect(retriedAccess.subjectPersonId).toBe(retriedAccess.personId)
    retainingLegacyAccess = false
    expect(legacyRayWrites.filter(status => status >= 200 && status < 300)).toHaveLength(0)
    await expect(ray.getByRole("button", { name: "Open Ray edit during Rusty outage — Engineer", exact: true })).toBeVisible()

    const [ownerState, rayState] = await Promise.all([
      ownerContext.storageState({ indexedDB: true }), rayContext.storageState({ indexedDB: true }),
    ])
    await Promise.all([ownerContext.close(), rayContext.close()])
    coldOwner = await browser.newContext({ storageState: ownerState })
    coldRay = await browser.newContext({ storageState: rayState })
    for (const context of [coldOwner, coldRay]) {
      await context.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
      await context.routeWebSocket("**/*", socket => socket.close())
    }
    const restoredBo = await coldOwner.newPage()
    const editor = await coldRay.newPage()
    const rayWrites: number[] = []
    const boReads: number[] = []
    editor.on("response", response => {
      if (new URL(response.url()).origin === origin && response.request().method() === "PUT") rayWrites.push(response.status())
    })
    restoredBo.on("response", response => {
      if (new URL(response.url()).origin === origin && response.request().method() === "GET") boReads.push(response.status())
    })
    await Promise.all([restoredBo.goto("/"), editor.goto("/")])
    await expect(restoredBo.getByLabel(/^Devices offline/u)).toBeVisible({ timeout: 30_000 })
    await expect(editor.getByLabel(/^Devices offline/u)).toBeVisible({ timeout: 30_000 })
    await expect(editor.getByLabel("Workspace role: editor")).toBeVisible()
    await addLead(editor, "Rusty only after grant retry")
    await expect.poll(() => rayWrites.some(status => status >= 200 && status < 300), { timeout: 45_000 }).toBe(true)
    await restoredBo.getByRole("button", { name: "Sync", exact: true }).click()
    const boRusty = restoredBo.getByRole("region", { name: "Rusty", exact: true })
    await boRusty.getByRole("button", { name: "Sync now", exact: true }).click()
    await expect(restoredBo.getByRole("button", { name: "Open Rusty only after grant retry — Engineer", exact: true }))
      .toBeVisible({ timeout: 45_000 })
    expect(boReads.some(status => status >= 200 && status < 300)).toBe(true)
  } finally {
    await Promise.allSettled([ownerContext.close(), rayContext.close(), coldOwner?.close(), coldRay?.close()])
    await rusty.close()
  }
})
