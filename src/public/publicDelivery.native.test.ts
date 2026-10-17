import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, expect, test, vi } from "vitest"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import * as Automerge from "@automerge/automerge/slim"
import { profileFromIdentitySeedForDevice } from "@meta-uber/mesh-identity"
import { bootstrapIdentity, canonicalizeJson, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, type LocalProfile } from "../domain/identity"
import { createAutomationWorkspaceGrant, createWorkspaceGrant } from "../domain/proofs"
import { createWorkspaceDoc } from "../test/boardFixture"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { recordGenesisAuthority } from "../sync/changeAuthorization"
import { publishBoardSnapshot, withdrawPublicBoard } from "./publicationClient"
import { deliverPublicBoard, type PublicDeliveryCommand } from "./publicDelivery"
import type { PublicBoardDeliveryPolicyEvidence } from "./publicDeliveryPolicy"
import { createBrowserBoardPublication as createPublicBoardPublication } from "../app/publicBoardPublication"
import { validatePublicBoardProjection } from "./publicSchema"
import type { PublicBoardProjection } from "./publicSchema"

vi.mock("../sync/workspaceAdmissionClient", () => ({ runWorkspaceAccess: async () => "owner" }))

type StagePublicAsset = (asset: { sha256: string; bytes: Uint8Array }) => Promise<void>

let automergeReady: Promise<void> | undefined
function initializeNativeAutomerge(): Promise<void> {
  return automergeReady ??= readFile(resolve(process.cwd(), "node_modules/@automerge/automerge/dist/automerge.wasm"))
    .then(bytes => Automerge.initializeWasm(new Uint8Array(bytes)))
}

afterEach(() => { resetIdentityStorageForTest(); vi.unstubAllGlobals() })

function stubWindow(origin: string): void {
  vi.stubGlobal("window", { location: { origin, search: "", hostname: "localhost", href: `${origin}/` },
    addEventListener: vi.fn(), removeEventListener: vi.fn() })
}

async function unusedLoopbackPort(): Promise<number> {
  const listener = createServer()
  await new Promise<void>((resolveListen, reject) => {
    listener.once("error", reject)
    listener.listen(0, "127.0.0.1", () => resolveListen())
  })
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("Loopback listener did not expose a port")
  const port = address.port
  await new Promise<void>((resolveClose, reject) => listener.close(error => error ? reject(error) : resolveClose()))
  return port
}

