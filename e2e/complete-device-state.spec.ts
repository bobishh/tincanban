import { expect, test, type Page } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"
import { startRustyService } from "./support/rustyService"

type PublicProfile = { identity: { personId: string }; device: { deviceId: string; publicKey: string; displayName: string } }

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
  await join.getByRole("button", { name: "Close", exact: true }).click()
  await host.getByRole("button", { name: "Close", exact: true }).click()
}

async function connectRusty(page: Page, origin: string) {
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  await page.getByRole("tab", { name: "Rusty", exact: true }).click()
  const panel = page.getByRole("region", { name: "Rusty", exact: true })
  await panel.getByRole("button", { name: "Add Rusty", exact: true }).click()
  await panel.getByLabel("Address", { exact: true }).fill(origin)
  await panel.getByRole("button", { name: "Connect", exact: true }).click()
  const boardConnection = panel.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Remove", exact: true }) })
  await expect(boardConnection.getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(panel.getByRole("button", { name: "Sync now", exact: true })).toBeEnabled()
  return panel
}

test("Given an enrolled device without Rusty, when its peer connects and synchronizes, then it receives private credentials but keeps local progress", async ({ page, playwright, baseURL }) => {
  test.setTimeout(120_000)
  const browser = await (process.platform === "darwin" ? playwright.webkit : playwright.chromium).launch()
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const phone = await context.newPage()
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const hostProfile = await profile(page)
  const rusty = await startRustyService({ identity: hostProfile.identity, allowedControllerDeviceIds: [hostProfile.device.deviceId] }, baseURL!)
  try {
    await enrollDevice(page, phone)
    await phone.goto("about:blank")
    const hostPanel = await connectRusty(page, rusty.origin)
    const issuedCapability = await page.evaluate(async origin => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { getReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
      const { updateRustyManagementPolicy } = await import("/src/sync/rustyManagementClient.ts")
      const { RustyManagementRepository } = await import("/src/sync/rustyManagementRepository.ts")
      const profile = await bootstrapIdentity()
      const config = (await getReplicaConfigurations(profile.identity.personId)).find(value => value.origin === origin)
      if (!config) throw new Error("Rusty connection missing after successful enrollment")
      const binding = { origin, servicePublicKey: config.servicePublicKey, resourceKind: "scope" as const, resourceId: config.scopeId }
      await updateRustyManagementPolicy(binding, profile, { operations: ["management.update", "scope.policy"], revokedDeviceIds: [] })
      return (await new RustyManagementRepository(profile.identity.personId).read(binding))?.capability
    }, rusty.origin)
    expect(issuedCapability).toBeTruthy()
    const hostState = await page.evaluate(async origin => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { getReplicaConfigurations, getPrivateReplicaProgress } = await import("/src/sync/privateReplicaRepository.ts")
      const profile = await bootstrapIdentity()
      const config = (await getReplicaConfigurations(profile.identity.personId)).find(value => value.origin === origin)!
      const progress = await getPrivateReplicaProgress(profile.identity.personId, config)
      return { cursor: progress.cursor, lastUploaded: progress.lastUploaded, scopeId: config.scopeId, servicePublicKey: config.servicePublicKey }
    }, rusty.origin)
    expect(hostState.lastUploaded).not.toBe("")
    // Hold the recipient's Rusty traffic so only the transferred portable configuration is observed.
    await phone.route(`${rusty.origin}/**`, route => route.abort())
    await phone.goto(baseURL!)
    await phone.getByRole("button", { name: "Menu", exact: true }).click()
    await phone.getByRole("button", { name: "Sync & backups", exact: true }).click()
    await expect.poll(() => phone.evaluate(async origin => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { getReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
      const profile = await bootstrapIdentity()
      return (await getReplicaConfigurations(profile.identity.personId)).some(value => value.origin === origin)
    }, rusty.origin)).toBe(true)
    const received = await phone.evaluate(async ({ origin, scopeId, servicePublicKey }) => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { getReplicaConfigurations, getPrivateReplicaProgress } = await import("/src/sync/privateReplicaRepository.ts")
      const { RustyManagementRepository } = await import("/src/sync/rustyManagementRepository.ts")
      const profile = await bootstrapIdentity()
      const configs = await getReplicaConfigurations(profile.identity.personId)
      const config = configs.find(value => value.origin === origin)
      if (!config) return { count: configs.length, hasConfig: false }
      const progress = await getPrivateReplicaProgress(profile.identity.personId, config)
      const capability = await new RustyManagementRepository(profile.identity.personId).read({ origin, servicePublicKey,
        resourceKind: "scope", resourceId: scopeId })
      return { count: configs.length, hasConfig: true, hasPrivateCredentials: Boolean(config.readToken && config.writeToken && config.contentKey),
        cursor: progress.cursor, lastUploaded: progress.lastUploaded, capability: capability?.capability }
    }, { origin: rusty.origin, scopeId: hostState.scopeId, servicePublicKey: hostState.servicePublicKey })
    expect(received.count).toBe(1)
    expect(received).toMatchObject({ hasConfig: true, hasPrivateCredentials: true, cursor: 0, lastUploaded: "" })
    expect(received.capability).toEqual(issuedCapability)
    await expect(hostPanel.getByRole("button", { name: "Sync now", exact: true })).toBeEnabled()
  } finally {
    await context.close(); await browser.close(); await rusty.close()
  }
})

