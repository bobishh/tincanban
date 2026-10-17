import { expect, test } from "./support/coverage"

const photoData = "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA"

async function seedProfileConflicts(page: import("@playwright/test").Page) {
  await page.goto("/")
  return page.evaluate(async fixturePhoto => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const { createPersonalRoot } = await import("/src/domain/personalRoot.ts")
    const { defaultStorage } = await import("/src/storage.ts")
    const { rootIdentityProfileState } = await import("/src/domain/identityProfileRoot.ts")
    const { observeLegacyIdentityProfile } = await import("/src/domain/identityProfileState.ts")
    const { identityProfileRevision } = await import("/src/domain/identityProfileRevision.ts")
    const { identityDevicePreferencesChanged } = await import("/src/sync/identityDevicePreferenceEvents.ts")
    const app = useTincanban()
    await app.whenReady()
    const profile = await bootstrapIdentity()
    let root = await defaultStorage.loadPersonalRoot()
    if (!root) {
      root = createPersonalRoot(profile, "e2e-certificate-hash")
      await defaultStorage.savePersonalRoot(root)
    }
    root.photo = { avatarData: fixturePhoto, changedAt: "2024-01-01T00:00:00.000Z" }
    let state = await rootIdentityProfileState(root)
    state = await observeLegacyIdentityProfile(state, root.identity, "name", root.identity.displayName)
    state = await observeLegacyIdentityProfile(state, root.identity, "name", "Conflict Candidate")
    state = await observeLegacyIdentityProfile(state, root.identity, "photo", root.photo)
    state = await observeLegacyIdentityProfile(state, root.identity, "photo", { avatarData: null, changedAt: "2024-02-01T00:00:00.000Z" })
    await defaultStorage.updatePersonalRootForIdentity(profile.identity.personId, current => {
      if (!current) throw new Error("Personal root disappeared while seeding profile conflict")
      current.photo = root!.photo
      current.profileState = state
      return current
    })
    identityDevicePreferencesChanged(profile.identity.personId)
    return { personId: profile.identity.personId, originalName: root.identity.displayName,
      profileRevision: await identityProfileRevision(state) }
  }, photoData)
}

async function openIdentitySettings(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await settings.getByRole("tab", { name: "Identity", exact: true }).click()
  return settings
}

test("Given legacy name and photo conflicts, when selecting candidates and saving, then retain signed resolutions and legacy history", async ({ page }) => {
  const fixture = await seedProfileConflicts(page)
  const settings = await openIdentitySettings(page)
  const names = settings.getByRole("group", { name: "Identity name choices" })
  const photos = settings.getByRole("group", { name: "Identity photo choices" })

  await expect(settings.getByText("Choose which name and photo to keep.")).toBeVisible()
  await expect(names.getByRole("button", { name: `Choose name: ${fixture.originalName}`, exact: true })).toBeVisible()
  await expect(names.getByRole("button", { name: "Choose name: Conflict Candidate", exact: true })).toBeVisible()
  await expect(photos.getByRole("button")).toHaveCount(2)
  await expect(photos.getByRole("img", { name: "Profile photo option" })).toBeVisible()
  await expect(photos.getByRole("button", { name: "Choose photo: No photo", exact: true })).toBeVisible()

  // Name equals current label. Explicit selection must still resolve its conflict through combined save.
  await names.getByRole("button", { name: `Choose name: ${fixture.originalName}`, exact: true }).click()
  await photos.getByRole("button", { name: "Choose photo: No photo", exact: true }).click()
  await settings.getByRole("button", { name: "Save profile", exact: true }).click()
  await expect(settings.locator(".identity-profile-actions").getByRole("status").filter({ hasText: "Profile saved." })).toBeVisible()

  const resolved = await page.evaluate(async personId => {
    const { defaultStorage } = await import("/src/storage.ts")
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const { identityProfileValue, readIdentityProfileState } = await import("/src/domain/identityProfileState.ts")
    const root = await defaultStorage.loadPersonalRoot()
    if (!root?.profileState) throw new Error("Signed profile history is missing")
    if (root.identity.personId !== personId) throw new Error("Personal root changed identity")
    const state = await readIdentityProfileState(root.profileState, root.identity)
    return {
      name: identityProfileValue(state, "name"),
      photo: identityProfileValue(state, "photo"),
      legacyNames: state.legacy.filter(value => value.field === "name").map(value => value.value),
      legacyPhotos: state.legacy.filter(value => value.field === "photo").map(value => value.value),
      operations: state.operations.length,
      localName: (await bootstrapIdentity()).identity.displayName,
      rootName: root.identity.displayName,
      personId: root.identity.personId,
    }
  }, fixture.personId)

  expect(resolved.personId).toBe(fixture.personId)
  expect(resolved.name).toEqual({ status: "value", values: [fixture.originalName] })
  expect(resolved.photo).toMatchObject({ status: "value", values: [{ avatarData: null }] })
  expect(resolved.operations).toBeGreaterThanOrEqual(2)
  expect(resolved.legacyNames).toContain("Conflict Candidate")
  expect(resolved.legacyPhotos).toEqual(expect.arrayContaining([
    { avatarData: photoData, changedAt: "2024-01-01T00:00:00.000Z" },
    { avatarData: null, changedAt: "2024-02-01T00:00:00.000Z" },
  ]))
  expect(resolved.localName).toBe(fixture.originalName)
  expect(resolved.rootName).toBe(fixture.originalName)
})