async function startRusty(owner: LocalProfile) {
  const port = await unusedLoopbackPort()
  const directory = await mkdtemp(resolve(tmpdir(), "tincanban-public-delivery-native-"))
  const origin = `http://127.0.0.1:${port}`
  const binary = resolve(process.cwd(), process.env.TINCANBAN_RUSTY_BINARY ?? "../mesh-lighthouse/target/debug/mesh-lighthouse")
  const child = spawn(binary, [directory, `127.0.0.1:${port}`], { env: {
    ...process.env, RUSTY_PUBLIC_ORIGIN: origin,
    RUSTY_TRUSTED_OWNER: JSON.stringify({ identity: owner.identity, allowedControllerDeviceIds: [owner.device.deviceId] }),
    RUSTY_LOG: "off",
  }, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout?.on("data", (chunk: Buffer) => { output = `${output}${chunk}`.slice(-8_000) })
  child.stderr?.on("data", (chunk: Buffer) => { output = `${output}${chunk}`.slice(-8_000) })
  try {
    // The first health response hashes the complete cold debug executable.
    const startedAt = Date.now()
    const deadline = startedAt + 30_000
    let lastProbe = "No health probe completed"
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Rusty exited during startup: ${output}`)
      try {
        const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, deadline - Date.now()))) })
        if (response.ok) return { child, directory, origin }
        lastProbe = `HTTP ${response.status} ${response.statusText}`.slice(0, 1_024)
      } catch (error) {
        const cause = error instanceof Error && error.cause instanceof Error ? `; cause: ${error.cause.name}: ${error.cause.message}` : ""
        lastProbe = `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}${cause}`.slice(0, 1_024)
      }
      await delay(Math.max(0, Math.min(40, deadline - Date.now())))
    }
    throw new Error(`Rusty did not become ready after ${Date.now() - startedAt}ms; last health probe: ${lastProbe}; child output: ${output}`)
  } catch (error) {
    await stopRusty(child)
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function stopRusty(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGINT")
  const exited = (timeoutMs: number) => new Promise<boolean>(resolveExit => {
    const onExit = () => { clearTimeout(timer); resolveExit(true) }
    const timer = setTimeout(() => { child.removeListener("exit", onExit); resolveExit(false) }, timeoutMs)
    child.once("exit", onExit)
  })
  if (await exited(4_000)) return
  child.kill("SIGTERM")
  if (await exited(2_000)) return
  child.kill("SIGKILL")
  if (!await exited(2_000)) throw new Error("Rusty process did not exit; preserving its state directory")
}

test("Given owner-approved editor and automation grants, when delivery runs without the owner, then content binds to the projection, retry is idempotent, revocation blocks writes, and withdrawal stays withdrawn", async () => {
  await initializeNativeAutomerge()
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  stubWindow("http://localhost")
  const owner = await bootstrapIdentity("Public board owner")
  const editor = await profileFromIdentitySeedForDevice(crypto.getRandomValues(new Uint8Array(32)), "Board editor")
  const automation = await profileFromIdentitySeedForDevice(crypto.getRandomValues(new Uint8Array(32)), "Board automation")
  const service = await startRusty(owner)
  let workspace: Automerge.Doc<WorkspaceDocumentV2> | undefined
  let staleWorkspace: Automerge.Doc<WorkspaceDocumentV2> | undefined
  try {
    const workspaceId = crypto.randomUUID()
    const seed = createWorkspaceDoc(workspaceId, "Delivery fixture", owner.identity.personId, "job-search")
    const board = Object.values(seed.entities).find(entity => entity.kind === "board")!
    const columns = board.kind === "board" ? board.preset!.bindings : {}
    const fieldId = columns["field.company"]
    const cardId = crypto.randomUUID()
    const now = new Date().toISOString()
    seed.entities[cardId] = { id: cardId, title: "Original card", body: "Source content", values: { [fieldId]: "Before" },
      placement: { parentId: columns["status.lead"], rank: "0/1" }, archivedAt: null, createdAt: now, updatedAt: now }
    workspace = Automerge.from<WorkspaceDocumentV2>(seed)
    await recordGenesisAuthority(workspace, owner)
    const editorGrant = await createWorkspaceGrant(owner, workspaceId, editor.identity.personId, "editor", 1)
    const automationGrant = await createAutomationWorkspaceGrant(owner, workspaceId, automation.identity.personId, {
      version: 1, boardId: board.id, columns: { lead: columns["status.lead"], applied: columns["status.applied"],
        interview: columns["status.interview"], rejected: columns["status.rejected"] }, fieldIds: [fieldId], expiresAt: Date.now() + 60_000,
    }, 1)
    const policyPayload = { kind: "rusty-public-board-delivery-policy" as const, version: 1 as const, workspaceId, boardId: board.id,
      generation: 1, accessEpoch: 1, enabled: true as const,
      acceptedGrants: [editorGrant, automationGrant].sort((left, right) => left.payload.grantId.localeCompare(right.payload.grantId)),
      revokedGrantIds: [] as string[], revokedDeviceIds: [] as string[] }
    const policy: PublicBoardDeliveryPolicyEvidence = {
      policy: await signEnvelope(owner.privateKeys.devicePrivateKey, policyPayload, owner.device.deviceId),
      ownerCertificates: [owner.certificate],
    }
    const originForWindow = service.origin
    stubWindow(originForWindow)
    await publishBoardSnapshot({ origin: service.origin, boardId: board.id, workspaceId, document: workspace, profile: owner,
      action: "publish", expectedRevision: 0, deliveryPolicy: policy })
    const writerInput = (profile: LocalProfile, grant: typeof editorGrant, buildProjection: Parameters<typeof deliverPublicBoard>[0]["buildProjection"],
      source: Automerge.Doc<WorkspaceDocumentV2> = workspace!) => ({
      origin: service.origin, boardId: board.id, workspaceId, identity: profile.identity, deviceId: profile.device.deviceId,
      certificates: [profile.certificate], grant, sourceHeads: Automerge.getHeads(source).sort(), ensureCurrent: () => {},
      ensureSourceCovers: (heads: string[]) => {
        if (!Automerge.hasHeads(source, heads)) throw new Error("Local admitted source has not caught up to the published board")
      },
      sign: (payload: PublicDeliveryCommand) => signEnvelope(profile.privateKeys.devicePrivateKey, payload, profile.device.deviceId), buildProjection,
    })

    const originalFetch = globalThis.fetch.bind(globalThis)
    let loseNextUpdateReply = true
    let challengeRequests = 0
    let writeRequests = 0
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/v1/public/challenges")) challengeRequests++
      if (init?.method === "PUT" && String(input).includes(`/v1/public/boards/${board.id}`)) writeRequests++
      const response = await originalFetch(input, init)
      if (loseNextUpdateReply && init?.method === "PUT" && String(input).includes(`/v1/public/boards/${board.id}`) && !String(input).endsWith("/files")) {
        loseNextUpdateReply = false
        throw new Error("Simulated lost response after durable commit")
      }
      return response
    }))
    workspace = Automerge.change(workspace, "Admitted editor changes the card title", draft => {
      const card = draft.entities[cardId]
      if (!card || "kind" in card) throw new Error("Delivery fixture card disappeared")
      card.title = "Editor delivery"
      card.updatedAt = new Date().toISOString()
    })
    let expectedEditorProjection: PublicBoardProjection | undefined
    const editorProjection = async (_current: PublicBoardProjection, stageAsset: StagePublicAsset) => {
      expectedEditorProjection = (await createPublicBoardPublication(workspace!, workspaceId, board.id, stageAsset)).projection
      return expectedEditorProjection
    }
    await expect(deliverPublicBoard(writerInput(editor, editorGrant, editorProjection))).rejects.toThrow(/lost response/)
    const retried = await deliverPublicBoard(writerInput(editor, editorGrant, editorProjection))
    expect(retried?.revision).toBe(2)
    let served = await originalFetch(`${service.origin}/v1/public/boards/${board.id}`)
    let servedSnapshot = await served.json() as { revision: number; projection: unknown; hash: string }
    const editorView = validatePublicBoardProjection(servedSnapshot.projection)
    expect(editorView.cards.find(card => card.id === cardId)?.title).toBe("Editor delivery")
    expect(editorView).toEqual(expectedEditorProjection)
    expect(servedSnapshot.hash).toBe(retried?.hash)
    expect(servedSnapshot.hash).toBe(await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(editorView))))

    workspace = Automerge.change(workspace, "Admitted automation moves the card and updates its field", draft => {
      const card = draft.entities[cardId]
      if (!card || "kind" in card) throw new Error("Delivery fixture card disappeared")
      card.placement.parentId = columns["status.applied"]
      card.values[fieldId] = "After"
      card.updatedAt = new Date().toISOString()
    })
    let expectedAutomationProjection: PublicBoardProjection | undefined
    const automationProjection = async (_current: PublicBoardProjection, stageAsset: StagePublicAsset) => {
      expectedAutomationProjection = (await createPublicBoardPublication(workspace!, workspaceId, board.id, stageAsset)).projection
      return expectedAutomationProjection
    }
    const automated = await deliverPublicBoard(writerInput(automation, automationGrant, automationProjection))
    expect(automated?.revision).toBe(3)
    served = await originalFetch(`${service.origin}/v1/public/boards/${board.id}`)
    servedSnapshot = await served.json() as { revision: number; projection: unknown; hash: string }
    const automatedView = validatePublicBoardProjection(servedSnapshot.projection)
    expect(automatedView).toEqual(expectedAutomationProjection)
    expect(automatedView.cards.find(card => card.id === cardId)).toMatchObject({ columnId: columns["status.applied"], values: { [fieldId]: "After" } })
    expect(servedSnapshot.hash).toBe(automated?.hash)
    expect(servedSnapshot.hash).toBe(await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(automatedView))))

    staleWorkspace = Automerge.clone(workspace)
    workspace = Automerge.change(workspace, "Owner records a new source revision", draft => {
      const card = draft.entities[cardId]
      if (!card || "kind" in card) throw new Error("Delivery fixture card disappeared")
      card.body = "Owner source revision after writer sync"
      card.updatedAt = new Date().toISOString()
    })
    await publishBoardSnapshot({ origin: service.origin, boardId: board.id, workspaceId, document: workspace, profile: owner,
      action: "update", expectedRevision: 3 })
    const staleEditorProjection = async (current: PublicBoardProjection) => ({ ...current })
    const writesBeforeStaleAttempt = writeRequests
    await expect(deliverPublicBoard(writerInput(editor, editorGrant, staleEditorProjection, staleWorkspace)))
      .rejects.toThrow(/caught up|source/i)
    expect(writeRequests).toBe(writesBeforeStaleAttempt)
    staleWorkspace = Automerge.clone(workspace)
    const challengesBeforeSyncedNoop = challengeRequests
    await expect(deliverPublicBoard(writerInput(editor, editorGrant, staleEditorProjection, staleWorkspace))).resolves.toMatchObject({ revision: 4 })
    expect(challengeRequests).toBe(challengesBeforeSyncedNoop + 1)

    const revokedPolicyPayload = { ...policyPayload, generation: 2, acceptedGrants: [automationGrant], revokedGrantIds: [editorGrant.payload.grantId] }
    const revokedPolicy: PublicBoardDeliveryPolicyEvidence = {
      policy: await signEnvelope(owner.privateKeys.devicePrivateKey, revokedPolicyPayload, owner.device.deviceId), ownerCertificates: [owner.certificate],
    }
    await publishBoardSnapshot({ origin: service.origin, boardId: board.id, workspaceId, document: workspace, profile: owner,
      action: "update", expectedRevision: 4, deliveryPolicy: revokedPolicy })
    const revokedEditorProjection = async (current: PublicBoardProjection) => ({
      ...current, cards: current.cards.map(card => card.id === cardId ? { ...card, title: "Unauthorized editor write" } : card),
    })
    await expect(deliverPublicBoard(writerInput(editor, editorGrant, revokedEditorProjection))).rejects.toThrow()
    served = await originalFetch(`${service.origin}/v1/public/boards/${board.id}`)
    servedSnapshot = await served.json() as { revision: number; projection: unknown; hash: string }
    expect(servedSnapshot.revision).toBe(5)

    await withdrawPublicBoard({ origin: service.origin, boardId: board.id, profile: owner, expectedRevision: 5 })
    expect((await originalFetch(`${service.origin}/v1/public/boards/${board.id}`)).status).toBe(404)
    expect(await deliverPublicBoard(writerInput(automation, automationGrant, automationProjection))).toBeNull()
  } finally {
    await stopRusty(service.child)
    await rm(service.directory, { recursive: true, force: true })
  }
}, 60_000)