test("Given an acknowledged profile photo update, when the source closes and the enrolled device cold-starts, then the latest saved photo wins", async ({ page, playwright, baseURL }) => {
  test.setTimeout(120_000)
  const mobileBrowser = await (process.platform === "darwin" ? playwright.webkit : playwright.chromium).launch()
  const context = await mobileBrowser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const phone = await context.newPage()
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const hostProfile = await profile(page)
  const rusty = await startRustyService({ identity: hostProfile.identity, allowedControllerDeviceIds: [hostProfile.device.deviceId] }, baseURL!)
  try {
    await enrollDevice(page, phone)
    await phone.goto("about:blank")
    const panel = await connectRusty(page, rusty.origin)
    // Receive the private connection while its source is still online, then
    // isolate the phone before the new photo exists so the cold read uses Rusty.
    await phone.goto(baseURL!)
    await expect.poll(() => phone.evaluate(async origin => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { getReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
      const current = await bootstrapIdentity()
      return (await getReplicaConfigurations(current.identity.personId)).some(config => config.origin === origin)
    }, rusty.origin), { timeout: 30_000 }).toBe(true)
    await phone.goto("about:blank")
    await page.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Close", exact: true }).click()
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await page.getByLabel("Name", { exact: true }).fill("Latest owner profile")
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 128
      const context = canvas.getContext("2d")!
      context.fillStyle = "#7c3aed"; context.fillRect(0, 0, 128, 128)
      return canvas.toDataURL("image/png").split(",")[1]!
    })
    await page.getByLabel("Choose photo").setInputFiles({ name: "profile.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") })
    await page.getByRole("dialog", { name: "Crop profile photo" }).getByRole("button", { name: "Use photo", exact: true }).click()
    await page.getByRole("button", { name: "Save profile", exact: true }).click()
    await expect(page.getByRole("status").filter({ hasText: "Profile saved." })).toBeVisible()
    const latestSource = await page.getByRole("img", { name: "Your profile photo" }).getAttribute("src")
    await page.getByRole("button", { name: "Dismiss", exact: true }).click()
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    await page.getByRole("tab", { name: "Rusty", exact: true }).click()
    await panel.getByRole("button", { name: "Sync now", exact: true }).click()
    await expect(panel.getByRole("button", { name: "Sync now", exact: true })).toBeEnabled()
    await page.goto("about:blank")
    await phone.goto(baseURL!)
    await phone.getByRole("button", { name: "Menu", exact: true }).click()
    await phone.getByRole("button", { name: "Sync & backups", exact: true }).click()
    await expect(phone.locator(".mesh-member .participant-avatar-photo")).toHaveAttribute("src", latestSource!, { timeout: 30_000 })
    const saved = await phone.evaluate(async () => {
      const { defaultStorage } = await import("/src/storage.ts")
      return await defaultStorage.loadPersonalRoot()
    })
    expect(saved?.photo?.avatarData).toBe(latestSource)
    expect(saved?.identity.displayName).toBe("Latest owner profile")
  } finally { await context.close(); await mobileBrowser.close(); await rusty.close() }
})

