import { beforeAll, expect, it, vi } from "vitest"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { listRetainedWorkspaceRecoveryArchives, retainWorkspaceRecoveryArchives } from "./workspaceHistoryRecoveryArchives"
import { toBase64Url } from "../domain/identity"
import type { HistoryRecoveryRecord } from "./historyRecoveryArchive"
import type { ArchiveLocatorRoot } from "@meta-uber/mesh-replication/history-archive-locators"

beforeAll(() => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
})

it("Given original archive sources, when restoring and re-exporting offline, then retain exact private reading evidence under its original workspace", async () => {
  const person = crypto.randomUUID(), workspace = crypto.randomUUID(), recovery = crypto.randomUUID()
  const root: ArchiveLocatorRoot = { kind: "workspace-history-locator-root", version: 1,
    context: { workspaceId: workspace, historyEpoch: 2, indexId: "archive-locators" },
    root: { objectId: "A".repeat(43), ciphertextId: "B".repeat(43), height: 0, count: 0, first: null, last: null } }
  const source = { kind: "archive-source" as const, id: "original", workspaceId: workspace, scopeId: "scope", keyEpoch: 2,
    key: toBase64Url(new Uint8Array(32).fill(7)), signedJson: toBase64Url(new TextEncoder().encode("original signature")),
    roots: [root], authorityEvidence: { original: "unchanged" } } satisfies Extract<HistoryRecoveryRecord, { kind: "archive-source" }>
  await retainWorkspaceRecoveryArchives(person, workspace, recovery, [source], () => {})
  await retainWorkspaceRecoveryArchives(person, workspace, recovery, [source], () => {})
  const archived = await listRetainedWorkspaceRecoveryArchives(person, workspace, () => {})
  expect(archived).toHaveLength(1)
  expect(archived[0]!.source).toEqual(source)
  expect(await listRetainedWorkspaceRecoveryArchives(crypto.randomUUID(), workspace, () => {})).toEqual([])
  expect(await listRetainedWorkspaceRecoveryArchives(person, crypto.randomUUID(), () => {})).toEqual([])
  await expect(retainWorkspaceRecoveryArchives(person, workspace, recovery,
    [{ ...source, authorityEvidence: { original: "substituted" } }], () => {})).rejects.toThrow(/different/i)
})

it("Given stale recovery access, when retaining sources, then refuse a private-source write", async () => {
  const guard = () => { throw new Error("Identity changed") }
  await expect(retainWorkspaceRecoveryArchives("person", "board", crypto.randomUUID(), [], guard)).rejects.toThrow("Identity changed")
})
