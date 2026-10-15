import { z } from "zod"
import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import type { BlindReplicaConfig } from "./blindReplication"
import type { HistoryBaselineFetchPort, WireHistoryBaseline } from "./historyBaselineReceiver"
import type { StoredWorkspaceSnapshot } from "../storageJournal"

type BrowserHistoryReceiveLocalState = {
  bytes: Uint8Array
  heads: string[]
  revision: string | undefined
  catalogRevision: string | undefined
  pending: boolean
}

type ReceiveRepository = {
  readActive(): Promise<{ baselineId?: string } | undefined>
  readStaged(): Promise<{ baselineId?: string; stageId: string } | undefined>
  stage(candidate: WasmVerifiedReceivedHistoryBaseline, expected: StoredWorkspaceSnapshot | null, wire: WireHistoryBaseline): Promise<string>
  activate(stageId: string, candidate: WasmVerifiedReceivedHistoryBaseline): Promise<void>
}

export type BrowserHistoryBaselineReceivePorts = {
  repository: ReceiveRepository
  ensureCurrent(): void | Promise<void>
  readLocal(): Promise<BrowserHistoryReceiveLocalState>
  verify(input: { wire: unknown; config: BlindReplicaConfig; trustedScopeAuthority: unknown;
    previous?: WasmVerifiedReceivedHistoryBaseline | null; fetch: HistoryBaselineFetchPort }): Promise<WasmVerifiedReceivedHistoryBaseline>
  coversHeads(candidate: WasmVerifiedReceivedHistoryBaseline, heads: string[], config: BlindReplicaConfig,
    fetch: HistoryBaselineFetchPort): Promise<void>
  readExpectedSnapshot(): Promise<StoredWorkspaceSnapshot | null>
  accept(candidate: WasmVerifiedReceivedHistoryBaseline): Promise<void>
  merge(document: Uint8Array, authorization: unknown, candidate: WasmVerifiedReceivedHistoryBaseline): Promise<void>
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

function sameLocalState(left: BrowserHistoryReceiveLocalState, right: BrowserHistoryReceiveLocalState): boolean {
  return !left.pending && !right.pending && left.revision === right.revision && left.catalogRevision === right.catalogRevision &&
    sameBytes(left.bytes, right.bytes) && left.heads.length === right.heads.length &&
    left.heads.every((head, index) => head === right.heads[index])
}

const scopePayload = z.object({ workspaceId: z.string(), baselineId: z.string().min(1), storage: z.object({
  authority: z.object({ scopeId: z.string(), servicePublicKey: z.string(), policyRevision: z.number().int().positive().refine(Number.isSafeInteger) }),
  keyEpoch: z.number().int().positive().refine(Number.isSafeInteger),
}) })

function receivedScope(candidate: WasmVerifiedReceivedHistoryBaseline, workspaceId: string, config: BlindReplicaConfig) {
  const envelope = candidate.envelope() as { payload?: unknown } | undefined
  const result = scopePayload.safeParse(envelope?.payload)
  if (!result.success) throw new Error("Received history baseline differs from the pinned Rusty workspace scope")
  const payload = result.data
  if (payload.workspaceId !== workspaceId || payload.storage.authority.scopeId !== config.scopeId ||
      payload.storage.authority.servicePublicKey !== config.servicePublicKey || payload.storage.authority.policyRevision > config.policyRevision) {
    throw new Error("Received history baseline differs from the pinned Rusty workspace scope")
  }
  return payload
}

async function activateReceivedScope(ports: BrowserHistoryBaselineReceivePorts, candidate: WasmVerifiedReceivedHistoryBaseline,
  baselineId: string, wire: WireHistoryBaseline, before: BrowserHistoryReceiveLocalState): Promise<void> {
  const active = await ports.repository.readActive()
  await ports.ensureCurrent()
  if (active?.baselineId === baselineId) return
  const staged = await ports.repository.readStaged()
  await ports.ensureCurrent()
  let stageId: string
  if (staged) {
    if (staged.baselineId !== baselineId) throw new Error("A different received history baseline is already staged")
    stageId = staged.stageId
  } else {
    const expected = await ports.readExpectedSnapshot()
    await ports.ensureCurrent()
    stageId = await ports.repository.stage(candidate, expected, wire)
  }
  const preActivation = await ports.readLocal()
  await ports.ensureCurrent()
  if (!sameLocalState(before, preActivation)) throw new Error("Workspace or Rusty outbox changed before history activation")
  await ports.repository.activate(stageId, candidate)
  await ports.ensureCurrent()
}

/** Receive a compact basis without discarding an uncovered branch or uncertain old upload. */
export async function receiveBrowserHistoryBaseline(inputValue: {
  workspaceId: string
  config: BlindReplicaConfig
  wire: unknown
  document: Uint8Array
  authorization: unknown
  trustedScopeAuthority: unknown
  previous?: WasmVerifiedReceivedHistoryBaseline | null
  fetch: HistoryBaselineFetchPort
  ports: BrowserHistoryBaselineReceivePorts
}): Promise<void> {
  const input = { ...inputValue, config: structuredClone(inputValue.config), wire: structuredClone(inputValue.wire),
    document: inputValue.document.slice(), authorization: structuredClone(inputValue.authorization),
    trustedScopeAuthority: structuredClone(inputValue.trustedScopeAuthority), previous: inputValue.previous ?? null,
    fetch: inputValue.fetch, ports: inputValue.ports }
  if (!input.workspaceId || input.workspaceId !== input.config.workspaceId || !input.trustedScopeAuthority ||
      typeof input.ports?.ensureCurrent !== "function") throw new Error("Received history baseline lacks its admitted workspace scope")
  const { ports } = input
  await ports.ensureCurrent()
  const before = await ports.readLocal()
  if (before.pending) throw new Error("Confirm the exact original Rusty outbox before switching history basis")
  let candidate: WasmVerifiedReceivedHistoryBaseline | undefined
  let accepted = false
  try {
    candidate = await ports.verify({ wire: input.wire, config: input.config,
      trustedScopeAuthority: input.trustedScopeAuthority, previous: input.previous, fetch: input.fetch })
    await ports.ensureCurrent()
    const payload = receivedScope(candidate, input.workspaceId, input.config)
    await ports.coversHeads(candidate, [...before.heads], input.config, input.fetch)
    await ports.ensureCurrent()
    const after = await ports.readLocal()
    if (!sameLocalState(before, after)) throw new Error("Workspace or Rusty outbox changed while history baseline was received")

    await activateReceivedScope(ports, candidate, payload.baselineId, input.wire as WireHistoryBaseline, before)
    await ports.accept(candidate)
    accepted = true
    await ports.ensureCurrent()
    await ports.merge(input.document, input.authorization, candidate)
    await ports.ensureCurrent()
  } finally {
    if (!accepted) candidate?.free()
  }
}
