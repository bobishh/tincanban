import { IDBFactory } from "fake-indexeddb"
import { afterEach, expect, it, vi } from "vitest"
import type { BlindReplicaConfig } from "./blindReplication"
import type { AttachmentLocator } from "../product-replica"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function fixture() {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.resetModules()
  const local = await import("../localDb")
  const { privateReplicaBinding } = await import("./privateReplicaRepository")
  const { createAttachmentIndexRepository } = await import("./attachmentIndexRepository")
  const { createWorkspaceAttachmentIndex, attachmentIndexBinding, planWorkspaceAttachmentIndexMigration } = await import("./attachmentIndexScope")
  const token = "A".repeat(43)
  const config: BlindReplicaConfig = { workspaceId: "board", scopeId: "scope", origin: "https://rusty.example",
    readToken: token, writeToken: token, servicePublicKey: token, contentKey: token, policyRevision: 1,
    keyEpoch: 1, cursor: 0, lastUploaded: "", preferenceRevision: "device:1" }
  const owner = "person-owner"
  const locator: AttachmentLocator = { version: 1, blobId: `sha256:${token}`, transferId: "transfer", manifestId: "B".repeat(43) }
  const legacy = createAttachmentIndexRepository(privateReplicaBinding(owner, config), () => {})
  await legacy.merge([locator])
  const sourceKey = (await local.listLocalKeys()).find(key => key.startsWith("tincanban.attachment-index.v1."))!
  const sourceRaw = await local.readLocal(sourceKey)
  return { local, createAttachmentIndexRepository, createWorkspaceAttachmentIndex, attachmentIndexBinding,
    planWorkspaceAttachmentIndexMigration, config, owner, locator, legacy, sourceKey, sourceRaw }
}

it("Given an existing private index, when its connection policy/tokens/preferences change, then preserve discovery without changing old records", async () => {
  const f = await fixture()
  const first = f.createWorkspaceAttachmentIndex(f.owner, f.config, () => {})
  expect(await first.read()).toEqual([f.locator])
  const changed: BlindReplicaConfig = { ...f.config, readToken: "C".repeat(43), writeToken: "D".repeat(43),
    policyRevision: 2, preferenceRevision: "device:2", minimumWriterVersion: 2 }
  const reopened = f.createWorkspaceAttachmentIndex(f.owner, changed, () => {})
  expect(await reopened.read()).toEqual([f.locator])
  expect(f.attachmentIndexBinding(f.owner, changed)).toBe(f.attachmentIndexBinding(f.owner, f.config))
  expect(await f.local.readLocal(f.sourceKey)).toBe(f.sourceRaw)
})

it.each(["owner", "workspace", "scope", "origin", "service", "epoch", "key"] as const)(
  "Given a changed %s encryption context, then do not inherit another index", async field => {
    const f = await fixture()
    await f.createWorkspaceAttachmentIndex(f.owner, f.config, () => {}).read()
    const owner = field === "owner" ? "other-owner" : f.owner
    const changes: Record<typeof field, Partial<BlindReplicaConfig>> = {
      owner: {}, workspace: { workspaceId: "other-board" }, scope: { scopeId: "other-scope" },
      origin: { origin: "https://other.example" }, service: { servicePublicKey: `${"C".repeat(42)}A` },
      epoch: { keyEpoch: 2 }, key: { contentKey: `${"D".repeat(42)}A` },
    }
    const index = f.createWorkspaceAttachmentIndex(owner, { ...f.config, ...changes[field] }, () => {})
    expect(await index.read()).toEqual([])
    expect(await f.local.readLocal(f.sourceKey)).toBe(f.sourceRaw)
  },
)

it("Given a legacy writer adds another locator after migration, then preserve and import that later addition", async () => {
  const f = await fixture()
  const current = f.createWorkspaceAttachmentIndex(f.owner, f.config, () => {})
  expect(await current.read()).toEqual([f.locator])
  const later: AttachmentLocator = { ...f.locator, transferId: "later", manifestId: "C".repeat(43) }
  await f.legacy.merge([later])
  expect(await current.read()).toEqual(expect.arrayContaining([f.locator, later]))
  expect(await current.read()).toHaveLength(2)
})

