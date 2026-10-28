import { execFile, spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import * as Automerge from "@automerge/automerge/slim"
import { WasmStateCore, type WasmVerifiedHistoryArchiveCoverage } from "@meta-uber/mesh-transport/wasm"
import { adoptEnrolledIdentity, bootstrapIdentity as bootstrapRawIdentity, canonicalizeJson, createIdentityRecovery,
  resetIdentityStorageForTest, signEnvelope, toBase64Url } from "../domain/identity"
import { createPersonalRoot, registerWorkspaceInRoot } from "../domain/personalRoot"
import { createWorkspaceDoc } from "../test/boardFixture"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { certHashDefault, createDelegatedCertificate, defaultProofStore } from "../domain/proofs"
import { defaultStorage, type WorkspaceTransactionContext } from "../storage"
import { deleteLocal, listLocalKeys } from "../localDb"
import { exportPrivateReplicaState, getIdentityReplicaConfigurations, getPrivateReplicaProgress, getReplicaConfigurations,
  persistPrivateReplicaState, receivePrivateReplicaState, setReplicaPreference } from "./privateReplicaRepository"
import { RustyManagementRepository } from "./rustyManagementRepository"
import { ensureIdentityReplicaConnection } from "./identityReplicaConnection"
import { createIdentityReplica } from "./identityReplicaStore"
import { exportIdentityRecoveryEvidence } from "./identityRecoveryState"
import { approveRustyScope } from "./rustyEnrollment"
import { blindObjectId, discoverBlindKeeper, inventoryBlindObjects, uploadBlindObject, downloadBlindObject } from "./blindClient"
import { decodeBlindBytes, encryptBlindObject, decryptBlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import { prepareBlindCheckpoint, submitBlindCheckpoint } from "./blindCheckpoint"
import { ensureRustyPersonPolicy, readRustyManagementStatus, updateRustyManagementPolicy } from "./rustyManagementClient"
import { applyIdentityDeviceTransfer, createIdentityDeviceTransfer, readIdentityDeviceTransfer } from "./identityDeviceTransfer"
import { exportIdentityDeviceExtensions } from "./identityDeviceExtensions"
import * as identityTransfer from "./identityDeviceTransfer"
import { createChatRecordFixture as createChatRecord } from "../chat/records.testSupport"
import { readIdentityProfileQueue } from "./identityProfileProjectionQueue"
import { identityProfileProjectionKey } from "./identityProfileProjectionState"
import { saveIdentityPhoto } from "../app/identityPhoto"
import { identityProfileValue, readIdentityProfileState } from "../domain/identityProfileState"
import { createBlobDescriptor } from "@meta-uber/mesh-blob"
import { AttachmentTransfer } from "./attachmentTransfer"
import { createAttachmentRepository } from "./attachmentRepository"
import { uploadBlindBlob, downloadBlindBlob } from "./blindBlobClient"
import { createAttachmentIndexRepository } from "./attachmentIndexRepository"
import { privateReplicaBinding } from "./privateReplicaRepository"
import { fetchRustyAttachment } from "./rustyAttachmentDelivery"
import { recordGenesisAuthority } from "./changeAuthorization"
import { blindHash, canonicalBlindJson, encodeBlindBytes } from "./blindClient"
import { ensureWorkspaceReplicaWriter } from "./workspaceReplicaWriter"
import { confirmRustyAttachmentCoverage } from "./attachmentCoverage"
import { createBlindReplica } from "./blindReplicaStore"
import { storeAttachment, blobDescriptor } from "../attachments"
import type { AttachmentCoverageStatus } from "./attachmentReplicationTypes"
import { MAX_ARCHIVE_PART_BYTES, writeArchiveBytes, readArchiveBytes, readArchiveIndex,
  type ArchiveObjectStore, type ArchiveTreeContext } from "@meta-uber/mesh-replication/history-archive"
import { openArchiveObject, type ArchiveEncryptionBinding, type EncryptedArchiveObject } from "@meta-uber/mesh-replication/history-archive-crypto"
import { createArchiveRemote } from "@meta-uber/mesh-replication/history-archive-remote"
import { createLocatedArchiveStore } from "@meta-uber/mesh-replication/history-archive-locators"
import { prepareArchiveLocators } from "@meta-uber/mesh-replication/history-archive-locator-preparation"
import { confirmArchiveCoverageSet, verifyCompleteArchiveCoverage } from "@meta-uber/mesh-replication/history-archive-coverage-set"
import type { HistoryPreparedObject } from "@meta-uber/mesh-replication/history-preparation-journal"
import { createDeviceAuthorizationRequest, createIdentityAuthorityView, createRecoverableIdentity,
  emptyIdentityProfileState, issueDeviceAuthorization, verifyDeviceCertificateChain, verifyEnvelope } from "@meta-uber/mesh-identity"
import { ensureRustyIdentityAuthorityPublished, ensureRustyWorkspaceScopeAuthority } from "./rustyIdentityTransport"
import { initializePersonalRootCatalog } from "../statePersonalRoot"
import { peerStore } from "./peerStore"
import { createWorkspaceHistoryPreparation } from "./historyPreparationRepository"
import { createReceivedHistoryBaselineRepository } from "./receivedHistoryBaselineRepository"
import { receiveBrowserHistoryBaseline, type BrowserHistoryBaselineReceivePorts } from "./browserHistoryBaselineReceive"
import { verifyReceivedWireHistoryBaseline } from "../product-replica/historyBaselineReceiver"
import { receiveWorkerHistoryBasis, restoreWorkerHistoryBasis, validateWorkerHistoryAuthority } from "../../workers/automation/src/historyBaseline"
import { readWorkspaceBasisSnapshot } from "../storageJournal"
import { readPublicBoardManagementState } from "../public/publicationClient"
import capturedHistory from "../../vendor/meta-mesh/packages/mesh-replication/fixtures/history-capture-v1.json"
import { bootstrapConfirmedIdentityFixture as bootstrapIdentity, confirmIdentityAuthorityFixture } from "./identityAuthority.testSupport"
import { publishRustyIdentityAuthorityView } from "@meta-uber/mesh-replication/rusty-identity-authority"
import { createRustyScopeEnrollmentClient, type RustyScopeEnrollmentJournal } from "@meta-uber/mesh-replication/rusty-scope-enrollment"
import { ReplicaEngine, emptyReplicaState } from "@meta-uber/mesh-replication/replica-engine"
import { publishRustyScopeAuthoritySnapshot, type ScopeAuthorityValidation } from "@meta-uber/mesh-replication/rusty-scope-authority"
import { registerRustyResourcePrincipalGrant, type RustyWorkspaceMembershipGrant } from "@meta-uber/mesh-replication/rusty-principal-grant"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, options: unknown, callback?: () => Promise<unknown>) =>
    callback ? callback() : (options as () => Promise<unknown>)() } })
})

let automergeReady: Promise<void> | undefined
function initializeNativeAutomerge(): Promise<void> {
  return automergeReady ??= readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
    .then(bytes => Automerge.initializeWasm(new Uint8Array(bytes)))
}

test("Given actual Rusty and an SDK authority snapshot missing serde defaults, When its authority is published and read again, Then Rust accepts the SDK hash, returns a receipt-only reply, and no-op read performs no PUT", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("SDK Rusty contract owner")
  await initializePersonalRootCatalog(defaultStorage, profile)
  const service = await startRusty(profile)
  try {
    const discovery = await discoverBlindKeeper(service.origin)
    await ensureRustyPersonPolicy(discovery, profile, true, { allowLegacyMigration: true })
    const workspaceId = crypto.randomUUID()
    const scopeId = `opaque-${crypto.randomUUID()}`
    const access = { origin: service.origin, servicePublicKey: discovery.servicePublicKey, scopeId,
      readToken: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
      writeToken: toBase64Url(crypto.getRandomValues(new Uint8Array(32))), policyRevision: 0 }
    access.policyRevision = await approveRustyScope(access, profile, false,
      { minimumWriterVersion: 2, scopePurpose: "workspace" })
    await initializeNativeAutomerge()
    const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(workspaceId, "SDK contract board", profile.identity.personId, "blank"))
    await recordGenesisAuthority(doc, profile)
    const stored = await peerStore.getWorkspaceAuthority(workspaceId)
    const full = (stored as { scopeAuthoritySnapshot?: { genesis?: unknown } } | null)?.scopeAuthoritySnapshot
    if (!full?.genesis) throw new Error("Workspace genesis authority was not persisted")
    const incomplete = { genesis: full.genesis }
    let authorityPuts = 0
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (init?.method === "PUT" && url.pathname === `/v2/scopes/${scopeId}/authority`) authorityPuts += 1
      return fetch(input, init)
    }
    const connection = { ...access, workspaceId }
    const first = await ensureRustyWorkspaceScopeAuthority(profile, connection, incomplete, () => {}, fetcher)
    expect(first.receipt).toMatchObject({ payload: { kind: "rusty-scope-authority-receipt" } })
    expect(first.snapshot).toMatchObject({ grants: [], grantIssuers: [], revocations: [], controlTransfers: [], successionTransfers: [] })
    expect(authorityPuts).toBe(1)
    const second = await ensureRustyWorkspaceScopeAuthority(profile, connection, incomplete, () => {}, fetcher)
    expect(second.receipt).toBeUndefined()
    expect(authorityPuts).toBe(1)
    Automerge.free(doc)
  } finally {
    await stopRusty(service.child)
    await rm(service.stateDirectory, { recursive: true, force: true })
  }
}, 45_000)

test("Given an unchanged grant from a former active same-person app device, when the current certified owner app registers it, then SDK and Rusty preserve write access under the current signer", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  resetIdentityStorageForTest()
  const owner = (await createRecoverableIdentity("better", "Native owner")).profile
  const formerApp = (await createRecoverableIdentity("better", "Former owner app")).profile
  const candidate = (await createRecoverableIdentity("better", "Current owner app")).profile
  const applicationOrigin = "https://boards.example"
  const challenge = "a".repeat(64)
  const expiresAt = Date.now() + 90_000
  const formerRequest = await createDeviceAuthorizationRequest(formerApp, { applicationOrigin, challenge, expiresAt })
  const formerCertificate = await issueDeviceAuthorization(owner, formerRequest, { applicationOrigin, challenge })
  const currentRequest = await createDeviceAuthorizationRequest(candidate, { applicationOrigin, challenge: "b".repeat(64), expiresAt })
  const currentCertificate = await issueDeviceAuthorization(owner, currentRequest, {
    applicationOrigin, challenge: "b".repeat(64),
  })
  const certificates = [owner.certificate, formerCertificate, currentCertificate]
  const authorityView = await createIdentityAuthorityView(owner.identity, { certificates, revocations: [] },
    emptyIdentityProfileState(owner.identity.personId))
  const service = await startRusty(owner)
  try {
    const discovery = await discoverBlindKeeper(service.origin)
    const workspaceId = crypto.randomUUID()
    const scopeId = `scope-${crypto.randomUUID()}`
    const readToken = toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const writeToken = toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const access = { origin: service.origin, servicePublicKey: discovery.servicePublicKey, scopeId, readToken, writeToken }
    const signOwner = <T extends { kind: string }>(payload: T) => signEnvelope(owner.privateKeys.devicePrivateKey!, payload,
      owner.device.deviceId, "MATCH/1")
    await publishRustyIdentityAuthorityView({ ...access, identity: owner.identity, deviceId: owner.device.deviceId,
      devicePublicKey: owner.device.publicKey, view: authorityView, signAuthorization: signOwner })
    const enrollmentJournal = createMemoryEnrollmentJournal()
    const enrollment = createRustyScopeEnrollmentClient({ scopePurpose: "workspace", access,
      identity: owner.identity, deviceId: owner.device.deviceId, devicePublicKey: owner.device.publicKey,
      certificates: [owner.certificate], ensureCurrent: () => {}, getManagementCapability: async () => undefined,
      ensureManagementCurrent: () => {}, signAuthorization: payload => signOwner(payload), journal: enrollmentJournal })
    await enrollment.enroll({ minimumWriterVersion: 2, allowLegacyUnmanagedScope: true })
    const scopeAuthoritySnapshot = { genesis: await signEnvelope(formerApp.privateKeys.devicePrivateKey!, {
      kind: "scope-genesis", version: 1, scopeId: workspaceId,
      creator: { personId: owner.identity.personId, publicKey: owner.identity.publicKey, certificates }, controlEpoch: 1,
    }, formerApp.device.deviceId, "MATCH/1"), grants: [], grantIssuers: [], revocations: [], controlTransfers: [], successionTransfers: [] }
    const validateSnapshot = (snapshot: unknown): ScopeAuthorityValidation => {
      const validated = meshRustRuntime().state.validateScopeAuthority(snapshot, Date.now()) as {
        scopeId: string; controller: { personId: string; publicKey: string }; controlEpoch: number
      }
      return { workspaceId: validated.scopeId, controllerPersonId: validated.controller.personId,
        controllerPublicKey: validated.controller.publicKey, controlEpoch: validated.controlEpoch, snapshot }
    }
    await publishRustyScopeAuthoritySnapshot({ ...access, workspaceId, identity: owner.identity, authorityView,
      deviceId: owner.device.deviceId, devicePublicKey: owner.device.publicKey, scopeAuthority: scopeAuthoritySnapshot,
      validateSnapshot, mergeSnapshots: (_current, incoming) => incoming, signAuthorization: signOwner })
    const recipient = (await createRecoverableIdentity("better", "Native editor")).profile
    const grantPayload = {
      kind: "workspace-grant", version: 1, grantId: crypto.randomUUID(), workspaceId,
      personId: recipient.identity.personId, role: "editor", accessEpoch: 7,
    } satisfies RustyWorkspaceMembershipGrant["payload"]
    const workspaceGrant = await signEnvelope(formerApp.privateKeys.devicePrivateKey!, grantPayload, formerApp.device.deviceId)
    const registered = await registerRustyResourcePrincipalGrant({ origin: access.origin, servicePublicKey: access.servicePublicKey,
      storageScopeId: access.scopeId, workspaceId, expectedScopeAuthoritySnapshot: scopeAuthoritySnapshot,
      identity: owner.identity, authorityView, deviceId: candidate.device.deviceId,
      devicePublicKey: candidate.device.publicKey, subjectIdentity: recipient.identity, workspaceGrant,
      readToken, writeToken, ensureCurrent: () => {}, validateSnapshot, signAuthorization: payload =>
        signEnvelope(candidate.privateKeys.devicePrivateKey!, payload, candidate.device.deviceId, "MATCH/1") })

    expect(registered.principalGrant.payload.workspaceGrant).toEqual(workspaceGrant)
    expect(registered.principalGrant.payload).toMatchObject({ ownerPersonId: owner.identity.personId,
      subjectPersonId: recipient.identity.personId, grantId: workspaceGrant.payload.grantId, policyEpoch: 7, actions: ["read", "write"] })
    expect(registered.principalGrant.signerKeyId).toBe(candidate.device.deviceId)
  } finally {
    await stopRusty(service.child)
    await rm(service.stateDirectory, { recursive: true, force: true })
  }
}, 90_000)