test("Given conflict drafts and a concurrent profile revision, when combined save is rejected, then preserve both drafts", async ({ page }) => {
  const fixture = await seedProfileConflicts(page)
  const settings = await openIdentitySettings(page)
  const names = settings.getByRole("group", { name: "Identity name choices" })
  const photos = settings.getByRole("group", { name: "Identity photo choices" })
  await names.getByRole("button", { name: "Choose name: Conflict Candidate", exact: true }).click()
  await photos.getByRole("button", { name: "Choose photo: No photo", exact: true }).click()

  // Advance durable signed state without its preference event; the mounted form retains its captured revision.
  await page.evaluate(async personId => {
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const { editIdentityProfileRoot } = await import("/src/domain/identityProfileRoot.ts")
    const { defaultStorage } = await import("/src/storage.ts")
    const profile = await bootstrapIdentity()
    await defaultStorage.updatePersonalRootForIdentity(personId, async root => {
      if (!root) throw new Error("Personal root disappeared")
      return editIdentityProfileRoot(root, profile, "name", "Concurrent revision")
    })
  }, fixture.personId)

  await settings.getByRole("button", { name: "Save profile", exact: true }).click()
  await expect(settings.getByRole("alert")).toBeVisible()
  await expect(names.getByRole("button", { name: "Choose name: Conflict Candidate", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(photos.getByRole("button", { name: "Choose photo: No photo", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(settings.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Conflict Candidate")
})

test("Given edited profile choices and a notified signed revision, when save uses the captured revision, then reject and preserve drafts", async ({ page }) => {
  const fixture = await seedProfileConflicts(page)
  const settings = await openIdentitySettings(page)
  const names = settings.getByRole("group", { name: "Identity name choices" })
  const photos = settings.getByRole("group", { name: "Identity photo choices" })
  await names.getByRole("button", { name: "Choose name: Conflict Candidate", exact: true }).click()
  await photos.getByRole("button", { name: "Choose photo: No photo", exact: true }).click()

  const latestRevision = await page.evaluate(async personId => {
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const { editIdentityProfileRoot } = await import("/src/domain/identityProfileRoot.ts")
    const { observeLegacyIdentityProfile } = await import("/src/domain/identityProfileState.ts")
    const { identityProfileRevision } = await import("/src/domain/identityProfileRevision.ts")
    const { defaultStorage } = await import("/src/storage.ts")
    const { identityDevicePreferencesChanged } = await import("/src/sync/identityDevicePreferenceEvents.ts")
    const profile = await bootstrapIdentity()
    await defaultStorage.updatePersonalRootForIdentity(personId, async root => {
      if (!root?.profileState) throw new Error("Personal profile state disappeared")
      const next = await editIdentityProfileRoot(root, profile, "name", "Concurrent revision")
      next.profileState = await observeLegacyIdentityProfile(next.profileState!, next.identity, "name", "Latest imported name")
      return next
    })
    identityDevicePreferencesChanged(personId)
    const root = await defaultStorage.loadPersonalRoot()
    if (!root?.profileState) throw new Error("Concurrent profile revision was not saved")
    return identityProfileRevision(root.profileState)
  }, fixture.personId)
  expect(latestRevision).not.toBe(fixture.profileRevision)
  await expect(names.getByRole("button", { name: "Choose name: Latest imported name", exact: true })).toBeVisible()

  await settings.getByRole("button", { name: "Save profile", exact: true }).click()
  await expect(settings.getByRole("alert")).toBeVisible()
  await expect(settings.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Conflict Candidate")
  await expect(photos.getByRole("button", { name: "Choose photo: No photo", exact: true })).toHaveAttribute("aria-pressed", "true")
})

test("Given private profile revision loading, when Identity settings opens, then keep editing and saving disabled until loaded", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Sync", exact: true })).toBeEnabled({ timeout: 15_000 })
  const personId = await page.evaluate(async () => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    const { defaultStorage } = await import("/src/storage.ts")
    const { identityDevicePreferencesChanged } = await import("/src/sync/identityDevicePreferenceEvents.ts")
    await useTincanban().whenReady()
    const root = await defaultStorage.loadPersonalRoot()
    if (!root) throw new Error("Expected startup to initialize a personal root")
    const id = root.identity.personId
    const original = defaultStorage.loadPersonalRoot.bind(defaultStorage)
    ;(window as Window & { __PROFILE_ROOT_ORIGINAL__?: typeof original }).__PROFILE_ROOT_ORIGINAL__ = original
    defaultStorage.loadPersonalRoot = async () => null
    identityDevicePreferencesChanged(id)
    return id
  })
  const settings = await openIdentitySettings(page)
  await expect(settings.getByRole("status").filter({ hasText: "Loading saved profile…" })).toBeVisible()

  await page.evaluate(async owner => {
    const { defaultStorage } = await import("/src/storage.ts")
    const { identityDevicePreferencesChanged } = await import("/src/sync/identityDevicePreferenceEvents.ts")
    const windowState = window as Window & {
      __PROFILE_ROOT_ORIGINAL__?: typeof defaultStorage.loadPersonalRoot
      __PROFILE_ROOT_GATE__?: { started: () => void; release: () => void }
    }
    const original = windowState.__PROFILE_ROOT_ORIGINAL__
    if (!original) throw new Error("Expected original profile reader")
    let signalStarted!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { signalStarted = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    windowState.__PROFILE_ROOT_GATE__ = { started: signalStarted, release }
    defaultStorage.loadPersonalRoot = async (...args: Parameters<typeof original>) => {
      signalStarted()
      await held
      return original(...args)
    }
    identityDevicePreferencesChanged(owner)
    await started
  }, personId)

  const name = settings.getByRole("textbox", { name: "Name", exact: true })
  const photo = settings.locator("#identity-avatar-file")
  const save = settings.getByRole("button", { name: "Save profile", exact: true })
  await expect(name).toBeDisabled()
  await expect(photo).toBeDisabled()
  await expect(save).toBeDisabled()
  await expect(settings.getByRole("status").filter({ hasText: "Loading saved profile…" })).toBeVisible()

  await page.evaluate(async () => {
    const { defaultStorage } = await import("/src/storage.ts")
    const windowState = window as Window & {
      __PROFILE_ROOT_ORIGINAL__?: typeof defaultStorage.loadPersonalRoot
      __PROFILE_ROOT_GATE__?: { release: () => void }
    }
    windowState.__PROFILE_ROOT_GATE__?.release()
    if (windowState.__PROFILE_ROOT_ORIGINAL__) defaultStorage.loadPersonalRoot = windowState.__PROFILE_ROOT_ORIGINAL__
  })
  await expect(name).toBeEnabled()
  await expect(photo).toBeEnabled()
  await expect(save).toBeEnabled()
})