it("Given retained old encryption keys after rotation, when opening discovery, then union old epoch indices without modifying their original records", async () => {
  const f = await fixture()
  await f.createWorkspaceAttachmentIndex(f.owner, f.config, () => {}).read()
  const changed: BlindReplicaConfig = { ...f.config, keyEpoch: 2, contentKey: `${"C".repeat(42)}A`,
    historicalContentKeys: { "1": f.config.contentKey }, policyRevision: 2, preferenceRevision: "device:2" }
  const rotated = f.createWorkspaceAttachmentIndex(f.owner, changed, () => {})
  expect(await rotated.read()).toEqual([f.locator])
  const later: AttachmentLocator = { ...f.locator, transferId: "old-epoch-later", manifestId: "D".repeat(43) }
  await f.createWorkspaceAttachmentIndex(f.owner, f.config, () => {}).merge([later])
  expect(await rotated.read()).toEqual(expect.arrayContaining([f.locator, later]))
  expect(await f.local.readLocal(f.sourceKey)).toBe(f.sourceRaw)
})

it("Given a retained key for a different scope or workspace, when opening rotated discovery, then do not inherit its index", async () => {
  const f = await fixture()
  await f.createWorkspaceAttachmentIndex(f.owner, f.config, () => {}).read()
  for (const changes of [{ scopeId: "different-scope" }, { workspaceId: "different-board" }]) {
    const changed = { ...f.config, ...changes, keyEpoch: 2, contentKey: `${"C".repeat(42)}A`, historicalContentKeys: { "1": f.config.contentKey } }
    expect(await f.createWorkspaceAttachmentIndex(f.owner, changed, () => {}).read()).toEqual([])
  }
})

it("Given migration storage fails, then retain the exact source index and retry its complete union", async () => {
  const f = await fixture()
  const index = f.createWorkspaceAttachmentIndex(f.owner, f.config, () => {})
  const update = vi.spyOn(f.local, "updateLocal").mockRejectedValueOnce(new Error("Index migration storage unavailable"))
  await expect(index.read()).rejects.toThrow("Index migration storage unavailable")
  update.mockRestore()
  expect(await f.local.readLocal(f.sourceKey)).toBe(f.sourceRaw)
  expect(await index.read()).toEqual([f.locator])
})

it("plans workspace index migration using the legacy and stable crypto-context bindings", async () => {
  const f = await fixture()
  const plan = await f.planWorkspaceAttachmentIndexMigration(f.owner, f.config)
  const stableKey = f.attachmentIndexBinding(f.owner, f.config)
  expect(plan.conditions).toHaveLength(2)
  expect(plan.writes).toHaveLength(1)
  expect(await f.local.readLocal(f.sourceKey)).toBe(f.sourceRaw)

  expect(await f.local.compareAndSwapLocal(plan)).toBe(true)
  const target = f.createAttachmentIndexRepository(stableKey, () => {})
  expect(await target.read()).toEqual([f.locator])
  expect(await f.local.readLocal(f.sourceKey)).toBe(f.sourceRaw)
})

it("accepts the longest valid causal preference binding for workspace attachment indexes", async () => {
  const f = await fixture()
  const preferenceRevision = Array.from({ length: 32 }, (_, index) =>
    `${"a".repeat(120)}${index.toString().padStart(3, "0")}:${index + 1}`).sort().join("|")
  const config = { ...f.config, preferenceRevision }
  const { parseReplicaConfig } = await import("./blindReplicaConfig")
  const parsed = parseReplicaConfig(JSON.stringify(config))
  const { privateReplicaBinding } = await import("./privateReplicaRepository")
  const storageId = privateReplicaBinding(f.owner, parsed)
  expect(storageId.length).toBeGreaterThan(2048)
  expect(await f.createWorkspaceAttachmentIndex(f.owner, config, () => {}).read()).toEqual([])
})