test("Given an owner with Rusty credentials but no local workspace ledger, when its replica pulls, then read the signed Rusty ledger without control-plane writes", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Remote workspace authority owner")
  const service = await startRusty(profile)
  const workspaceId = crypto.randomUUID()
  const access = { origin: service.origin, servicePublicKey: (await discoverBlindKeeper(service.origin)).servicePublicKey,
    scopeId: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    readToken: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    writeToken: toBase64Url(crypto.getRandomValues(new Uint8Array(32))), policyRevision: 0 }
  try {
    access.policyRevision = await approveRustyScope(access, profile, false, { minimumWriterVersion: 2, scopePurpose: "workspace" })
    const snapshot = {
      genesis: await signEnvelope(profile.privateKeys.devicePrivateKey!, {
        kind: "scope-genesis", version: 1, scopeId: workspaceId,
        creator: { personId: profile.identity.personId, publicKey: profile.identity.publicKey,
          certificates: [profile.certificate] }, controlEpoch: 1,
      }, profile.device.deviceId),
      grants: [], grantIssuers: [], revocations: [], controlTransfers: [], successionTransfers: [],
    }
    await ensureRustyWorkspaceScopeAuthority(profile, { ...access, workspaceId }, snapshot, () => {})
    expect(await peerStore.getWorkspaceAuthority(workspaceId)).toBeNull()
    expect(await peerStore.getWorkspaceCredential(workspaceId)).toBeNull()

    const config = { ...access, workspaceId, keyEpoch: 1,
      contentKey: toBase64Url(crypto.getRandomValues(new Uint8Array(32))), cursor: 0, lastUploaded: "" }
    await setReplicaPreference(profile.identity.personId, config)
    const selected = (await getReplicaConfigurations(profile.identity.personId)).find(value => value.workspaceId === workspaceId)!
    const app = { getCurrentProfile: () => profile, readWorkspaceBytes: async () => new Uint8Array(),
      readWorkspaceDoc: async () => undefined, mergeAuthorizedWorkspace: async () => {}, causalReviewError: { value: undefined } }
    const requests: Array<{ method: string; path: string }> = []
    const nativeFetch = globalThis.fetch
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url)
      requests.push({ method: (init?.method ?? "GET").toUpperCase(), path: requestUrl.pathname })
      return nativeFetch(input, init)
    })

    const replica = createBlindReplica(selected, app as never, () => {}, async () => {})
    await expect(replica.pull()).resolves.toBe(true)
    expect(requests.some(request => request.method === "GET" &&
      request.path === `/v2/scopes/${encodeURIComponent(access.scopeId)}/authority/status`)).toBe(true)
    expect(requests.some(request => request.method === "GET" &&
      request.path === `/v2/scopes/${encodeURIComponent(access.scopeId)}/objects`)).toBe(true)
    expect(requests.filter(request => request.method === "PUT")).toEqual([])
    expect(await peerStore.getWorkspaceAuthority(workspaceId)).toMatchObject({ ownerPersonId: profile.identity.personId,
      scopeAuthoritySnapshot: snapshot })
    expect(await peerStore.getWorkspaceCredential(workspaceId)).toBeNull()

    resetIdentityStorageForTest()
    const reader = await bootstrapIdentity("Different workspace identity")
    expect(reader.identity.personId).not.toBe(profile.identity.personId)
    await setReplicaPreference(reader.identity.personId, config)
    const readerConfig = (await getReplicaConfigurations(reader.identity.personId)).find(value => value.workspaceId === workspaceId)!
    const readerApp = { ...app, getCurrentProfile: () => reader }
    requests.length = 0
    const readerReplica = createBlindReplica(readerConfig, readerApp as never, () => {}, async () => {})
    await expect(readerReplica.pull()).rejects.toThrow(/current Identity/u)
    expect(requests.some(request => request.path === `/v2/scopes/${encodeURIComponent(access.scopeId)}/objects`)).toBe(false)
    expect(requests.filter(request => request.method === "PUT")).toEqual([])
  } finally {
    await stopRusty(service.child)
    await rm(service.stateDirectory, { recursive: true, force: true })
  }
}, 45_000)

afterEach(() => { resetIdentityStorageForTest(); vi.unstubAllGlobals() })

function createMemoryEnrollmentJournal(): RustyScopeEnrollmentJournal {
  const requests = new Map<string, string>()
  return {
    read: async binding => {
      const body = requests.get(binding.scopeId)
      return body === undefined ? undefined : { body }
    },
    prepare: async (binding, body) => { requests.set(binding.scopeId, body) },
    replace: async (binding, previousBody, nextBody) => {
      if (requests.get(binding.scopeId) !== previousBody) throw new Error("Enrollment retry journal changed")
      requests.set(binding.scopeId, nextBody)
    },
    complete: async (binding, body) => { requests.set(binding.scopeId, body) },
  }
}

async function unusedLoopbackPort(): Promise<number> {
  const listener = createServer()
  await new Promise<void>((resolveListen, reject) => {
    listener.once("error", reject)
    listener.listen(0, "127.0.0.1", () => resolveListen())
  })
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("Loopback listener did not expose a TCP port")
  const { port } = address
  await new Promise<void>((resolveClose, reject) => listener.close(error => error ? reject(error) : resolveClose()))
  return port
}

function verifyNativeArchive(input: unknown): Promise<unknown> {
  const binary = resolve(process.cwd(), process.env.TINCANBAN_HISTORY_VERIFY_BINARY ?? "vendor/meta-mesh/target/debug/examples/history_archive_verify")
  return new Promise((resolveVerified, reject) => {
    const child = execFile(binary, { timeout: 10_000, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`Native archive verification failed: ${stderr.trim() || error.message}`)); return }
      try { resolveVerified(JSON.parse(stdout)) } catch (error) { reject(error) }
    })
    child.stdin?.on("error", reject)
    child.stdin?.end(JSON.stringify(input))
  })
}

async function startRusty(profile: Awaited<ReturnType<typeof bootstrapIdentity>>,
  options: { port?: number; stateDirectory?: string; maxScopeBytes?: number } = {}) {
  const port = options.port ?? await unusedLoopbackPort()
  const stateDirectory = options.stateDirectory ?? await mkdtemp(resolve(tmpdir(), "tincanban-rusty-native-"))
  const origin = `http://127.0.0.1:${port}`
  const binary = resolve(process.cwd(), process.env.TINCANBAN_RUSTY_BINARY ?? "../mesh-lighthouse/target/debug/mesh-lighthouse")
  const child = spawn(binary, [stateDirectory, `127.0.0.1:${port}`], {
    env: {
      ...process.env,
      RUSTY_PUBLIC_ORIGIN: origin,
      RUSTY_LOG: "off",
      ...(options.maxScopeBytes === undefined ? {} : { RUSTY_MAX_SCOPE_BYTES: String(options.maxScopeBytes) }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  let spawnError: Error | undefined
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); output = output.slice(-8_000) })
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); output = output.slice(-8_000) })
  child.once("error", error => { spawnError = error })
  try {
    await waitForRusty(child, origin, () => output, () => spawnError)
    return { child, origin, stateDirectory, logs: () => output }
  } catch (error) {
    await stopRusty(child)
    if (!options.stateDirectory) await rm(stateDirectory, { recursive: true, force: true })
    throw error
  }
}

