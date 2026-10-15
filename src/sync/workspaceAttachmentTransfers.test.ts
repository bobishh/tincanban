import { expect, it, vi } from "vitest"
import type { BlindReplicaConfig } from "./blindReplication"
import type { AttachmentTransferRepository } from "./attachmentTransfer"
import { selectWorkspaceAttachmentTransfer } from "./workspaceAttachmentTransfers"

const key = (letter: string) => `${letter.repeat(42)}A`
const config: BlindReplicaConfig = { purpose: "workspace", workspaceId: "board", origin: "https://rusty.example",
  scopeId: "scope", servicePublicKey: key("A"), readToken: key("B"), writeToken: key("C"),
  keyEpoch: 3, contentKey: key("D"), historicalContentKeys: { "1": key("E"), "2": key("F") },
  policyRevision: 4, cursor: 0, lastUploaded: "" }

function repository(prepared: boolean, chunks?: number) {
  return { read: vi.fn(async () => prepared ? { retained: true } : null),
    preparation: { read: vi.fn(async () => chunks === undefined ? null : { chunks: Array.from({ length: chunks }, () => ({})) }) },
  } as unknown as AttachmentTransferRepository
}

it("Given a rotated connection and an old prepared transfer, When retrying without source, Then select original encryption context and current transport access", async () => {
  const active = repository(false), old = repository(true)
  const selected = await selectWorkspaceAttachmentTransfer(config, 1, async candidate => candidate.keyEpoch === 1 ? old : active, async () => {})
  expect(selected.config).toMatchObject({ keyEpoch: 1, contentKey: key("E"), readToken: config.readToken, writeToken: config.writeToken })
  expect(selected.config.historicalContentKeys).toBeUndefined()
  expect(selected.repository).toBe(old)
  expect(selected.prepared).toBe(true)
})

it("Given a partially sealed old source, When retrying, Then retain its context and require source continuation instead of creating another transfer", async () => {
  const partial = repository(false, 1)
  const selected = await selectWorkspaceAttachmentTransfer(config, 2, async candidate => candidate.keyEpoch === 2 ? partial : repository(false), async () => {})
  expect(selected.config.keyEpoch).toBe(2)
  expect(selected.prepared).toBe(false)
  expect(selected.repository).toBe(partial)
})

it("Given active and historical prepared transfers, When resuming, Then prefer active and leave historical records intact", async () => {
  const active = repository(true)
  const open = vi.fn(async () => active)
  const selected = await selectWorkspaceAttachmentTransfer(config, 1, open, async () => {})
  expect(selected.config.keyEpoch).toBe(3)
  expect(open).toHaveBeenCalledOnce()
})

it("Given no durable preparation, When selecting, Then create future ciphertext only under the current key", async () => {
  const selected = await selectWorkspaceAttachmentTransfer(config, 1, async () => repository(false), async () => {})
  expect(selected.config).toEqual(config)
  expect(selected.prepared).toBe(false)
})

it("Given a revoked session while probing old progress, When its read resolves, Then refuse a resumable result", async () => {
  let current = true
  await expect(selectWorkspaceAttachmentTransfer(config, 1, async () => {
    current = false
    return repository(true)
  }, async () => { if (!current) throw new Error("Access changed") })).rejects.toThrow("Access changed")
})

it("Given corrupt historical progress, When selecting, Then surface the failure instead of silently replacing the old transfer", async () => {
  await expect(selectWorkspaceAttachmentTransfer(config, 1, async candidate => {
    if (candidate.keyEpoch === 2) throw new Error("Corrupt retained progress")
    return repository(false)
  }, async () => {})).rejects.toThrow("Corrupt retained progress")
})

it('Given two historical candidates at the same epoch, when an original transfer is pending, then inspect both original bindings without replacing ciphertext', async () => {
  const recovered = { ...config, historicalContentKeys: undefined, historicalContentKeyVariants: { '2': [key('E'), key('F')].sort() } }
  const old = repository(true)
  const selected = await selectWorkspaceAttachmentTransfer(recovered, 1, async candidate => candidate.contentKey === key('F') ? old : repository(false), async () => {})
  expect(selected.config).toMatchObject({ keyEpoch: 2, contentKey: key('F') })
  expect(selected.config.historicalContentKeyVariants).toBeUndefined()
  expect(selected.repository).toBe(old)
})
