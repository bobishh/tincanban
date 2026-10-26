import { expect, test, type Page } from "./support/coverage"
import { approveRustyForFixture } from "./support/identityRustyFixture"
import { createJobSearchWorkspace, ensureJobSearchWorkspace } from "./support/workspaces"
import { startRustyService } from "./support/rustyService"

type PublicProfile = { identity: { personId: string }; device: { deviceId: string; publicKey: string } }

async function profile(page: Page): Promise<PublicProfile> {
  return page.evaluate(async () => {
    const raw = await (await import("/src/localDb.ts")).readLocal("tincanban.local_profile.v1")
    if (!raw) throw new Error("Local identity profile was not saved")
    return JSON.parse(raw) as PublicProfile
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
  const boardConnection = panel.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Remove", exact: true }) })
  await expect(boardConnection.getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(panel.getByRole("button", { name: "Sync now", exact: true })).toBeEnabled()
  await page.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Close", exact: true }).click()
  return panel
}

async function addLead(page: Page, company: string) {
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  await page.getByLabel("Company *").fill(company)
  await page.getByLabel("Role *").fill("Engineer")
  await page.getByRole("button", { name: "Create item" }).click()
  await page.getByRole("button", { name: "Close detail" }).click()
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

async function retainLegacyOwnerAccess(ownerPage: Page, participantPage: Page, workspaceId: string) {
  const access = await ownerPage.evaluate(async id => {
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
  await participantPage.evaluate(async ({ id, ownerAccess }) => {
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const { getReplicaConfigurations, setReplicaPreference } = await import("/src/sync/privateReplicaRepository.ts")
    const profile = await bootstrapIdentity()
    const config = (await getReplicaConfigurations(profile.identity.personId))
      .find(value => value.workspaceId === id && value.boardAccess && !value.removalPending)
    if (!config) throw new Error("Joined participant storage config is not ready for the retained-v1 fixture")
    await setReplicaPreference(profile.identity.personId, { ...config, boardAccess: ownerAccess })
  }, { id: workspaceId, ownerAccess: access })
}

for (const storageVersion of [1, 2] as const) {
test(`Given a participant copy and a current owner Identity device with retained v${storageVersion} storage access, when owner reconnect is offered, then wrong identities write nothing and the owner restores the same board`, async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000)
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const initialOwner = await profile(page)
  const rusty = await startRustyService({ identity: initialOwner.identity, allowedControllerDeviceIds: [initialOwner.device.deviceId] }, baseURL!)
  const ownerDeviceContext = await browser.newContext()
  const wrongOwnerContext = await browser.newContext()
  const participantContext = await browser.newContext()
  const ownerDevice = await ownerDeviceContext.newPage()
  const wrongOwner = await wrongOwnerContext.newPage()
  const participant = await participantContext.newPage()
  try {
    // Enroll this current owner Identity device before creating the board to reconnect.
    // It has the active Identity authority but no local copy of that later board.
    await enrollDevice(page, ownerDevice)
    await ownerDevice.goto("about:blank")
    await createJobSearchWorkspace(page, "Original board")
    const originalWorkspaceId = await page.evaluate(async () =>
      (await import("/src/test/stateFixture.ts")).useTincanban().activeWorkspace.id)
    await addLead(page, "Owner restored")
    await connectRusty(page, rusty.origin)

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
    await expect.poll(() => participantReconnectSourceReady(participant, originalWorkspaceId), { timeout: 30_000 }).toBe(true)
    if (storageVersion === 1) {
      await retainLegacyOwnerAccess(page, participant, originalWorkspaceId)
      await expect.poll(() => participantReconnectSourceReady(participant, originalWorkspaceId), { timeout: 30_000 }).toBe(true)
    }
    await join.getByRole("button", { name: "Close", exact: true }).first().click()
    await host.getByRole("button", { name: "Close", exact: true }).first().click()

    await participant.getByRole("button", { name: "Sync", exact: true }).click()
    const participantSync = participant.getByRole("dialog", { name: "Device sync" })
    await participantSync.getByRole("button", { name: "Connect owner device", exact: true }).click()
    const returnLink = await participantSync.getByLabel("Pairing link", { exact: true }).inputValue()

    await wrongOwner.goto("/")
    await ensureJobSearchWorkspace(wrongOwner)
    const wrongOwnerBefore = await localReconnectState(wrongOwner)
    const participantBeforeWrongOwner = await localReconnectState(participant)
    await wrongOwner.goto(returnLink)
    const wrongOwnerSync = wrongOwner.getByRole("dialog", { name: "Device sync" })
    await expect(wrongOwnerSync.getByRole("alert")).toContainText(/owner|Identity/i, { timeout: 30_000 })
    await expect.poll(() => localReconnectState(wrongOwner)).toEqual(wrongOwnerBefore)
    await expect.poll(() => localReconnectState(participant)).toEqual(participantBeforeWrongOwner)

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
      ownerPersonId: restored.currentPersonId, ownerConfigCount: 1 })

    await ownerDevice.reload()
    await expect(ownerDevice.getByRole("region", { name: "Original board", exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(ownerDevice.getByRole("button", { name: "Open Owner restored — Engineer" })).toBeVisible({ timeout: 30_000 })
    await ownerDevice.getByRole("button", { name: "Sync", exact: true }).click()
    await expect(ownerDevice.getByRole("dialog", { name: "Device sync" })
      .locator(".mesh-member.is-selected .mesh-member-role")).toHaveText("owner")

    await participant.getByRole("button", { name: "Sync", exact: true }).click()
    const memberRole = participant.getByRole("dialog", { name: "Device sync" }).locator(".mesh-member.is-selected .mesh-member-role")
    await expect(memberRole).toHaveText("editor")
  } finally {
    await participantContext.close()
    await wrongOwnerContext.close()
    await ownerDeviceContext.close()
    await rusty.close()
  }
})
}