async function waitForRusty(child: ChildProcess, origin: string, output: () => string, spawnError: () => Error | undefined): Promise<void> {
  // The first health response hashes the complete cold debug executable.
  const startedAt = Date.now()
  const deadline = startedAt + 30_000
  let lastProbe = "No health probe completed"
  while (Date.now() < deadline) {
    if (spawnError()) throw new Error(`Unable to spawn Rusty: ${spawnError()?.message}`)
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Rusty exited during startup: ${output()}`)
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, deadline - Date.now()))) })
      if (response.ok) return
      lastProbe = `HTTP ${response.status} ${response.statusText}`.slice(0, 1_024)
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? `; cause: ${error.cause.name}: ${error.cause.message}` : ""
      lastProbe = `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}${cause}`.slice(0, 1_024)
    }
    await delay(Math.max(0, Math.min(40, deadline - Date.now())))
  }
  throw new Error(`Rusty did not become ready after ${Date.now() - startedAt}ms; last health probe: ${lastProbe}; child output: ${output()}`)
}

async function stopRusty(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  try { child.kill("SIGINT") } catch { /* Exit may race graceful shutdown. */ }
  if (!await waitForExit(child, 5_000)) {
    try { child.kill("SIGTERM") } catch { /* Escalate after the bounded grace period. */ }
    if (!await waitForExit(child, 2_000)) {
      try { child.kill("SIGKILL") } catch { /* Do not remove state unless exit is confirmed below. */ }
      if (!await waitForExit(child, 2_000)) throw new Error("Rusty process did not exit; preserving its state directory")
    }
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise(resolveExit => {
    const finish = (exited: boolean) => {
      clearTimeout(timer)
      child.removeListener("exit", onExit)
      resolveExit(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once("exit", onExit)
  })
}

test("Given original signed archive evidence and an uncertain upload, when Rusty and the sender restart, then a cold reader authenticates exact originals solely from encrypted archive storage", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  const profile = await bootstrapIdentity("Native archive owner")
  let service = await startRusty(profile)
  try {
    const discovery = await discoverBlindKeeper(service.origin)
    const access = { origin: service.origin, servicePublicKey: discovery.servicePublicKey, scopeId: `archive-${crypto.randomUUID()}`,
      readToken: toBase64Url(crypto.getRandomValues(new Uint8Array(32))), writeToken: toBase64Url(crypto.getRandomValues(new Uint8Array(32))), policyRevision: 0 }
    access.policyRevision = await approveRustyScope(access, profile, false, { minimumWriterVersion: 2 })
    const context = { workspaceId: crypto.randomUUID(), historyEpoch: 1, indexId: "original-proof-evidence" }
    const scope = { scopeId: access.scopeId, keyEpoch: 1, key: crypto.getRandomValues(new Uint8Array(32)) }
    await initializeNativeAutomerge()
    let sourceDoc = Automerge.from({ id: context.workspaceId, title: "Original basis" })
    sourceDoc = Automerge.change(sourceDoc, draft => { draft.title = "Signed pending original" })
    const originalChange = Automerge.getLastLocalChange(sourceDoc)!
    const decodedChange = Automerge.decodeChange(originalChange)
    expect(decodedChange.deps).toHaveLength(1)
    Automerge.free(sourceDoc)
    const signed = await signEnvelope(profile.privateKeys.devicePrivateKey, { kind: "workspace-changes", version: 1,
      workspaceId: context.workspaceId, personId: profile.identity.personId, deviceId: profile.device.deviceId, hashes: [decodedChange.hash] }, profile.device.deviceId)
    const sentinel = "PRIVATE-ARCHIVE-ORIGINAL-SENTINEL-842903"
    const original = new TextEncoder().encode(JSON.stringify({ signed, changeBytes: toBase64Url(originalChange), identity: profile.identity, certificates: [profile.certificate],
      classification: { type: "pending", reason: "Original dependencies not available" },
      unknownExtension: sentinel + "x".repeat(3 * 256 * 1024 + 37) }, null, 2))
    const objects = new Map<string, Uint8Array>()
    const local: ArchiveObjectStore = { read: async id => objects.get(id), write: async (id, bytes) => { objects.set(id, bytes.slice()) } }
    function* chunks() { for (let offset = 0; offset < original.length; offset += 64 * 1024) yield original.subarray(offset, offset + 64 * 1024) }
    const reference = await writeArchiveBytes(context, chunks(), local)
    const parts = (await readArchiveIndex(context, reference.root, local)).entries
    expect(new Set(parts.map(entry => entry.objectId)).size).toBeLessThan(parts.length)
    const preparationIdentity = { transitionId: crypto.randomUUID(), personId: profile.identity.personId,
      workspaceId: context.workspaceId, historyEpoch: context.historyEpoch, previousBaselineId: null,
      sourceRevision: await blindHash(original), authorityRevision: await blindHash(new TextEncoder().encode(canonicalBlindJson({
        identity: profile.identity, certificates: [profile.certificate] }))),
      privateBinding: await blindHash(new TextEncoder().encode(canonicalBlindJson({ ...access, key: toBase64Url(scope.key) }))),
      storage: { origin: access.origin, scopeId: access.scopeId, policyRevision: access.policyRevision,
        servicePublicKey: access.servicePublicKey, keyEpoch: 1, keyDigest: await blindHash(scope.key) } }
    const journal = createWorkspaceHistoryPreparation(preparationIdentity, () => {})
    await journal.capture(chunks())
    const plan: HistoryPreparedObject[] = []
    const prepare = async (plainId: string, partIndex: number) => {
      const bytes = objects.get(plainId)!
      const binding: ArchiveEncryptionBinding = { ...context, objectId: plainId, objectKind: partIndex < 0 ? "page" : "part",
        partIndex: partIndex < 0 ? 0 : partIndex, partCount: partIndex < 0 ? 1 : reference.partCount }
      plan.push(await journal.stage(scope, binding, bytes))
    }
    const partIds = new Set(parts.map(entry => entry.objectId))
    for (const plainId of objects.keys()) if (!partIds.has(plainId)) await prepare(plainId, -1)
    for (const [index, entry] of parts.entries()) await prepare(entry.objectId, index)
    const rootBinding = plan.find(item => item.binding.objectId === reference.root.objectId && item.binding.objectKind === "page")!.binding
    expect((await journal.archive(rootBinding)).phase).toBe("archived")
    let loseReply = true
    const fetcher: typeof fetch = async (...args) => {
      const response = await fetch(...args)
      if (loseReply && args[1]?.method === "PUT" && response.ok) {
        loseReply = false; await response.body?.cancel(); throw new Error("Archive receipt reply lost")
      }
      return response
    }
    const source = createArchiveRemote(access, { fetch: fetcher, ensureCurrent: () => {} })
    await expect(journal.cover(source)).rejects.toThrow("Archive receipt reply lost")
    objects.clear()
    const port = Number(new URL(service.origin).port), directory = service.stateDirectory
    await stopRusty(service.child)
    service = await startRusty(profile, { port, stateDirectory: directory })
    const reopened = createWorkspaceHistoryPreparation(preparationIdentity, () => {})
    const recovered: HistoryPreparedObject[] = []
    for await (const item of reopened.objects()) recovered.push(item)
    expect([...recovered].sort((left, right) => left.index - right.index)).toEqual(plan)
    const retainedSource: Uint8Array[] = []
    for await (const part of await reopened.readSource()) retainedSource.push(part)
    expect(new Uint8Array(Buffer.concat(retainedSource))).toEqual(original)
    const resumed = createArchiveRemote(access, { fetch, ensureCurrent: () => {} })
    const noEncryption = vi.spyOn(crypto.subtle, "encrypt").mockRejectedValue(new Error("Re-encryption after restart forbidden"))
    let covered: Awaited<ReturnType<typeof reopened.cover>>
    try { covered = await reopened.cover(resumed); expect(noEncryption).not.toHaveBeenCalled() }
    finally { noEncryption.mockRestore() }
    expect(covered.phase).toBe("covered")
    const rootCiphertextId = covered.root!.ciphertextId
    const expectedSet = recovered.map(item => ({ objectId: item.sealed.ciphertextId, keyEpoch: 1 }))
      .sort((left, right) => left.objectId < right.objectId ? -1 : 1)
    const complete = covered.coverage!
    expect(complete.payload).toMatchObject({ objectCount: recovered.length, rootCovered: true })
    expect(await verifyCompleteArchiveCoverage(complete, access, rootCiphertextId, expectedSet)).toMatchObject({ objectCount: recovered.length })
    const subset = await confirmArchiveCoverageSet(access, rootCiphertextId, "native-archive-subset-0001",
      expectedSet.filter(entry => entry.objectId === rootCiphertextId), { ...resumed, ensureCurrent: () => {} })
    await expect(verifyCompleteArchiveCoverage(subset, access, rootCiphertextId, expectedSet)).rejects.toThrow()
    expect((await inventoryBlindObjects(access, 0)).objects).toEqual([])
    const downloads = vi.fn(fetch)
    const recipient = createArchiveRemote({ ...access, writeToken: "recipient-cannot-upload" }, { fetch: downloads, ensureCurrent: () => {} })
    const cold: ArchiveObjectStore = { write: async () => { throw new Error("Cold read tried publishing") }, read: async (id, maximum, binding) => {
      const item = recovered.find(value => value.binding.objectId === id && canonicalBlindJson(value.binding) === canonicalBlindJson({ ...binding, objectId: id }))!
      if (!item) throw new Error("Missing private archive locator")
      const ciphertext = await recipient.download(item.sealed.ciphertextId)
      const bytes = await openArchiveObject(scope, item.binding, item.sealed.ciphertextId, ciphertext)
      if (bytes.length > maximum) throw new Error("Archive read limit exceeded")
      return bytes
    } }
    const restoredParts: Uint8Array[] = []
    for await (const part of await readArchiveBytes(context, reference, cold)) restoredParts.push(part)
    const restored = new Uint8Array(restoredParts.reduce((sum, bytes) => sum + bytes.length, 0))
    let offset = 0
    for (const part of restoredParts) { restored.set(part, offset); offset += part.length }
    expect(restored).toEqual(original)
    expect(downloads).toHaveBeenCalledTimes(recovered.length)
    const retained = JSON.parse(new TextDecoder().decode(restored))
    const authorKey = await verifyDeviceCertificateChain(retained.identity, retained.signed.signerKeyId, retained.certificates)
    expect(await verifyEnvelope(retained.signed, authorKey)).toBe(true)
    expect(retained.signed).toEqual(signed)
    const retainedChange = Automerge.decodeChange(decodeBlindBytes(retained.changeBytes))
    expect(retained.signed.payload.hashes).toEqual([retainedChange.hash])
    expect(retainedChange.deps).toEqual(decodedChange.deps)
    expect(retained.classification.type).toBe("pending")
    const filenames = await readdir(resolve(directory, "scopes", access.scopeId, "archives"))
    expect(filenames).toHaveLength(recovered.length)
    for (const filename of filenames) {
      const persisted = await readFile(resolve(directory, "scopes", access.scopeId, "archives", filename), "utf8")
      expect(persisted).not.toContain(sentinel)
      expect(persisted).not.toContain(context.workspaceId)
      expect(persisted).not.toContain(access.readToken)
    }
  } finally {
    await stopRusty(service.child)
    await rm(service.stateDirectory, { recursive: true, force: true })
    vi.unstubAllGlobals()
  }
}, 30_000)

async function appShapedNativeHistory(signer: CryptoKey) {
  const workspaceId = capturedHistory.catalogue.context.workspaceId
  const templateProof = JSON.parse(new TextDecoder().decode(decodeBlindBytes(capturedHistory.originals.authorizations[0])))
  const deviceId = templateProof.signed.signerKeyId
  const createProof = async (hashes: string[]) => ({
    signed: await signEnvelope(signer, { kind: "workspace-changes", version: 1, workspaceId, hashes,
      personId: capturedHistory.expected.personId, deviceId }, deviceId),
    publicKey: templateProof.publicKey, certificates: templateProof.certificates, grant: null,
  })
  const seed: WorkspaceDocumentV2 = { kind: "workspace", formatVersion: 3, id: workspaceId,
    title: "Native history fixture", archivedAt: null, ownerPersonId: capturedHistory.expected.personId,
    entities: {}, migration: null }
  const base = Automerge.from(seed)
  let fork: Automerge.Doc<WorkspaceDocumentV2> | undefined
  try {
    const baseHashes = Automerge.getAllChanges(base).map(change => Automerge.decodeChange(change).hash)
    const admittedProof = await createProof(baseHashes)
    const quarantined = Automerge.change(base, draft => { draft.title = "Unsigned overwrite remains quarantined" })
    fork = Automerge.clone(quarantined)
    const missing = Automerge.change(fork, draft => { Object.assign(draft, { missing: "This dependency is deliberately absent" }) })
    const pending = Automerge.change(missing, draft => { Object.assign(draft, { pending: "Keep compressed original unchanged. ".repeat(500) }) })
    const pendingBytes = Automerge.getLastLocalChange(pending)!
    const pendingHash = Automerge.decodeChange(pendingBytes).hash
    const pendingProof = await createProof([pendingHash])
    return {
      ...capturedHistory,
      originals: {
        ...capturedHistory.originals,
        document: encodeBlindBytes(Automerge.save(quarantined)),
        authorizations: [encodeBlindBytes(new TextEncoder().encode(canonicalizeJson(admittedProof))),
          encodeBlindBytes(new TextEncoder().encode(canonicalizeJson(pendingProof)))],
        pending: [encodeBlindBytes(pendingBytes)],
      },
      expected: { ...capturedHistory.expected, admittedHash: baseHashes.at(-1)!, pendingHash,
        nodeCount: fixtureStateNodeCount(seed) },
    }
  } finally {
    if (fork) Automerge.free(fork)
    Automerge.free(base)
  }
}

function fixtureStateNodeCount(value: unknown): number {
  if (Array.isArray(value)) return 1 + value.reduce<number>((total, child) => total + fixtureStateNodeCount(child), 0)
  if (value !== null && typeof value === "object")
    return 1 + Object.values(value).reduce<number>((total, child) => total + fixtureStateNodeCount(child), 0)
  return 1
}

function deriveCurrentNativeCatalogue(scope: { scopeId: string; keyEpoch: number; key: Uint8Array }, transitionId: string,
  fixture: Awaited<ReturnType<typeof appShapedNativeHistory>>) {
  const controlJson = decodeBlindBytes(fixture.originals.control)
  const control = JSON.parse(new TextDecoder().decode(controlJson))
  const authorizationJson = fixture.originals.authorizations.map(decodeBlindBytes)
  const records = authorizationJson.map(bytes => JSON.parse(new TextDecoder().decode(bytes)))
  const signer = { personId: fixture.expected.personId, deviceId: records[0].signed.signerKeyId,
    certificates: records[0].certificates }
  const source = { snapshot: { ...control, document: decodeBlindBytes(fixture.originals.document) }, records,
    pendingChangeBytes: fixture.originals.pending.map(decodeBlindBytes), nowMs: 0 }
  expect(() => WasmStateCore.prepareWorkspaceHistory({ ...source, claimedOwner: true }, signer)).toThrow(/unknown field/i)
  expect(() => WasmStateCore.prepareWorkspaceHistory({ ...source, snapshot: { ...source.snapshot, claimedOwner: true } }, signer)).toThrow(/unknown field/i)
  expect(() => WasmStateCore.prepareWorkspaceHistory({ ...source, snapshot: { ...source.snapshot, document: [256] } }, signer)).toThrow()
  const preparation = WasmStateCore.prepareWorkspaceHistory(source, signer)
  type Capture = ReturnType<typeof preparation.captureOriginals>
  let capture: Capture | undefined
  let rebase: ReturnType<Capture["rebase"]> | undefined
  try {
    capture = preparation.captureOriginals(fixture.catalogue.context.historyEpoch, controlJson, authorizationJson)
    const objects: Array<{ ciphertextId: string; binding: ArchiveEncryptionBinding; object: EncryptedArchiveObject }> = []
    const catalogue = capture.writeEncryptedCatalogue(scope.scopeId, scope.keyEpoch, scope.key,
      () => crypto.getRandomValues(new Uint8Array(12)),
      (ciphertextId: string, binding: ArchiveEncryptionBinding, object: EncryptedArchiveObject) => {
        objects.push({ ciphertextId, binding: structuredClone(binding), object: structuredClone(object) })
      }, () => {}) as typeof fixture.catalogue
    // Exercise the production Native-to-browser sink ABI, including its plaintext content address.
    expect(objects.length).toBeGreaterThan(0)
    expect(objects.every(entry => /^[A-Za-z0-9_-]{43}$/.test(entry.binding.objectId))).toBe(true)
    rebase = capture.rebase(catalogue.context.historyEpoch, transitionId)
    let released = false
    return { catalogue, objects, document: rebase.document(), capture, rebase,
      dispose() {
        if (released) return
        released = true
        rebase!.free()
        capture!.free()
        preparation.free()
      } }
  } catch (error) {
    rebase?.free()
    capture?.free()
    preparation.free()
    throw error
  }
}

test("Given a Native-derived original-history catalogue, when data and locator coverage survive Rusty restart, then Native binds the admitted basis to real receipts and a cold HTTP reader recovers originals without the sender journal", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  await initializeNativeAutomerge()
  const productHistory = structuredClone(capturedHistory)
  const originalSigner = JSON.parse(new TextDecoder().decode(decodeBlindBytes(productHistory.originals.authorizations[0])))
  // Generated public fixture seed; never send a signing key to the Native adapter.
  const fixtureKey = new Uint8Array(48)
  fixtureKey.set([48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32])
  fixtureKey.fill(152, 16)
  const signer = await crypto.subtle.importKey("pkcs8", fixtureKey, { name: "Ed25519" }, false, ["sign"])
  // Add the product routing ID on an admitted branch; retain the generic SDK history verbatim.
  const originalDocument = Automerge.load<{ id?: string; title: string }>(decodeBlindBytes(productHistory.originals.document))
  const originalChanges = Automerge.getAllChanges(originalDocument)
  const admittedBranch = Automerge.clone(Automerge.view(originalDocument, [productHistory.expected.admittedHash]), { actor: "9a".repeat(16) })
  const routedBranch = Automerge.change(admittedBranch, draft => { draft.id = productHistory.catalogue.context.workspaceId })
  const routedChange = Automerge.getLastLocalChange(routedBranch)!
  const routedHash = Automerge.decodeChange(routedChange).hash
  const routedAuthorization = { signed: await signEnvelope(signer, { kind: "workspace-changes", version: 1,
    workspaceId: productHistory.catalogue.context.workspaceId, personId: productHistory.expected.personId,
    deviceId: originalSigner.signed.signerKeyId, hashes: [routedHash] }, originalSigner.signed.signerKeyId),
    publicKey: productHistory.expected.publicKey, certificates: originalSigner.certificates }
  const routedDocument = Automerge.merge(originalDocument, routedBranch)
  try {
    const retained = Automerge.getAllChanges(routedDocument)
    for (const original of originalChanges) expect(retained.some(change => Buffer.from(change).equals(Buffer.from(original)))).toBe(true)
    productHistory.originals.document = encodeBlindBytes(Automerge.save(routedDocument))
    productHistory.originals.authorizations.push(encodeBlindBytes(new TextEncoder().encode(canonicalBlindJson(routedAuthorization))))
  } finally { Automerge.free(routedDocument); Automerge.free(routedBranch) }
  expect(productHistory.originals.pending).toEqual(capturedHistory.originals.pending)
  expect(productHistory.originals.authorizations.slice(0, 2)).toEqual(capturedHistory.originals.authorizations)
  const profile = await bootstrapIdentity("Native catalogue storage owner")
  let service = await startRusty(profile)
  let releaseCurrent = () => {}
  try {
    const discovery = await discoverBlindKeeper(service.origin)
    const access = { origin: service.origin, servicePublicKey: discovery.servicePublicKey, scopeId: `capture-${crypto.randomUUID()}`,
      readToken: toBase64Url(crypto.getRandomValues(new Uint8Array(32))), writeToken: toBase64Url(crypto.getRandomValues(new Uint8Array(32))), policyRevision: 0 }
    access.policyRevision = await approveRustyScope(access, profile, false, { minimumWriterVersion: 2 })
    const scope = { scopeId: access.scopeId, keyEpoch: 1, key: crypto.getRandomValues(new Uint8Array(32)) }
    const transitionId = crypto.randomUUID()
    await initializeNativeAutomerge()
    const fixtureKey = new Uint8Array(48)
    fixtureKey.set([48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32])
    fixtureKey.fill(152, 16)
    const signer = await crypto.subtle.importKey("pkcs8", fixtureKey, { name: "Ed25519" }, false, ["sign"])
    const historyFixture = await appShapedNativeHistory(signer)
    const current = deriveCurrentNativeCatalogue(scope, transitionId, historyFixture)
    releaseCurrent = current.dispose
    const context = current.catalogue.context
    const identity = { transitionId, personId: profile.identity.personId, workspaceId: context.workspaceId, historyEpoch: context.historyEpoch,
      sourceRevision: current.catalogue.captureRevision, authorityRevision: current.catalogue.authorityRevision,
      privateBinding: await blindHash(new TextEncoder().encode(canonicalBlindJson({ ...access, key: toBase64Url(scope.key) }))), previousBaselineId: null,
      storage: { origin: access.origin, scopeId: access.scopeId, policyRevision: access.policyRevision, servicePublicKey: access.servicePublicKey, keyEpoch: 1, keyDigest: await blindHash(scope.key) } }
    const journal = createWorkspaceHistoryPreparation(identity, () => {})
    await journal.capture([new TextEncoder().encode(canonicalBlindJson(historyFixture.originals))])
    for (const entry of current.objects) await journal.stageSealed(scope, entry.binding, { ciphertextId: entry.ciphertextId, object: entry.object })
    const rootBinding = { ...context, objectId: current.catalogue.root.objectId, objectKind: "page" as const, partIndex: 0, partCount: 1 }
    await journal.archive(rootBinding)
    const covered = await journal.cover(createArchiveRemote(access, { fetch, ensureCurrent: () => {} }))
    expect(covered.phase).toBe("covered")
    const directoryIdentity = { ...identity, transitionId: crypto.randomUUID() }
    const directory = createWorkspaceHistoryPreparation(directoryIdentity, () => {})
    const prepared = await prepareArchiveLocators({ data: journal, directory,
      scope, remote: createArchiveRemote(access, { fetch, ensureCurrent: () => {} }), ensureCurrent: () => {} })
    expect(prepared.directory.phase).toBe("covered")
    expect(prepared.root.root.count).toBe(covered.objectCount)
    const archiveIds: string[] = []
    for (const source of [journal, directory]) for await (const object of source.objects()) archiveIds.push(object.sealed.ciphertextId)
    await stopRusty(service.child)
    service = await startRusty(profile, { port: Number(new URL(service.origin).port), stateDirectory: service.stateDirectory })
    for (const source of [journal, directory]) for (const method of ["read", "readSource", "objects", "locators"] as const) {
      vi.spyOn(source, method).mockImplementation(() => { throw new Error("Sender journal unavailable") })
    }
    const recipient = createArchiveRemote({ ...access, writeToken: "recipient-cannot-upload" }, { fetch, ensureCurrent: () => {} })
    const objects = []
    for (const ciphertextId of archiveIds) objects.push({ ciphertextId, object: await recipient.download(ciphertextId) })
    const originalSigner = JSON.parse(new TextDecoder().decode(decodeBlindBytes(historyFixture.originals.authorizations[0])))
    // Generated public fixture seed; never send a signing key to the Native adapter.
    const control = JSON.parse(new TextDecoder().decode(decodeBlindBytes(historyFixture.originals.control)))
    const scopeAuthoritySnapshot = { genesis: await signEnvelope(signer, { kind: "scope-genesis", version: 1,
      scopeId: context.workspaceId, creator: { personId: control.genesisOwner.personId,
        publicKey: control.genesisOwner.publicKey, certificates: originalSigner.certificates }, controlEpoch: 1 }, originalSigner.signed.signerKeyId),
      grants: [], grantIssuers: [], revocations: [], controlTransfers: [], successionTransfers: [] }
    const nativeInput = { originals: historyFixture.originals, historyEpoch: context.historyEpoch, proposeInitialBaseline: true,
      signer: { personId: historyFixture.expected.personId, deviceId: originalSigner.signed.signerKeyId, certificates: originalSigner.certificates },
      scope: { ...scope, key: toBase64Url(scope.key) }, locatorRoot: prepared.root,
      authority: { servicePublicKey: access.servicePublicKey, scopeId: access.scopeId, policyRevision: access.policyRevision },
      dataTransitionId: identity.transitionId, directoryTransitionId: directoryIdentity.transitionId,
      dataReceipt: JSON.stringify(covered.coverage), directoryReceipt: JSON.stringify(prepared.directory.coverage), objects,
      scopeAuthority: scopeAuthoritySnapshot }
    const verified = await verifyNativeArchive(nativeInput) as { ownerProposal: { kind: string; baselineId: string }; ownerAttestation: null; basis: { byteLength: number } }
    expect(verified).toEqual({ kind: "verified-history-archive-coverage", version: 1,
      catalogueRoot: current.catalogue.root, locatorRoot: prepared.root, captureRevision: current.catalogue.captureRevision,
      authorityRevision: current.catalogue.authorityRevision, dataObjectCount: covered.objectCount, directoryObjectCount: prepared.directory.objectCount,
      basis: { historyEpoch: context.historyEpoch, transitionId: identity.transitionId, nodeCount: historyFixture.expected.nodeCount, changeCount: 1,
        stateDigest: current.rebase.stateDigest(), documentDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        genesisHash: expect.stringMatching(/^[0-9a-f]{64}$/), byteLength: expect.any(Number) },
      ownerProposal: expect.objectContaining({ kind: "workspace-history-baseline", version: 2,
        scopeAuthority: scopeAuthoritySnapshot, scopeControlEpoch: 1, currentControl: expect.objectContaining({ workspaceId: context.workspaceId }),
        historyEpoch: 1, previousBaselineId: null, authorityRevision: current.catalogue.authorityRevision,
        archive: current.catalogue, locatorRoot: prepared.root }), ownerAttestation: null })
    expect(verified.basis.byteLength).toBeLessThan(2048)
    const trustedScopeAuthority = validateWorkerHistoryAuthority(scopeAuthoritySnapshot, context.workspaceId)
    const basisContext: ArchiveTreeContext = { workspaceId: context.workspaceId, historyEpoch: context.historyEpoch, indexId: "basis-document" }
    const basisIdentity = { ...identity, transitionId: `${transitionId}-basis-data`,
      sourceRevision: await blindHash(current.document) }
    const basisData = createWorkspaceHistoryPreparation(basisIdentity, () => {})
    await basisData.capture([current.document])
    let partIndex = 0
    const partCount = Math.ceil(current.document.byteLength / MAX_ARCHIVE_PART_BYTES)
    const compactStore: ArchiveObjectStore = {
      async read() { return undefined },
      async write(objectId, bytes) {
        let page = false
        try {
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
          page = Boolean(value && typeof value === "object" && !Array.isArray(value) &&
            (value as Record<string, unknown>).kind === "workspace-history-index-page")
        } catch { /* Binary archive parts are not index pages. */ }
        const binding: ArchiveEncryptionBinding = { ...basisContext, objectId,
          objectKind: page ? "page" : "part", partIndex: page ? 0 : partIndex++, partCount: page ? 1 : partCount }
        await basisData.stage(scope, binding, bytes)
      },
    }
    const basisReference = await writeArchiveBytes(basisContext, [current.document], compactStore)
    let basisRootBinding: ArchiveEncryptionBinding | undefined
    for await (const item of basisData.objects()) {
      if (item.binding.objectId === basisReference.root.objectId) basisRootBinding = item.binding
    }
    if (!basisRootBinding) throw new Error("Compact history basis root was not staged")
    await basisData.archive(basisRootBinding)
    const preparationRemote = createArchiveRemote(access, { fetch, ensureCurrent: () => {} })
    await basisData.cover(preparationRemote)
    const basisDirectory = createWorkspaceHistoryPreparation({ ...basisIdentity, transitionId: `${transitionId}-basis-directory` }, () => {})
    const basisLocators = await prepareArchiveLocators({ data: basisData, directory: basisDirectory, scope,
      remote: preparationRemote, ensureCurrent: () => {} })
    const basisCoverageObjects: Array<{ objectId: string; keyEpoch: number }> = []
    for (const source of [basisData, basisDirectory]) {
      for await (const item of source.objects()) basisCoverageObjects.push({ objectId: item.sealed.ciphertextId, keyEpoch: scope.keyEpoch })
    }
    basisCoverageObjects.sort((left, right) => left.objectId < right.objectId ? -1 : left.objectId > right.objectId ? 1 : 0)
    const basisCoverage = await confirmArchiveCoverageSet(nativeInput.authority, basisLocators.root.root.ciphertextId,
      `${transitionId}-basis-set`, basisCoverageObjects, { coverage: preparationRemote.coverage,
        aggregate: preparationRemote.aggregate, ensureCurrent: () => {} })
    const encryptedObjects = new Map(objects.map(entry => [entry.ciphertextId, entry.object]))
    const verifiedStorage = current.capture.verifyStorageDirectory(scope.scopeId, scope.keyEpoch, scope.key,
      prepared.root, encryptedObjects, () => {})
    let proposalCoverage: WasmVerifiedHistoryArchiveCoverage | undefined
    let ownerProposal: { kind: string; baselineId: string; [key: string]: unknown }
    try {
      proposalCoverage = verifiedStorage.verifyCoverage(nativeInput.authority, identity.transitionId,
        directoryIdentity.transitionId, new TextEncoder().encode(canonicalizeJson(covered.coverage)),
        new TextEncoder().encode(canonicalizeJson(prepared.directory.coverage)))
      ownerProposal = current.capture.ownerAttestedProposal(current.rebase, proposalCoverage, trustedScopeAuthority)
    } finally {
      proposalCoverage?.free()
      verifiedStorage.free()
    }
    const signedBaseline = await signEnvelope(signer, ownerProposal, nativeInput.signer.deviceId, "MESH-HISTORY/1")
    const signedBaselineBytes = new TextEncoder().encode(canonicalBlindJson(signedBaseline))
    const wire = { version: 1 as const, signedJson: encodeBlindBytes(signedBaselineBytes),
      basis: { context: basisContext, reference: basisReference, locatorRoot: basisLocators.root, coverage: basisCoverage } }
    const receiveConfig = { ...access, workspaceId: context.workspaceId, keyEpoch: scope.keyEpoch,
      contentKey: toBase64Url(scope.key), cursor: 0, lastUploaded: "", minimumWriterVersion: 2 as const }
    const signedNativeBaseline = await signEnvelope(signer, verified.ownerProposal, nativeInput.signer.deviceId, "MESH-HISTORY/1")
    expect(await verifyNativeArchive({ ...nativeInput, signedBaseline: JSON.stringify(signedNativeBaseline) })).toEqual({ ...verified,
      ownerAttestation: { baselineId: verified.ownerProposal.baselineId, historyEpoch: 1, deviceId: nativeInput.signer.deviceId } })
    if (process.env.TINCANBAN_PRIOR_READER_PROBE === "1") {
      const probe = await new Promise<string>((resolveProbe, reject) => {
        const child = execFile(process.execPath, ["scripts/check-prior-history-reader.mjs"], { timeout: 20_000 }, (error, stdout, stderr) => {
          if (error) reject(new Error(`Prior released reader probe failed: ${stderr || error.message}`))
          else resolveProbe(stdout)
        })
        child.stdin?.end(JSON.stringify({ originals: historyFixture.originals, admittedHash: historyFixture.expected.admittedHash,
          compactDocument: toBase64Url(current.document), signedBaseline: JSON.stringify(signedBaseline) }))
      })
      expect(JSON.parse(probe)).toMatchObject({ nativeHistoryAPI: "absent", originalHistory: "admitted-and-retained",
        version2Receive: "rejected-before-merge-and-cursor" })
      console.info("Prior released reader evidence", probe.trim())
    }
    // Cold cursors retain pre-compaction snapshots; acknowledge only exact archived originals.
    const retainedObjects = new Map(objects.map(entry => [entry.ciphertextId, entry.object]))
    const received = WasmStateCore.verifyOwnerAttestedHistoryBaseline(new TextEncoder().encode(JSON.stringify(signedBaseline)),
      current.document, scope.scopeId, scope.keyEpoch, scope.key, nativeInput.authority, trustedScopeAuthority, retainedObjects, () => {})
    try {
      const originalBytes = decodeBlindBytes(historyFixture.originals.document)
      expect(() => received.verifyArchivedSnapshot(scope.scopeId, scope.keyEpoch, scope.key,
        originalBytes, retainedObjects, () => {})).not.toThrow()
      expect(() => received.verifyArchivedSnapshot(scope.scopeId, scope.keyEpoch, scope.key,
        current.document, retainedObjects, () => {})).toThrow()
      expect(() => received.verifyArchivedSnapshot(scope.scopeId, scope.keyEpoch, scope.key,
        originalBytes, new Map(), () => {})).toThrow()
      expect(() => received.verifyArchivedSnapshot(scope.scopeId, scope.keyEpoch, scope.key,
        originalBytes, retainedObjects, () => { throw new Error("Session replaced") })).toThrow()
      expect(() => received.verifyPreviousBaseline(received)).toThrow(/predecessor/)
      expect(received.document()).toEqual(current.document)

      const receiveFetch = { ensureCurrent: async () => {}, download: recipient.download }
      const workerReceived = await receiveWorkerHistoryBasis({ wire, workspaceId: context.workspaceId, config: receiveConfig,
        trustedScopeAuthority, fetch: receiveFetch, guard: async () => {}, ensureCurrent: () => {} })
      try {
        expect(workerReceived.stored.wire).toEqual(wire)
        expect(decodeBlindBytes(workerReceived.stored.document)).toEqual(current.document)
        const restoredWorkerBasis = await restoreWorkerHistoryBasis(workerReceived.stored, context.workspaceId,
          receiveConfig, trustedScopeAuthority, async () => {}, () => {})
        try {
          expect(restoredWorkerBasis.originalJson()).toEqual(signedBaselineBytes)
          expect(restoredWorkerBasis.document()).toEqual(current.document)
        } finally { restoredWorkerBasis.free() }
      } finally { workerReceived.basis.free() }

      // The browser adapter receives the same published wire through the production Native verifier and durable repository.
      vi.stubGlobal("indexedDB", new IDBFactory())
      const browserRepository = createReceivedHistoryBaselineRepository(context.workspaceId, () => {})
      const browserOriginalBytes = decodeBlindBytes(historyFixture.originals.document)
      const originalDoc = Automerge.load<WorkspaceDocumentV2>(browserOriginalBytes)
      const browserHeads = Automerge.getHeads(originalDoc).sort()
      const browserRoute = { ensureCurrent: async () => {}, download: recipient.download }
      const browserPorts: BrowserHistoryBaselineReceivePorts = {
        repository: browserRepository,
        workspaceTransaction: <T>(operation: (transaction: WorkspaceTransactionContext) => Promise<T>) =>
          defaultStorage.withWorkspaceTransaction(context.workspaceId, transaction => operation(transaction)),
        ensureCurrent: () => {},
        readLocal: async () => ({ bytes: browserOriginalBytes, heads: browserHeads, revision: undefined,
          catalogRevision: "native-history-fixture", pending: false }),
        verify: ({ wire: receivedWire, previous, fetch: archiveFetch }) => verifyReceivedWireHistoryBaseline({ wire: receivedWire,
            scope, pinnedStorage: nativeInput.authority, previous, fetch: archiveFetch, ensureCurrent: () => {}, trustedScopeAuthority }),
        coversHeads: async (candidate: typeof received) => candidate.verifyArchivedSnapshot(scope.scopeId, scope.keyEpoch,
          scope.key, browserOriginalBytes, retainedObjects, () => {}),
        readExpectedSnapshot: async () => (await readWorkspaceBasisSnapshot(context.workspaceId)) ?? null,
        accept: async (candidate: typeof received) => browserRepository.recordActiveWireRoute(ownerProposal.baselineId,
          candidate.originalJson(), wire),
        merge: async (document: Uint8Array, authorization: unknown, candidate: typeof received) => {
          expect(document).toEqual(current.document)
          expect(authorization).toEqual(historyFixture.originals.authorizations)
          expect(candidate.document()).toEqual(current.document)
        },
      }
      try {
        await receiveBrowserHistoryBaseline({ workspaceId: context.workspaceId, config: receiveConfig, wire,
        document: current.document, authorization: historyFixture.originals.authorizations,
          trustedScopeAuthority, fetch: browserRoute, ports: browserPorts })
        expect((await browserRepository.readActive())?.baselineId).toBe(ownerProposal.baselineId)
        expect((await browserRepository.readArchiveRecord())?.wire).toEqual(wire)
      } finally { Automerge.free(originalDoc) }
    } finally { received.free() }
    await expect(verifyNativeArchive({ ...nativeInput, scopeAuthority: undefined })).rejects.toThrow(/requires signed scope authority/)
    await expect(verifyNativeArchive({ ...nativeInput, scopeAuthority: { ...scopeAuthoritySnapshot,
      genesis: await signEnvelope(signer, { kind: "scope-genesis", version: 1, scopeId: "unrelated", creator: {
        personId: control.genesisOwner.personId, publicKey: control.genesisOwner.publicKey,
        certificates: originalSigner.certificates }, controlEpoch: 1 }, nativeInput.signer.deviceId) } })).rejects.toThrow(/controller does not match/)
    const wrongDomain = await signEnvelope(signer, verified.ownerProposal, nativeInput.signer.deviceId, "MATCH/1")
    await expect(verifyNativeArchive({ ...nativeInput, signedBaseline: JSON.stringify(wrongDomain) })).rejects.toThrow(/signature/)
    await expect(verifyNativeArchive({ ...nativeInput, directoryReceipt: nativeInput.dataReceipt })).rejects.toThrow(/exact Native set and preparation/)
    const cold = createLocatedArchiveStore(scope, prepared.root, { download: recipient.download, ensureCurrent: () => {} })
    const readOriginal = async (key: string, indexId: string) => {
      const entry = (await readArchiveIndex(context, current.catalogue.root, cold, { prefix: key })).entries.find(entry => entry.key === key)!
      const reference = JSON.parse(new TextDecoder().decode(await cold.read(entry.objectId, 64 * 1024, { ...context, objectKind: "record", partIndex: 0, partCount: 1 })))
      const parts: Uint8Array[] = []
      for await (const part of await readArchiveBytes({ ...context, indexId }, reference, cold)) parts.push(part)
      return new Uint8Array(Buffer.concat(parts))
    }
    const original = await readOriginal("pending/0000000000000000", "source-pending/0000000000000000")
    expect(original).toEqual(decodeBlindBytes(historyFixture.originals.pending[0]))
    const decoded = Automerge.decodeChange(original)
    expect(decoded.hash).toBe(historyFixture.expected.pendingHash)
    expect(decoded.deps).toHaveLength(1)
    const originalProof = await readOriginal("proof/0000000000000001", "source-proof/0000000000000001")
    expect(originalProof).toEqual(decodeBlindBytes(historyFixture.originals.authorizations[1]))
    const proof = JSON.parse(new TextDecoder().decode(originalProof))
    const archivedControl = JSON.parse(new TextDecoder().decode(await readOriginal("control", "source-control")))
    expect(archivedControl.genesisOwner.publicKey).toBe(historyFixture.expected.publicKey)
    const authorKey = await verifyDeviceCertificateChain({ ...archivedControl.genesisOwner, displayName: "" }, proof.signed.signerKeyId, proof.certificates)
    expect(await verifyEnvelope(proof.signed, authorKey)).toBe(true)
    expect(proof.signed.payload.hashes).toEqual([decoded.hash])
    for (const source of [journal, directory]) for (const method of ["read", "readSource", "objects", "locators"] as const) expect(source[method]).not.toHaveBeenCalled()
  } finally {
    releaseCurrent()
    await stopRusty(service.child); await rm(service.stateDirectory, { recursive: true, force: true }); vi.unstubAllGlobals()
  }
}, 30_000)

test("Given an admitted file and a private Rusty connection, when ordinary replication runs, then background upload confirms discoverable coverage before the source is needed again", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  const profile = await bootstrapIdentity("Automatic attachment owner")
  const service = await startRusty(profile)
  let workspace: Automerge.Doc<WorkspaceDocumentV2> | undefined
  try {
    await initializeNativeAutomerge()
    const discovery = await discoverBlindKeeper(service.origin)
    const bytes = new Uint8Array(256 * 1024 + 19).fill(67)
    const descriptor = await createBlobDescriptor(bytes, "automatic-private-file.txt", "text/plain")
    const seed = createWorkspaceDoc(crypto.randomUUID(), "Automatic files", profile.identity.personId, "blank")
    const board = Object.values(seed.entities).find(entity => entity.kind === "board")!
    seed.entities.file = { id: "file", kind: "document", title: "Automatic file", documentKind: "attachment", format: "file", content: null,
      placement: { parentId: board.id, rank: "0/1" }, archivedAt: null, createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z",
      file: { type: "blob", sha256: descriptor.blobId.slice(7), byteLength: descriptor.size, mimeType: descriptor.mediaType, fileName: descriptor.name } }
    workspace = Automerge.from(seed)
    const document = workspace
    await recordGenesisAuthority(document, profile)
    const reference = await storeAttachment(new File([bytes], descriptor.name, { type: descriptor.mediaType }))
    expect(blobDescriptor(reference)).toEqual(descriptor)
    const access = { origin: service.origin, servicePublicKey: discovery.servicePublicKey, scopeId: `auto-${crypto.randomUUID()}`,
      readToken: toBase64Url(crypto.getRandomValues(new Uint8Array(32))), writeToken: toBase64Url(crypto.getRandomValues(new Uint8Array(32))), policyRevision: 0 }
    access.policyRevision = await approveRustyScope(access, profile, false, { minimumWriterVersion: 2 })
    const config = { ...access, workspaceId: document.id, keyEpoch: 1, minimumWriterVersion: 2 as const,
      contentKey: toBase64Url(crypto.getRandomValues(new Uint8Array(32))), cursor: 0, lastUploaded: "" }
    await setReplicaPreference(profile.identity.personId, config)
    const selected = (await getReplicaConfigurations(profile.identity.personId)).find(value => value.workspaceId === document.id)!
    const app = { getCurrentProfile: () => profile, readWorkspaceDoc: async () => document,
      readWorkspaceBytes: async () => Automerge.save(document), mergeAuthorizedWorkspace: async () => {},
      causalReviewError: { value: undefined } }
    let states: AttachmentCoverageStatus[] = []
    const replica = createBlindReplica(selected, app as never, () => {}, async () => {}, next => { states = next })
    await replica.sync()
    await vi.waitFor(() => expect(states[0]).toMatchObject({ phase: "complete", label: "Complete on Rusty" }), { timeout: 10_000 })
    const inventory = await inventoryBlindObjects(access, 0)
    const latest = inventory.objects.at(-1)!
    const stored = await downloadBlindObject(access, latest.objectId)
    const snapshot = JSON.parse(new TextDecoder().decode(await decryptBlindObject(stored, config.scopeId, config.keyEpoch, decodeBlindBytes(config.contentKey))))
    expect(snapshot.attachments).toHaveLength(1)
    expect(snapshot.attachments[0].blobId).toBe(descriptor.blobId)
    const sourceUnavailable = vi.fn(async () => { throw new Error("Source closed") })
    expect(await fetchRustyAttachment(app as never, document.id, descriptor, () => {}, sourceUnavailable)).toEqual(bytes)
    expect(sourceUnavailable).not.toHaveBeenCalled()
  } finally {
    await stopRusty(service.child)
    if (workspace) Automerge.free(workspace)
    await rm(service.stateDirectory, { recursive: true, force: true })
    vi.unstubAllGlobals()
  }
}, 30_000)

test("Given encrypted attachment chunks and a lost response, when Rusty and the transfer restart, then a cold recipient reads verified bytes without source access or plaintext server storage", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Native attachment owner")
  let service = await startRusty(profile)
  try {
    const discovery = await discoverBlindKeeper(service.origin)
    expect(discovery.encryptedBlobs).toEqual({ version: 1, maximumCiphertextBytes: 1048592 })
    expect(discovery.writerPolicy).toEqual({ version: 1, maximumWriterVersion: 2 })
    expect(discovery.blobCoverage).toEqual({ version: 1, maximumObjects: 33 })
    const access = { origin: service.origin, servicePublicKey: discovery.servicePublicKey,
      scopeId: `blob-${crypto.randomUUID()}`, readToken: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
      writeToken: toBase64Url(crypto.getRandomValues(new Uint8Array(32))), policyRevision: 0 }
    access.policyRevision = await approveRustyScope(access, profile, false, { minimumWriterVersion: 2 })
    const workspaceId = crypto.randomUUID()
    const scope = { workspaceId, scopeId: access.scopeId, keyEpoch: 1,
      contentKey: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) }
    const sentinel = "PRIVATE-ATTACHMENT-SENTINEL-UNIQUE-7421"
    const bytes = new Uint8Array(256 * 1024 + 37).fill(81)
    bytes.set(new TextEncoder().encode(sentinel))
    const descriptor = await createBlobDescriptor(bytes, "private-candidate-letter.txt", "text/plain")
    const source = createAttachmentRepository(`native-sender:${crypto.randomUUID()}`, () => {})
    const attempts: Array<{ object: unknown; requestId: string }> = []
    let loseResponse = true
    const transport = { download: downloadBlindBlob, upload: async (...args: Parameters<typeof uploadBlindBlob>) => {
      attempts.push({ object: structuredClone(args[1]), requestId: args[2] })
      const receipt = await uploadBlindBlob(...args)
      if (loseResponse) { loseResponse = false; throw new Error("Response lost after durable commit") }
      return receipt
    } }
    await expect(new AttachmentTransfer(scope, access, source, async () => {}, transport).upload(descriptor, bytes))
      .rejects.toThrow("Response lost after durable commit")
    expect((await source.read())?.receipts).toEqual({})
    const restartPort = Number(new URL(service.origin).port)
    const directory = service.stateDirectory
    await stopRusty(service.child)
    service = await startRusty(profile, { port: restartPort, stateDirectory: directory })
    const locator = await new AttachmentTransfer(scope, access, source, async () => {}, transport).upload(descriptor)
    expect(attempts[1]).toEqual(attempts[0])
    expect(await inventoryBlindObjects(access, 0)).toMatchObject({ objects: [], cursor: 0 })
    const proof = await confirmRustyAttachmentCoverage(scope, { ...access, writeToken: "" }, descriptor, locator, async () => {})
    expect(proof.payload.objects).toHaveLength(3)
    expect(proof.payload.objects.map(object => object.objectId).sort())
      .toEqual((await source.read())!.objects.map(object => object.objectId).sort())
    const recipient = createAttachmentRepository(`native-recipient:${crypto.randomUUID()}`, () => {})
    const received = await new AttachmentTransfer(scope, access, recipient, async () => {}, {
      upload: async () => { throw new Error("Source device unavailable") }, download: downloadBlindBlob,
    }).download(descriptor, locator)
    expect(received).toEqual(bytes)
    expect((await recipient.read())?.received).toHaveLength(3)

    await initializeNativeAutomerge()
    const seed = createWorkspaceDoc(workspaceId, "Attachment board", profile.identity.personId, "blank")
    const board = Object.values(seed.entities).find(entity => entity.kind === "board")
    if (!board) throw new Error("Native attachment board fixture has no board")
    const now = new Date().toISOString()
    seed.entities["native-attachment"] = { id: "native-attachment", kind: "document", title: "Private attachment",
      documentKind: "attachment", format: "file", content: null,
      placement: { parentId: board.id, rank: "0/1" }, archivedAt: null, createdAt: now, updatedAt: now,
      file: { type: "blob", sha256: descriptor.blobId.slice("sha256:".length), byteLength: descriptor.size,
        mimeType: descriptor.mediaType, fileName: descriptor.name } }
    const workspace = Automerge.from<WorkspaceDocumentV2>(seed)
    await recordGenesisAuthority(workspace, profile)
    const app = { getCurrentProfile: () => profile, readWorkspaceDoc: async (id: string) => {
      if (id !== workspaceId) throw new Error("Unexpected native workspace read")
      return workspace
    } }
    const connection = { ...access, purpose: "workspace" as const, workspaceId, keyEpoch: scope.keyEpoch,
      contentKey: scope.contentKey, cursor: 0, lastUploaded: "" }
    await setReplicaPreference(profile.identity.personId, connection)
    const selected = (await getReplicaConfigurations(profile.identity.personId)).find(value => value.workspaceId === workspaceId)
    if (!selected) throw new Error("Native attachment connection was not retained")
    const binding = privateReplicaBinding(profile.identity.personId, selected)
    const indexKey = `tincanban.attachment-index.v1.${await blindHash(new TextEncoder().encode(binding))}`
    await createAttachmentIndexRepository(binding, () => {}).merge([locator])
    const peer = vi.fn(async () => { throw new Error("Source device unavailable") })
    expect(await fetchRustyAttachment(app as never, workspaceId, descriptor, () => {}, peer)).toEqual(bytes)
    expect(peer).not.toHaveBeenCalled()

    const plaintextForbidden = [sentinel, descriptor.name, descriptor.blobId.slice(7), scope.contentKey, access.readToken, access.writeToken]
    const files = await readdir(service.stateDirectory, { recursive: true, withFileTypes: true })
    for (const entry of files) {
      if (!entry.isFile()) continue
      const stored = await readFile(resolve(entry.parentPath, entry.name), "utf8")
      for (const secret of plaintextForbidden) expect(stored).not.toContain(secret)
    }
    for (const secret of plaintextForbidden) expect(service.logs()).not.toContain(secret)
    const transferStorageId = await blindHash(new TextEncoder().encode(canonicalBlindJson(["download", binding, descriptor, locator])))
    const transferHash = await blindHash(new TextEncoder().encode(transferStorageId))
    const transferStateKey = `tincanban.attachment-transfer.v1.${transferHash}`
    await Promise.all((await listLocalKeys()).filter(key => key === transferStateKey ||
      key.startsWith(`tincanban.attachment-object.v1.${transferHash}.`)).map(deleteLocal))
    const coldTransfer = createAttachmentRepository(transferStorageId, () => {})
    expect(await coldTransfer.read()).toBeNull()
    expect(await coldTransfer.object(locator.manifestId)).toBeNull()
    await approveRustyScope(access, profile, true)
    await expect(confirmRustyAttachmentCoverage(scope, { ...access, writeToken: "" }, descriptor, locator, async () => {}))
      .rejects.toMatchObject({ status: 403 })
    let revokedFetchBytes: Uint8Array | undefined
    let revokedFetchError: unknown
    try { revokedFetchBytes = await fetchRustyAttachment(app as never, workspaceId, descriptor, () => {}) }
    catch (cause) { revokedFetchError = cause }
    expect(revokedFetchError).toBeInstanceOf(AggregateError)
    expect(revokedFetchBytes).toBeUndefined()
    const revoked = createAttachmentRepository(`native-revoked:${crypto.randomUUID()}`, () => {})
    await expect(new AttachmentTransfer(scope, access, revoked, async () => {}).download(descriptor, locator))
      .rejects.toMatchObject({ status: 403 })
    expect(await revoked.read()).toBeNull()
    await setReplicaPreference(profile.identity.personId, selected, true)
    await deleteLocal(indexKey)
    Automerge.free(workspace)
  } finally {
    await stopRusty(service.child)
    await rm(service.stateDirectory, { recursive: true, force: true })
  }
}, 30_000)

test("Given a native Rusty HTTP service, when the owner migrates, enrolls and checkpoints a scope, then clients verify signed policy revisions", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Native Rusty owner")
  const process = await startRusty(profile)
  try {
    const discovery = await discoverBlindKeeper(process.origin)
    expect(discovery.scopeManagement).toBe(1)
    expect(discovery.snapshotCheckpoints).toBe(1)
    const binding = {
      origin: discovery.origin,
      servicePublicKey: discovery.servicePublicKey,
      resourceKind: "scope" as const,
      resourceId: `scope-${crypto.randomUUID()}`,
    }
    expect(decodeBlindBytes(binding.servicePublicKey)).toHaveLength(32)
    expect(binding.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(binding.resourceId).toMatch(/^[A-Za-z0-9_-]{1,128}$/)

    const initial = await readRustyManagementStatus(binding, profile)
    expect(initial).toMatchObject({ capability: null, revision: 0, migrationPending: false })
    const firstCapability = await updateRustyManagementPolicy(binding, profile, {
      operations: ["management.update", "scope.policy", "snapshot.checkpoint"],
      revokedDeviceIds: [],
    })
    expect(firstCapability.payload.revision).toBe(1)

    const access = {
      origin: binding.origin,
      servicePublicKey: binding.servicePublicKey,
      scopeId: binding.resourceId,
      readToken: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
      writeToken: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
      policyRevision: 0,
    }
    access.policyRevision = await approveRustyScope(access, profile)
    expect(access.policyRevision).toBe(1)

    const contentKey = crypto.getRandomValues(new Uint8Array(32))
    const firstObject = await encryptBlindObject(access.scopeId, 1, contentKey, new TextEncoder().encode("admitted encrypted snapshot"))
    const uploadReceipt = await uploadBlindObject(access, firstObject)
    expect(uploadReceipt.payload.sequence).toBe(1)
    const inventory = await inventoryBlindObjects(access, 0)
    expect(inventory).toMatchObject({ cursor: 1, maxSequence: 1, objectCount: 1 })

    const checkpointObject = await encryptBlindObject(access.scopeId, 1, contentKey, new TextEncoder().encode("complete admitted checkpoint"))
    const checkpointRequest = await prepareBlindCheckpoint(access, checkpointObject, inventory.maxSequence ?? inventory.cursor, profile)
    expect(checkpointRequest.authorization.payload.managementRevision).toBe(1)
    const checkpointReceipt = await submitBlindCheckpoint(access, checkpointRequest)
    expect(checkpointReceipt.payload).toMatchObject({ sequence: 2, supersedesThrough: 1, policyRevision: 1 })
    // A reader may retain the valid inventory reply while another owner commits compaction.
    let progress = { ...emptyReplicaState<typeof firstObject>("interrupted-reader"), pending: {
      requestId: "uncertain-local-request", hash: "local-hash", bytes: 1, object: firstObject, observedSequence: 0,
    } }
    const original = structuredClone(progress)
    let staleInventory = true
    const admitted = vi.fn(async (object: typeof firstObject) => {
      expect(new TextDecoder().decode(await decryptBlindObject(object, access.scopeId, 1, contentKey)))
        .toBe("complete admitted checkpoint")
      return { hash: await blindHash(new TextEncoder().encode("complete admitted checkpoint")) }
    })
    const reader = new ReplicaEngine("interrupted-reader", {
      repository: { read: async () => structuredClone(progress), commit: async (expected, next) => {
        expect(expected).toBe(progress.generation)
        progress = structuredClone(next) as typeof progress
      } },
      content: { revision: async () => "local", capture: async () => { throw new Error("Preserve original outbox") },
        seal: async () => firstObject },
      transport: { inventory: async after => {
        if (staleInventory) { staleInventory = false; return inventory }
        return inventoryBlindObjects(access, after)
      }, download: id => downloadBlindObject(access, id), upload: async () => { throw new Error("Pull must not replace outbox") } },
      admit: admitted, verifyReceipt: async () => {}, guard: async () => {},
    })
    await expect(reader.pull()).rejects.toMatchObject({ status: 403, message: "Object unavailable" })
    expect(progress).toEqual(original)
    expect(admitted).not.toHaveBeenCalled()
    await expect(reader.pull()).resolves.toBe(true)
    expect(progress).toMatchObject({ cursor: 2, pending: original.pending, lastUploaded: "" })
    expect(admitted).toHaveBeenCalledOnce()
    const compactedInventory = await inventoryBlindObjects(access, 0)
    expect(compactedInventory).toMatchObject({ cursor: 2, maxSequence: 2, objectCount: 1 })

    const restrictedCapability = await updateRustyManagementPolicy(binding, profile, {
      operations: ["management.update", "scope.policy"],
      revokedDeviceIds: [],
    })
    expect(restrictedCapability.payload).toMatchObject({ revision: 2, operations: ["management.update", "scope.policy"] })
    const nextCheckpoint = await encryptBlindObject(access.scopeId, 1, contentKey, new TextEncoder().encode("checkpoint after removal"))
    await expect(prepareBlindCheckpoint(access, nextCheckpoint, compactedInventory.cursor, profile))
      .rejects.toThrow(/operation|authorize|rights/i)
  } finally {
    await stopRusty(process.child)
    await rm(process.stateDirectory, { recursive: true, force: true })
  }
}, 20_000)

test("Given a floor-1 workspace scope, when its owner completes the real writer upgrade, then progress survives and Rusty requires writer v2", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Native writer upgrade owner")
  const process = await startRusty(profile)
  let workspace: Automerge.Doc<WorkspaceDocumentV2> | undefined
  try {
    await initializeNativeAutomerge()
    const discovery = await discoverBlindKeeper(process.origin)
    expect(discovery.writerPolicy).toEqual({ version: 1, maximumWriterVersion: 2 })
    const workspaceId = crypto.randomUUID()
    const seed = createWorkspaceDoc(workspaceId, "Writer upgrade board", profile.identity.personId, "blank")
    workspace = Automerge.from<WorkspaceDocumentV2>(seed)
    await recordGenesisAuthority(workspace, profile)
    const access = { origin: discovery.origin, servicePublicKey: discovery.servicePublicKey,
      scopeId: `writer-${crypto.randomUUID()}`, readToken: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
      writeToken: toBase64Url(crypto.getRandomValues(new Uint8Array(32))), policyRevision: 0 }
    access.policyRevision = await approveRustyScope(access, profile, false, { scopePurpose: "workspace" })
    expect(access.policyRevision).toBe(1)

    const contentKey = crypto.getRandomValues(new Uint8Array(32))
    const admittedObject = await encryptBlindObject(access.scopeId, 1, contentKey, new TextEncoder().encode("legacy admitted snapshot"))
    const admittedId = await blindObjectId(admittedObject)
    const legacyReceipt = await uploadBlindObject(access, admittedObject)
    expect(legacyReceipt.payload.sequence).toBe(1)

    await setReplicaPreference(profile.identity.personId, { ...access, workspaceId, keyEpoch: 1,
      contentKey: toBase64Url(contentKey), cursor: legacyReceipt.payload.sequence, lastUploaded: admittedId })
    const config = (await getReplicaConfigurations(profile.identity.personId))[0]
    if (!config) throw new Error("Native writer upgrade configuration was not saved")
    const before = await getPrivateReplicaProgress(profile.identity.personId, config)
    await persistPrivateReplicaState(profile.identity.personId, config, before.generation, {
      ...before, generation: before.generation + 1, cursor: 1, lastUploaded: admittedId,
    })
    expect(await getPrivateReplicaProgress(profile.identity.personId, config)).toMatchObject({ cursor: 1, lastUploaded: admittedId })
    const app = { getCurrentProfile: () => profile, readWorkspaceDoc: async (id: string) => {
      if (id !== workspaceId) throw new Error("Unexpected native workspace read")
      return workspace!
    } }
    const wireBodies: string[] = []
    const send = globalThis.fetch.bind(globalThis)
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (typeof input === "string" && input.startsWith(access.origin) && typeof init?.body === "string") wireBodies.push(init.body)
      return send(input, init)
    })
    const upgraded = await ensureWorkspaceReplicaWriter(app as never, config, () => {})
    expect(upgraded).toMatchObject({ minimumWriterVersion: 2, policyRevision: 2, cursor: 1, lastUploaded: admittedId })
    expect((await exportPrivateReplicaState(profile.identity.personId)).entries[0]?.operations[0]?.config)
      .toMatchObject({ minimumWriterVersion: 2, policyRevision: 2 })
    expect(await getPrivateReplicaProgress(profile.identity.personId, upgraded)).toMatchObject({ cursor: 1, lastUploaded: admittedId })
    expect(await inventoryBlindObjects({ ...access, policyRevision: upgraded.policyRevision }, 0))
      .toMatchObject({ cursor: 1, objectCount: 1 })

    const nextObject = await encryptBlindObject(access.scopeId, 1, contentKey, new TextEncoder().encode("new writer object"))
    const nextId = await blindObjectId(nextObject)
    const rejectedLegacyWrite = await fetch(`${access.origin}/v2/scopes/${access.scopeId}/objects/${nextId}`, {
      method: "PUT", headers: { Authorization: `Bearer ${access.writeToken}`, "Content-Type": "application/json",
        "X-Rusty-Request-Id": crypto.randomUUID() },
      body: JSON.stringify(nextObject),
    })
    expect(rejectedLegacyWrite.status).toBe(426)
    const receipt = await uploadBlindObject({ ...access, policyRevision: upgraded.policyRevision }, nextObject)
    expect(receipt.payload).toMatchObject({ sequence: 2, policyRevision: upgraded.policyRevision })
    expect(wireBodies.every(body => !body.includes("contentKey") && !body.includes(toBase64Url(contentKey)))).toBe(true)
  } finally {
    if (workspace) Automerge.free(workspace)
    await stopRusty(process.child)
    await rm(process.stateDirectory, { recursive: true, force: true })
  }
}, 20_000)

test("Given an approved person policy, when Rusty restarts and an independent owner device creates a scope, then the browser client needs no primary device or its ancestry", async () => {
  resetIdentityStorageForTest()
  const owner = await bootstrapIdentity("Person policy owner")
  let process = await startRusty(owner)
  try {
    const discovery = await discoverBlindKeeper(process.origin)
    expect(discovery.personManagement).toBe(1)
    const person = await ensureRustyPersonPolicy(discovery, owner, true, { allowLegacyMigration: true })
    expect(person?.payload.kind).toBe("rusty-person-management-capability")
    const port = Number(new URL(process.origin).port), stateDirectory = process.stateDirectory
    await stopRusty(process.child)
    process = await startRusty(owner, { port, stateDirectory })

    resetIdentityStorageForTest()
    const fresh = await bootstrapRawIdentity("Independent owner device")
    if (!owner.privateKeys.identityPrivateKey) throw new Error("Fixture owner has no root key")
    const certificate = await signEnvelope(owner.privateKeys.identityPrivateKey, { kind: "device-certificate" as const, version: 1 as const,
      personId: owner.identity.personId, deviceId: fresh.device.deviceId, devicePublicKey: fresh.device.publicKey,
      issuerCertificateHash: null, canEnrollDevices: true }, owner.identity.personId)
    await defaultProofStore.putCertificate(await certHashDefault(certificate), certificate)
    await adoptEnrolledIdentity(owner.identity, certificate)
    const independent = await bootstrapRawIdentity()
    expect(independent.privateKeys.identityPrivateKey).toBeUndefined()
    expect(independent.certificate.payload.issuerCertificateHash).toBeNull()
    await confirmIdentityAuthorityFixture(createPersonalRoot(independent, await certHashDefault(certificate)), [owner.certificate, certificate])
    const confirmed = await ensureRustyPersonPolicy(discovery, independent, true)
    expect(confirmed).toEqual(person)

    const binding = { origin: discovery.origin, servicePublicKey: discovery.servicePublicKey,
      resourceKind: "scope" as const, resourceId: `independent-${crypto.randomUUID()}` }
    const cap = await updateRustyManagementPolicy(binding, independent, { operations: ["management.update", "scope.policy", "snapshot.checkpoint"], revokedDeviceIds: [] })
    expect(cap.payload).toMatchObject({ resourceKind: "scope", resourceId: binding.resourceId, revision: 1 })
    const access = { origin: binding.origin, servicePublicKey: binding.servicePublicKey, scopeId: binding.resourceId,
      readToken: toBase64Url(crypto.getRandomValues(new Uint8Array(32))), writeToken: toBase64Url(crypto.getRandomValues(new Uint8Array(32))), policyRevision: 1 }
    expect(await approveRustyScope(access, independent)).toBe(1)
    expect(await inventoryBlindObjects(access, 0)).toMatchObject({ objects: [], cursor: 0 })
  } finally {
    await stopRusty(process.child)
    await rm(process.stateDirectory, { recursive: true, force: true })
  }
}, 20_000)

test("Given eight Identity snapshots exhaust Rusty's quota, when a checkpoint reply is lost and Rusty restarts, then recover the pending upload and cold-restore the complete signed profile", async () => {
  resetIdentityStorageForTest()
  const owner = await bootstrapIdentity("Identity checkpoint owner")
  let service = await startRusty(owner)
  const originalFetch = globalThis.fetch
  try {
    const discovery = await discoverBlindKeeper(service.origin)
    await ensureRustyPersonPolicy(discovery, owner, true, { allowLegacyMigration: true })
    const config = await ensureIdentityReplicaConnection(discovery, owner, () => {})
    const emptyRoot = createPersonalRoot(owner, await certHashDefault(owner.certificate))
    await defaultStorage.savePersonalRoot(emptyRoot)
    const photo = await saveIdentityPhoto(owner, "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA")
    await createIdentityRecovery()
    const expectedRecovery = await exportIdentityRecoveryEvidence(owner.identity.personId)
    expect(expectedRecovery.envelopes).toHaveLength(1)
    const portable = await createIdentityDeviceTransfer((await defaultStorage.loadPersonalRoot())!, [owner.certificate])
    portable.components.futureSettings = { schema: "future-settings@1", required: false, value: { marker: "Retain opaque state" } }
    await applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(portable, owner.identity.personId), () => {})
    const expectedExtensions = await exportIdentityDeviceExtensions(owner.identity.personId)
    const source = createIdentityReplica(config, owner, () => {})
    const workspaceIds: string[] = []
    for (let index = 0; index < 8; index++) {
      const root = (await defaultStorage.loadPersonalRoot())!
      const id = crypto.randomUUID()
      workspaceIds.push(id)
      registerWorkspaceInRoot(root, id, id, "genesis")
      await defaultStorage.savePersonalRoot(root)
      await source.push()
    }
    expect(await inventoryBlindObjects(config, 0)).toMatchObject({ objectCount: 8 })
    const objectsDirectory = resolve(service.stateDirectory, "scopes", config.scopeId, "objects")
    const stored = await Promise.all((await readdir(objectsDirectory)).map(name => readFile(resolve(objectsDirectory, name))))
    const maxScopeBytes = stored.reduce((total, bytes) => total + bytes.length, 1024)
    await stopRusty(service.child)
    service = await startRusty(owner, { port: Number(new URL(service.origin).port), stateDirectory: service.stateDirectory, maxScopeBytes })
    const expectedProfile = (await defaultStorage.loadPersonalRoot())!.profileState
    let checkpointAttempts = 0
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      const response = await originalFetch(input, init)
      if (init?.method === "POST" && path.endsWith("/checkpoint")) {
        checkpointAttempts++
        if (checkpointAttempts === 1 && response.ok) throw new TypeError("Checkpoint reply lost")
      }
      return response
    })
    const root = (await defaultStorage.loadPersonalRoot())!
    const pendingWorkspace = crypto.randomUUID()
    workspaceIds.push(pendingWorkspace)
    registerWorkspaceInRoot(root, pendingWorkspace, pendingWorkspace, "genesis")
    await defaultStorage.savePersonalRoot(root)
    await expect(source.push()).rejects.toThrow("Storage capacity exceeded")
    const pending = (await getPrivateReplicaProgress(owner.identity.personId, config)).pending
    expect(pending).toBeDefined()
    await deleteLocal("tincanban.identity_recovery.v1")
    await deleteLocal(`tincanban.identity-recovery-evidence.v1.${owner.identity.personId}`)
    await createIdentityReplica(config, owner, () => {}, { includeRecoveryEvidence: false }).pull()
    expect((await getPrivateReplicaProgress(owner.identity.personId, config)).cursor).toBe(8)
    expect((await exportIdentityRecoveryEvidence(owner.identity.personId)).envelopes).toEqual([])
    await expect(source.sync()).rejects.toThrow("Checkpoint reply lost")
    expect(await exportIdentityRecoveryEvidence(owner.identity.personId)).toEqual(expectedRecovery)
    expect((await getPrivateReplicaProgress(owner.identity.personId, config)).pending).toEqual(pending)
    expect(await inventoryBlindObjects(config, 0)).toMatchObject({ objectCount: 1, maxSequence: 9 })
    vi.stubGlobal("fetch", originalFetch)
    await stopRusty(service.child)
    service = await startRusty(owner, { port: Number(new URL(service.origin).port), stateDirectory: service.stateDirectory, maxScopeBytes })
    await createIdentityReplica(config, owner, () => {}).sync()
    expect((await getPrivateReplicaProgress(owner.identity.personId, config)).pending).toBeUndefined()
    expect((await inventoryBlindObjects(config, 0)).objectCount).toBeLessThanOrEqual(2)
    const preferences = await exportPrivateReplicaState(owner.identity.personId)
    await deleteLocal(`tincanban.private-replica-state.v2.${owner.identity.personId}`)
    await receivePrivateReplicaState(owner.identity.personId, preferences)
    await defaultStorage.savePersonalRoot(emptyRoot)
    await deleteLocal(`tincanban.identity-device-extensions.v1.${owner.identity.personId}`)
    await deleteLocal(`tincanban.identity-recovery-evidence.v1.${owner.identity.personId}`)
    const restoredConfig = (await getIdentityReplicaConfigurations(owner.identity.personId))[0]!
    expect(await createIdentityReplica(restoredConfig, owner, () => {}).pull()).toBe(true)
    const restored = (await defaultStorage.loadPersonalRoot())!
    expect(restored.photo).toEqual(photo)
    expect(restored.profileState).toEqual(expectedProfile)
    expect(Object.keys(restored.workspaces).sort()).toEqual(workspaceIds.sort())
    expect(await exportIdentityDeviceExtensions(owner.identity.personId)).toEqual(expectedExtensions)
    expect(await exportIdentityRecoveryEvidence(owner.identity.personId)).toEqual(expectedRecovery)
  } finally {
    vi.stubGlobal("fetch", originalFetch)
    await stopRusty(service.child)
    await rm(service.stateDirectory, { recursive: true, force: true })
  }
}, 60_000)

test("Given a cold enrolled device without its workspace, when its identity-scoped replica pulls from native Rusty, then restore photo, opaque components and original signed profiles without source capture", async () => {
  resetIdentityStorageForTest()
  const owner = await bootstrapIdentity("Native Rusty identity owner")
  const process = await startRusty(owner)
  try {
    const discovery = await discoverBlindKeeper(process.origin)
    await ensureRustyPersonPolicy(discovery, owner, true, { allowLegacyMigration: true })
    const sourceConfig = await ensureIdentityReplicaConnection(discovery, owner, () => {})
    expect(sourceConfig).toMatchObject({ purpose: "identity", personId: owner.identity.personId, policyRevision: 1 })
    expect(await ensureIdentityReplicaConnection(discovery, owner, () => {})).toEqual(sourceConfig)

    const ownerRoot = createPersonalRoot(owner, await certHashDefault(owner.certificate))
    const unknownWorkspaceId = crypto.randomUUID()
    registerWorkspaceInRoot(ownerRoot, unknownWorkspaceId, unknownWorkspaceId, "genesis")
    const legacyPhoto = { avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA", changedAt: "2099-10-13T08:00:00.000Z" }
    ownerRoot.photo = legacyPhoto
    await defaultStorage.savePersonalRoot(ownerRoot)
    const olderRoot = structuredClone(ownerRoot)
    const latestPhoto = await saveIdentityPhoto(owner, legacyPhoto.avatarData)
    const sourceRoot = (await defaultStorage.loadPersonalRoot(ownerRoot.rootId))!
    const portable = await createIdentityDeviceTransfer(sourceRoot, [owner.certificate])
    const sourceProfileState = (portable.components.profileObservations.value as { observations: Array<{ profileState: unknown }> }).observations[0].profileState
    const signedSourceState = await readIdentityProfileState(sourceProfileState, owner.identity)
    expect(signedSourceState.operations).toHaveLength(1)
    expect(identityProfileValue(signedSourceState, "photo")).toMatchObject({ status: "value", values: [latestPhoto] })
    const extension = { schema: "future-native-settings@1", required: false, value: { marker: "private opaque native state" } }
    portable.components.futureSettings = extension
    const originalProfile = await createChatRecord(owner, [owner.certificate], { publicKey: owner.identity.publicKey,
      certificates: [owner.certificate] }, `${owner.identity.personId}:native-board`, "chat-profile", "Native profile", 3)
    const observations = portable.components.profileObservations.value.observations as unknown[]
    observations.push({ kind: "workspace-profile", workspaceId: unknownWorkspaceId, record: originalProfile })
    await applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(portable, owner.identity.personId), () => {})
    const source = createIdentityReplica(sourceConfig, owner, () => {})
    expect(await source.sync()).toBe(true)

    const portablePreferences = await exportPrivateReplicaState(owner.identity.personId)
    const portableCapabilities = await new RustyManagementRepository(owner.identity.personId).export()
    expect(portablePreferences.entries[0].operations[0].config).toMatchObject({ purpose: "identity", personId: owner.identity.personId })
    expect(JSON.stringify(portablePreferences)).not.toContain('"progress"')

    resetIdentityStorageForTest()
    const temporaryRecipient = await bootstrapRawIdentity("Enrolled native recipient")
    const ownerCertificateHash = await certHashDefault(owner.certificate)
    const recipientCertificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
      owner.identity.personId, temporaryRecipient.device.deviceId, temporaryRecipient.device.publicKey, ownerCertificateHash)
    await defaultProofStore.putCertificate(ownerCertificateHash, owner.certificate)
    await defaultProofStore.putCertificate(await certHashDefault(recipientCertificate), recipientCertificate)
    await adoptEnrolledIdentity(owner.identity, recipientCertificate)
    const recipient = await bootstrapRawIdentity()
    expect(recipient.identity.personId).toBe(owner.identity.personId)
    expect(recipient.privateKeys.identityPrivateKey).toBeUndefined()
    await confirmIdentityAuthorityFixture(createPersonalRoot(recipient, await certHashDefault(recipientCertificate)), [owner.certificate, recipientCertificate])

    olderRoot.devices[recipient.device.deviceId] = { deviceId: recipient.device.deviceId, publicKey: recipient.device.publicKey,
      displayName: recipient.device.displayName, certificateHash: await certHashDefault(recipientCertificate), addedAt: "2026-10-14T07:00:00.000Z" }
    await defaultStorage.savePersonalRoot(olderRoot)
    await ensureRustyIdentityAuthorityPublished({ profile: recipient, access: sourceConfig })

    await deleteLocal(`tincanban.private-replica-state.v2.${owner.identity.personId}`)
    await deleteLocal(`tincanban.rusty-management.v1.${owner.identity.personId}`)
    await deleteLocal(`tincanban.identity-device-extensions.v1.${owner.identity.personId}`)
    await deleteLocal(identityProfileProjectionKey(owner.identity.personId))
    await receivePrivateReplicaState(owner.identity.personId, portablePreferences)
    await new RustyManagementRepository(owner.identity.personId).import(portableCapabilities)
    const selected = (await getIdentityReplicaConfigurations(owner.identity.personId))[0]
    expect(selected).toMatchObject({ purpose: "identity", personId: owner.identity.personId, cursor: 0, lastUploaded: "" })
    expect(await getPrivateReplicaProgress(owner.identity.personId, selected)).toMatchObject({ cursor: 0, generation: 0 })
    expect((await defaultStorage.loadPersonalRoot())?.photo).toEqual(olderRoot.photo)
    expect(await exportIdentityDeviceExtensions(owner.identity.personId)).toEqual({})
    expect(await readIdentityProfileQueue(owner.identity)).toEqual([])

    const sourceCapturePath = vi.spyOn(identityTransfer, "createIdentityDeviceTransfer").mockRejectedValue(new Error("source capture unavailable"))
    try {
      const recipientReplica = createIdentityReplica(selected, recipient, () => {})
      expect(await recipientReplica.pull()).toBe(true)
      expect(sourceCapturePath).not.toHaveBeenCalled()
    } finally { sourceCapturePath.mockRestore() }

    const pulledRoot = (await defaultStorage.loadPersonalRoot())!
    expect(pulledRoot.photo).toEqual(latestPhoto)
    const pulledState = await readIdentityProfileState(pulledRoot.profileState, owner.identity)
    expect(identityProfileValue(pulledState, "photo")).toMatchObject({ status: "value", values: [latestPhoto] })
    expect(pulledState.operations).toEqual(signedSourceState.operations)
    expect(await readIdentityProfileQueue(owner.identity)).toEqual([{ workspaceId: unknownWorkspaceId, record: originalProfile }])
    expect(await exportIdentityDeviceExtensions(owner.identity.personId)).toEqual({ preservedExtensions: {
      schema: "preserved-identity-components@1", required: false,
      value: { personId: owner.identity.personId, extensions: [{ name: "futureSettings", component: extension }] },
    } })
    expect(await getPrivateReplicaProgress(owner.identity.personId, (await getIdentityReplicaConfigurations(owner.identity.personId))[0]))
      .toMatchObject({ cursor: 1 })
    expect(recipient.privateKeys.identityPrivateKey).toBeUndefined()
  } finally {
    await stopRusty(process.child)
    await rm(process.stateDirectory, { recursive: true, force: true })
  }
}, 30_000)


test("Given existing person and scope policies but a cold local policy cache, when publication status and a checkpoint are requested, then reads create no policies and checkpoint authorization comes from current signed server state", async () => {
  resetIdentityStorageForTest()
  const owner = await bootstrapIdentity("Cold policy owner")
  await defaultStorage.savePersonalRoot(createPersonalRoot(owner, await certHashDefault(owner.certificate)))
  const service = await startRusty(owner)
  try {
    const discovery = await discoverBlindKeeper(service.origin)
    await ensureRustyPersonPolicy(discovery, owner, true, { allowLegacyMigration: true })
    const config = await ensureIdentityReplicaConnection(discovery, owner, () => {})
    await deleteLocal(`tincanban.rusty-management.v1.${owner.identity.personId}`)
    const originalFetch = globalThis.fetch
    const mutations: string[] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT" && new URL(String(input)).pathname.startsWith("/v2/management/")) mutations.push(String(input))
      return originalFetch(input, init)
    })
    expect((await readPublicBoardManagementState({ origin: service.origin, boardId: "cold-policy-board", profile: owner })).availability).toBe("missing")
    expect(mutations).toEqual([])
    await readRustyManagementStatus({ origin: service.origin, servicePublicKey: discovery.servicePublicKey,
      resourceKind: "person", resourceId: owner.identity.personId }, owner)
    expect((await readPublicBoardManagementState({ origin: service.origin, boardId: "cold-policy-board", profile: owner })).availability).toBe("missing")
    expect(mutations).toEqual([])
    const object = await encryptBlindObject(config.scopeId, 1, crypto.getRandomValues(new Uint8Array(32)), new Uint8Array([1]))
    const request = await prepareBlindCheckpoint(config, object, 0, owner)
    expect(request.managementCapability?.payload.revision).toBe(1)
    expect((await submitBlindCheckpoint(config, request)).payload.sequence).toBe(1)
    expect(mutations).toEqual([])
  } finally {
    vi.unstubAllGlobals()
    await stopRusty(service.child)
    await rm(service.stateDirectory, { recursive: true, force: true })
  }
}, 45_000)