test("Given an older recipient receives an owner-signed approval with an unknown required component, when enrollment preflights and installs, then upgrade is required and saved identity stays intact", async ({ page, browser }) => {
  test.setTimeout(120_000)
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const recipientContext = await browser.newContext()
  const recipient = await recipientContext.newPage()
  try {
    await recipient.goto("/")
    await ensureJobSearchWorkspace(recipient)
    const recipientProfile = await profile(recipient)
    const approval = await page.evaluate(async target => {
      const { bootstrapIdentity, signEnvelope, toBase64Url } = await import("/src/domain/identity.ts")
      const { createDeviceEnrollmentInvite } = await import("/vendor/meta-mesh/packages/mesh-pairing/src/index.ts")
      const { InvitationService } = await import("/src/sync/invitations.ts")
      const { enrollmentPayload } = await import("/src/sync/enrollment.ts")
      const { defaultStorage } = await import("/src/storage.ts")
      const { useTincanban } = await import("/src/state.ts")
      const owner = await bootstrapIdentity()
      const invite = createDeviceEnrollmentInvite("fixture-enrollment-endpoint", "fixture-enrollment-secret", owner)
      const invitations = new InvitationService()
      await invitations.saveIssuedInvitation(invite)
      const claim = await invitations.claimInvitation(invite.invitationId, target.device.deviceId)
      if (!claim.ok) throw new Error(claim.error)
      const approved = await invitations.approveEnrollment(invite.invitationId, target.device, owner)
      if (!approved.ok) throw new Error(approved.error)
      const root = await defaultStorage.loadPersonalRoot()
      if (!root) throw new Error("Owner personal root unavailable")
      const workspaceId = useTincanban().activeWorkspace.id
      const workspaces = [{ id: workspaceId, title: "Enrollment fixture" }]
      const meshWorkspaces = [{ version: 1, workspaceId, ownerPersonId: owner.identity.personId,
        ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate],
        transportSecret: "A".repeat(43), epoch: 1, peers: [] }]
      const signed = await enrollmentPayload(invite, owner, approved.certificate, root, workspaces, workspaceId,
        meshWorkspaces, [], new TextEncoder().encode("[]"))
      const raw = JSON.parse(new TextDecoder().decode(signed))
      raw.payload.deviceState.components.futureRequired = { schema: "future-required@2", required: true,
        value: { personId: owner.identity.personId } }
      const resigned = await signEnvelope(owner.privateKeys.devicePrivateKey, raw.payload, owner.device.deviceId)
      return { invite, bytes: toBase64Url(new TextEncoder().encode(JSON.stringify(resigned))) }
    }, recipientProfile)
    const before = await recipient.evaluate(async () => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { useTincanban } = await import("/src/state.ts")
      const current = await bootstrapIdentity()
      return { personId: current.identity.personId, deviceId: current.device.deviceId,
        profile: await (await import("/src/localDb.ts")).readLocal("tincanban.local_profile.v1"),
        workspaceId: useTincanban().activeWorkspace.id }
    })
    const outcome = await recipient.evaluate(async ({ invite, bytes }) => {
      const { fromBase64Url } = await import("/src/domain/identity.ts")
      const { preflightEnrollment, installEnrollment } = await import("/src/sync/enrollment.ts")
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const profile = await bootstrapIdentity()
      const encoded = fromBase64Url(bytes)
      const errors: string[] = []
      for (const enroll of [preflightEnrollment, installEnrollment]) {
        try { await enroll(encoded, invite, profile, profile.identity.personId) }
        catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
      }
      const { useTincanban } = await import("/src/state.ts")
      return { errors, profile: await (await import("/src/localDb.ts")).readLocal("tincanban.local_profile.v1"),
        workspaceId: useTincanban().activeWorkspace.id }
    }, approval)
    expect(outcome.errors).toHaveLength(2)
    expect(outcome.errors.every(message => /required component future-required@2/i.test(message))).toBe(true)
    expect(outcome.profile).toBe(before.profile)
    expect(outcome.workspaceId).toBe(before.workspaceId)
    expect(before.personId).toBe(recipientProfile.identity.personId)
    expect(before.deviceId).toBe(recipientProfile.device.deviceId)
    await expect(recipient.getByLabel("Workspace role: owner")).toBeVisible()
  } finally { await recipientContext.close() }
})

test("Given another person is invited to the owner's board, when workspace state synchronizes, then owner's private Rusty configuration stays private", async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000)
  const guestContext = await browser.newContext()
  const guest = await guestContext.newPage()
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const owner = await profile(page)
  const rusty = await startRustyService({ identity: owner.identity, allowedControllerDeviceIds: [owner.device.deviceId] }, baseURL!)
  try {
    await connectRusty(page, rusty.origin)
    await page.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Close", exact: true }).click()
    await guest.goto("/")
    await ensureJobSearchWorkspace(guest)
    const guestBefore = await profile(guest)
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const host = page.getByRole("dialog", { name: "Device sync" })
    await host.getByRole("button", { name: "Add someone", exact: true }).click()
    await host.getByRole("button", { name: "Generate link", exact: true }).click()
    await guest.goto(await host.getByLabel("Pairing link").inputValue())
    const invitation = guest.getByRole("dialog", { name: "Device sync" })
    await invitation.getByRole("button", { name: "Accept and join", exact: true }).click()
    await host.getByRole("button", { name: "Approve access", exact: true }).click()
    await expect(invitation.getByText(/Connected to/)).toBeVisible({ timeout: 30_000 })
    const configCount = await guest.evaluate(async personId =>
      (await import("/src/sync/privateReplicaRepository.ts")).getReplicaConfigurations(personId).then(configs => configs.length),
    guestBefore.identity.personId)
    expect(configCount).toBe(0)
    expect((await profile(guest)).identity.personId).toBe(guestBefore.identity.personId)
    const ownerConfigs = await page.evaluate(async personId =>
      (await import("/src/sync/privateReplicaRepository.ts")).getReplicaConfigurations(personId), owner.identity.personId)
    expect(ownerConfigs.some(config => config.origin === rusty.origin)).toBe(true)
  } finally { await guestContext.close(); await rusty.close() }
})
