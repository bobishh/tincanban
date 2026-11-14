import { describe, expect, it } from "vitest"
import { writeLocal } from "../localDb"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { defaultStorage } from "../storage"
import { mayOfferFutureKeeperWorkspace, ownerKeepers, rememberActivatedKeeper, removeOwnerKeeper, saveOwnerKeeper } from "./ownerKeeper"

async function installCanonicalKeeperRefs(references: Array<{ integrationId: string; personId: string; revision: number }>) {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Keeper cache test")
  const root = createPersonalRoot(profile, "keeper-cache-test")
  root.keeperIntegrations = Object.fromEntries(references.map(({ integrationId, personId, revision }) => [integrationId, {
    integrationId,
    serviceOrigin: "https://keeper.example",
    servicePersonId: personId,
    serviceDeviceId: "keeper-device",
    servicePublicKey: "keeper-key",
    serviceCertificates: [],
    workspaceIds: ["board"],
    futureBoards: false,
    revision,
    state: "active" as const,
    verifiedAt: new Date().toISOString(),
  }]))
  await defaultStorage.savePersonalRoot(root)
  return profile.identity.personId
}

describe("identity-scoped owner-keeper policy", () => {
  it("reconciles repeated activation receipts without downgrading an existing editor", async () => {
    const owner = `owner-${crypto.randomUUID()}`
    const details = { origin: "https://keeper.example", boardIds: ["board"], futureBoards: true }
    await saveOwnerKeeper(owner, { personId: "keeper", role: "editor" })
    await rememberActivatedKeeper(owner, "keeper", details)
    await rememberActivatedKeeper(owner, "keeper", details)
    await expect(ownerKeepers(owner)).resolves.toEqual([{ personId: "keeper", role: "editor", details }])
    await rememberActivatedKeeper(owner, "new-keeper", details)
    await expect(ownerKeepers(owner)).resolves.toContainEqual({ personId: "new-keeper", role: "editor", details })
  })
  it("reloads policy for its owner identity and updates one keeper idempotently", async () => {
    const owner = `owner-${crypto.randomUUID()}`
    const otherOwner = `owner-${crypto.randomUUID()}`
    const keeper = `keeper-${crypto.randomUUID()}`
    await saveOwnerKeeper(owner, { personId: keeper, role: "visitor" })
    await saveOwnerKeeper(owner, { personId: keeper, role: "editor" })

    await expect(ownerKeepers(owner)).resolves.toEqual([{ personId: keeper, role: "editor" }])
    await expect(ownerKeepers(otherOwner)).resolves.toEqual([])
  })

  it("ignores malformed local policy records", async () => {
    const owner = `owner-${crypto.randomUUID()}`
    await writeLocal(`tincanban.owner-keepers.v1:${owner}`, '[null,{"personId":"keeper","role":"owner"}]')

    await expect(ownerKeepers(owner)).resolves.toEqual([])
    await writeLocal(`tincanban.owner-keepers.v1:${owner}`, "not-json")
    await expect(ownerKeepers(owner)).resolves.toEqual([])
  })

  it("retains pairing details when future-board enrollment updates the role", async () => {
    const owner = `owner-${crypto.randomUUID()}`
    const details = { origin: "https://keeper.example", boardIds: ["board"], futureBoards: true,
      futureBoardBaselineIds: ["board", "existing-unselected"] }
    await saveOwnerKeeper(owner, { personId: "keeper", role: "visitor", details })
    await saveOwnerKeeper(owner, { personId: "keeper", role: "editor" })
    await expect(ownerKeepers(owner)).resolves.toEqual([{ personId: "keeper", role: "editor", details }])
  })

  it("offers only scopes created after the approved baseline when future boards are enabled", () => {
    const baseline = { boardIds: ["selected"], futureBoards: true, futureBoardBaselineIds: ["selected", "existing-unselected"] }
    expect(mayOfferFutureKeeperWorkspace(baseline, "existing-unselected")).toBe(false)
    expect(mayOfferFutureKeeperWorkspace(baseline, "created-after-approval")).toBe(true)
    expect(mayOfferFutureKeeperWorkspace({ ...baseline, futureBoards: false }, "created-after-approval")).toBe(false)
    expect(mayOfferFutureKeeperWorkspace({ boardIds: ["selected"], futureBoards: true }, "created-after-approval")).toBe(false)
  })

  it("removes one keeper only for its owner", async () => {
    const owner = `owner-${crypto.randomUUID()}`
    const otherOwner = `owner-${crypto.randomUUID()}`
    await saveOwnerKeeper(owner, { personId: "old", role: "visitor" })
    await saveOwnerKeeper(owner, { personId: "current", role: "editor" })
    await saveOwnerKeeper(otherOwner, { personId: "old", role: "visitor" })
    await removeOwnerKeeper(owner, "old")
    await expect(ownerKeepers(owner)).resolves.toEqual([{ personId: "current", role: "editor" }])
    await expect(ownerKeepers(otherOwner)).resolves.toEqual([{ personId: "old", role: "visitor" }])
  })

  it("serializes concurrent keeper additions and removal on the owner cache key", async () => {
    const owner = `owner-${crypto.randomUUID()}`
    const first = `keeper-${crypto.randomUUID()}`
    const second = `keeper-${crypto.randomUUID()}`
    const third = `keeper-${crypto.randomUUID()}`

    await Promise.all([
      saveOwnerKeeper(owner, { personId: first, role: "editor" }),
      saveOwnerKeeper(owner, { personId: second, role: "visitor" }),
    ])
    await Promise.all([
      removeOwnerKeeper(owner, first),
      saveOwnerKeeper(owner, { personId: third, role: "editor" }),
    ])

    await expect(ownerKeepers(owner)).resolves.toEqual([
      { personId: second, role: "visitor" },
      { personId: third, role: "editor" },
    ])
  })

  it("preserves a newer same-integration cache row from stale activation and removal receipts", async () => {
    const keeper = `keeper-${crypto.randomUUID()}`
    const owner = await installCanonicalKeeperRefs([{ integrationId: "integration", personId: keeper, revision: 3 }])
    const current = { integrationId: "integration", revision: 3, boardIds: ["new-board"], futureBoards: true }
    await saveOwnerKeeper(owner, { personId: keeper, role: "editor", details: current })

    await expect(saveOwnerKeeper(owner, { personId: keeper, role: "editor", details: {
      ...current, revision: 2, boardIds: ["old-board"],
    } })).rejects.toThrow("An earlier keeper cache write")
    await removeOwnerKeeper(owner, keeper, { integrationId: "integration", throughRevision: 2 })

    await expect(ownerKeepers(owner)).resolves.toEqual([{ personId: keeper, role: "editor", details: current }])
    await removeOwnerKeeper(owner, keeper, { integrationId: "integration", throughRevision: 4 })
    await expect(ownerKeepers(owner)).resolves.toEqual([])
  })

  it("clears equal-revision and legacy cache rows after a verified terminal receipt", async () => {
    const equalRevision = `keeper-${crypto.randomUUID()}`
    const legacy = `keeper-${crypto.randomUUID()}`
    const owner = await installCanonicalKeeperRefs([
      { integrationId: "integration", personId: equalRevision, revision: 4 },
      { integrationId: "legacy-integration", personId: legacy, revision: 4 },
    ])
    await saveOwnerKeeper(owner, { personId: equalRevision, role: "editor", details: {
      integrationId: "integration", revision: 4, boardIds: ["board"], futureBoards: false,
    } })
    const saved = await ownerKeepers(owner)
    await writeLocal(`tincanban.owner-keepers.v1:${owner}`, JSON.stringify([
      ...saved,
      { personId: legacy, role: "editor", details: { integrationId: "legacy-integration", boardIds: ["board"], futureBoards: false } },
    ]))

    await Promise.all([
      removeOwnerKeeper(owner, equalRevision, { integrationId: "integration", throughRevision: 4 }),
      removeOwnerKeeper(owner, legacy, { integrationId: "legacy-integration", throughRevision: 4 }),
    ])

    await expect(ownerKeepers(owner)).resolves.toEqual([])
  })
})
