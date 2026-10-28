import { writeFile } from "node:fs/promises"
import type { Page, TestInfo } from "@playwright/test"

type BackupProgress = {
  elapsedMs: number; phase: string; guard: string; guards: number
  exportPhase: string; records: number; evidenceParts: number; sources: number
}

/** Fixture-only stage names and counters identify an unresolved export await; no document or key material. */
export async function captureHistoryBackupProgress(page: Page, info: TestInfo): Promise<() => Promise<void>> {
  const samples: BackupProgress[] = []
  await page.exposeFunction("__captureHistoryBackupProgress", (sample: BackupProgress) => {
    samples.push(sample)
    if (samples.length > 32) samples.shift()
  })
  await page.addInitScript(() => {
    const target = globalThis as typeof globalThis & {
      __historyBackupProgress?: BackupProgress
      __captureHistoryBackupProgress?: (sample: BackupProgress) => Promise<void>
    }
    const started = performance.now()
    const progress: BackupProgress = { elapsedMs: 0, phase: "not entered", guard: "idle", guards: 0,
      exportPhase: "idle", records: 0, evidenceParts: 0, sources: 0 }
    target.__historyBackupProgress = progress
    setInterval(() => {
      progress.elapsedMs = Math.round(performance.now() - started)
      void target.__captureHistoryBackupProgress?.({ ...progress }).catch(() => {})
    }, 2_000)
  })
  await page.route("**/src/app/workspaceHistoryRecovery.ts*", async route => {
    const response = await route.fetch()
    const body = instrumentWorkspaceRecovery(await response.text())
    await route.fulfill({ response, body, headers: { ...response.headers(), "content-length": String(Buffer.byteLength(body)) } })
  })
  await page.route("**/src/sync/historyRecoveryArchive.ts*", async route => {
    const response = await route.fetch()
    const body = instrumentArchiveExport(await response.text())
    await route.fulfill({ response, body, headers: { ...response.headers(), "content-length": String(Buffer.byteLength(body)) } })
  })
  return async () => {
    const path = info.outputPath("private-backup-progress.json")
    await writeFile(path, JSON.stringify(samples))
    await info.attach("private-backup-progress", { path, contentType: "application/json" })
  }
}

function anchorMatch(source: string, anchor: string): RegExpExecArray {
  const escaped = anchor.trim().split(/\s+/).map(token => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
  const match = new RegExp(escaped).exec(source)
  if (!match || match.index === undefined) throw new Error(`Backup diagnostic anchor changed: ${anchor}`)
  return match
}

function insertBefore(source: string, anchor: string, statement: string): string {
  const match = anchorMatch(source, anchor)
  return `${source.slice(0, match.index)}${statement}\n${source.slice(match.index)}`
}

function insertAfter(source: string, anchor: string, statement: string): string {
  const match = anchorMatch(source, anchor), end = match.index + match[0].length
  return `${source.slice(0, end)} ${statement}${source.slice(end)}`
}

function instrumentWorkspaceRecovery(source: string): string {
  source = `const __backupProgress = globalThis.__historyBackupProgress;\n${source}`
  const stages = [
    ["read document", "  const doc = await core.tincanban.readWorkspaceDoc(workspaceId)"],
    ["signing context", "  const signing = await workspaceSigningContext("],
    ["identity backup", '  const identity = await createIdentityDeviceRecovery("better");'],
    ["open identity backup", "  const transfer = (await openIdentityDeviceRecovery("],
    ["local evidence capture", "  const source = await createWorkspaceHistoryRecoveryEvidence("],
    ["raw workspace", "  const raw = await core.tincanban.readWorkspaceBytes(workspaceId);"],
    ["authorization export", "  const authorization = await exportAuthorizationBundle("],
    ["archive sources", "  const archive = await workspaceHistoryRecoverySources("],
    ["peer lineage", "  const peerLineage = await workspacePeerHistoryRecoveryLineage({"],
    ["publication metadata", "  const publications = await listWorkspaceHistoryPublications(workspaceId);"],
    ["recovery key", "  const seed = await identitySeedFromPrivateKey("],
    ["file writer", "    const writer = await createHistoryRecoveryFileWriter({"],
    ["export archive", "    const manifest = await exportHistoryRecoveryArchive("],
    ["finish file", "    const file = await writer.finish();"],
    ["complete", "    return { file, words: identity.recoveryKey,"],
  ]
  for (const [phase, anchor] of stages) source = insertBefore(source, anchor!, `__backupProgress.phase = ${JSON.stringify(phase)};`)
  source = insertBefore(source, "  const guard = async () => {", "__backupProgress.guard = 'ready';")
  source = insertAfter(source, "  const guard = async () => {", "__backupProgress.guards++; __backupProgress.guard = 'identity';")
  source = insertBefore(source, "    await signing.requireCurrent();", "__backupProgress.guard = 'signing authority';")
  source = insertBefore(source, "    await source.assertUnchanged();", "__backupProgress.guard = 'source revision';")
  source = insertBefore(source, "    if (canonicalizeJson(await exportPrivateReplicaState(", "__backupProgress.guard = 'private connections';")
  return insertBefore(source, "  };\n  await guard();", "    __backupProgress.guard = 'complete';")
}

function instrumentArchiveExport(source: string): string {
  source = `const __archiveProgress = globalThis.__historyBackupProgress;\n${source}`
  source = insertAfter(source, "  async evidence() {", "__archiveProgress.exportPhase = 'local and peer evidence';")
  source = insertAfter(source, "  async source(source) {", "__archiveProgress.exportPhase = 'encrypted source'; __archiveProgress.sources++;")
  source = insertAfter(source, "  async write(record) {", "__archiveProgress.records++; if (record.kind === 'local-evidence-part') __archiveProgress.evidenceParts++;")
  return insertAfter(source, "  async finish() {", "__archiveProgress.exportPhase = 'manifest';")
}
