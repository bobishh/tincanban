import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { reactive } from "vue"
import * as Automerge from "@automerge/automerge/slim"
import { readFile } from "node:fs/promises"
import { createWorkspaceDoc } from "../domain/seeds"
import { initializeAutomerge } from "../crdt"
import type { LocalProfile } from "../domain/identity"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { exportApprovedAutomation } from "./automationActivation"

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), resolveContext: vi.fn(), exportAuthorization: vi.fn(),
  workspaceRole: vi.fn(), admissionAuthority: vi.fn(), assertUnfrozen: vi.fn(async () => {}), freezeKey: vi.fn(async () => "freeze-key"),
  assertHistoryReader: vi.fn(async () => {}), ensureWriter: vi.fn(), savedConfigs: vi.fn() }))

vi.mock("../app/automation", () => ({ prepareAutomationActivation: mocks.prepare }))
vi.mock("../domain/localSigningContext", () => ({ resolveLocalSigningContext: mocks.resolveContext }))
vi.mock("../sync/changeAuthorization", () => ({ exportAuthorizationBundle: mocks.exportAuthorization,
  workspaceRole: mocks.workspaceRole, localWorkspaceAdmissionAuthority: mocks.admissionAuthority }))
vi.mock("../sync/replicaCredentialFreeze", () => ({ assertReplicaCredentialsUnfrozen: mocks.assertUnfrozen,
  replicaCredentialFreezeKey: mocks.freezeKey }))
vi.mock("./automationInstanceClient", () => ({ assertAutomationKeyHistorySupported: mocks.assertHistoryReader }))
vi.mock("../sync/workspaceReplicaWriter", () => ({ ensureWorkspaceReplicaWriter: mocks.ensureWriter }))
vi.mock("../sync/privateReplicaRepository", () => ({ getReplicaConfigurations: mocks.savedConfigs }))

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})
afterEach(() => { vi.unstubAllGlobals() })

type Fixture = ReturnType<typeof fixture>
function fixture() {
  const profile = { identity: { personId: "owner-person", publicKey: "owner-public", displayName: "Owner" },
    device: { deviceId: "owner-device", publicKey: "device-public", displayName: "Owner device" },
    certificate: { signature: "leaf-cert", payload: { personId: "owner-person", deviceId: "owner-device" } }, privateKeys: {} } as unknown as LocalProfile
  const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("automation-workspace", "Applications", profile.identity.personId, "job-search"))
  const config = { purpose: "workspace" as const, origin: "https://rusty.example.test", scopeId: "scope-1",
    workspaceId: doc.id, servicePublicKey: "service", readToken: "read", writeToken: "write", keyEpoch: 1,
    policyRevision: 1, contentKey: "key", cursor: 0, lastUploaded: "" }
  let currentProfile: LocalProfile | undefined = profile
  let activeDoc: typeof doc | undefined = doc
  const host = {
    getCurrentProfile: () => currentProfile,
    readWorkspaceDoc: vi.fn(async () => doc),
    readWorkspaceBytes: vi.fn(async () => new Uint8Array([1])),
    getActiveDoc: () => activeDoc,
    owner: () => true,
    executeCommandAsync: vi.fn(async () => undefined),
    setProfile: (value: LocalProfile | undefined) => { currentProfile = value },
    setActiveDoc: (value: typeof doc | undefined) => { activeDoc = value },
  }
  const authority = { authority: { currentOwner: { personId: profile.identity.personId, publicKey: profile.identity.publicKey,
    certificates: [profile.certificate, { signature: "owner-ancestor" }] }, currentEpoch: 7 },
    credentialFingerprint: "credential-v1", fingerprint: "admission-v1" }
  const packet = { version: 2, workspaceId: doc.id, blind: config, definition: { payload: { id: "typed-definition", name: "Job intake" } },
    grant: { payload: { grantId: "grant-1", accessEpoch: 7 } }, bindings: { boardId: "board-1" },
    initial: { document: "AQ", authorization: { authority: { currentOwner: { personId: profile.identity.personId,
      certificates: [{ signature: "prepared-leaf" }] } } }, chat: null } }
  return { profile, doc, config, host, authority, packet }
}

function readyMocks(state: Fixture) {
  mocks.savedConfigs.mockResolvedValue([state.config])
  mocks.ensureWriter.mockImplementation(async (_app: unknown, config: unknown) => config)
  mocks.workspaceRole.mockResolvedValue("owner")
  mocks.admissionAuthority.mockResolvedValue(state.authority)
  mocks.exportAuthorization.mockResolvedValue({ version: 1, records: [], authority: state.authority.authority })
  mocks.prepare.mockImplementation(async (input: Record<string, unknown>) => {
    const factory = input.signingContext as ((purpose: string, binding: Record<string, string | number>) => Promise<unknown>) | undefined
    if (typeof factory === "function") {
      await factory("workspace-grant", { workspaceId: state.doc.id })
      await factory("automation-definition", { id: "typed-definition" })
    }
    return structuredClone(state.packet)
  })
  mocks.resolveContext.mockImplementation(async (_profile: LocalProfile, _purpose: string,
    _binding: Record<string, string | number>, options: { certificates?: unknown[]; currentAuthority?: () => Promise<string>; ensureCurrent?: () => Promise<void> }) => {
    await options.ensureCurrent?.()
    const revision = await options.currentAuthority?.()
    return { revision, certificates: options.certificates } as never
  })
}

describe("automation activation signing boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.assertUnfrozen.mockReset().mockResolvedValue(undefined)
    mocks.freezeKey.mockReset().mockResolvedValue("freeze-key")
    mocks.ensureWriter.mockReset()
    mocks.savedConfigs.mockReset()
  })

  it("Given a pending credential transition, When exporting Worker access, Then refuse before reading board state or executing an approval", async () => {
    const state = fixture()
    readyMocks(state)
    mocks.assertUnfrozen.mockRejectedValueOnce(new Error("Rusty credential transition is pending"))
    await expect(exportApprovedAutomation(state.host as never, state.config, "{}"))
      .rejects.toThrow(/credential transition/i)
    expect(mocks.assertUnfrozen).toHaveBeenCalledWith(state.profile.identity.personId, state.config)
    expect(state.host.readWorkspaceDoc).not.toHaveBeenCalled()
    expect(state.host.readWorkspaceBytes).not.toHaveBeenCalled()
    expect(state.host.executeCommandAsync).not.toHaveBeenCalled()
  })

  it("Given historical key variants, When the destination Worker reader is too old, Then refuse before workspace mutation or key export", async () => {
    const state = fixture()
    Object.assign(state.config, { historicalContentKeyVariants: { "1": ["older-key-a", "older-key-b"] } })
    readyMocks(state)
    mocks.assertHistoryReader.mockRejectedValueOnce(new Error("Worker cannot read multi-key history"))
    const worker = { origin: "https://worker.example.test", integrationId: "legacy-route", definitionId: "typed-definition",
      personId: "worker-person", identityPublicKey: "worker-public", deviceId: "worker-device",
      devicePublicKey: "worker-device-public", deviceCertificate: { signature: "worker-cert" } }
    await expect(exportApprovedAutomation(state.host as never, state.config, JSON.stringify(worker)))
      .rejects.toThrow(/cannot read multi-key history/i)
    expect(mocks.assertHistoryReader).toHaveBeenCalledWith(worker.origin)
    expect(state.host.executeCommandAsync).not.toHaveBeenCalled()
  })

  it("Given ordinary or unique historical keys, When exporting Worker access, Then preserve old-reader compatibility", async () => {
    const state = fixture()
    Object.assign(state.config, { historicalContentKeys: { "1": "older-key" } })
    readyMocks(state)
    const worker = { origin: "https://worker.example.test", integrationId: "legacy-route", definitionId: "typed-definition",
      personId: "worker-person", identityPublicKey: "worker-public", deviceId: "worker-device",
      devicePublicKey: "worker-device-public", deviceCertificate: { signature: "worker-cert" } }
    await exportApprovedAutomation(state.host as never, state.config, JSON.stringify(worker))
    expect(mocks.assertHistoryReader).not.toHaveBeenCalled()
  })

  it("Given an admitted native owner, When exporting approval, Then pass live context factory and full owner certificate evidence", async () => {
    const state = fixture()
    readyMocks(state)
    const worker = { origin: "https://worker.example.test", integrationId: "legacy-route", definitionId: "typed-definition",
      personId: "worker-person", identityPublicKey: "worker-public", deviceId: "worker-device",
      devicePublicKey: "worker-device-public", deviceCertificate: { signature: "worker-cert" } }
    const result = await exportApprovedAutomation(state.host as never, state.config, JSON.stringify(worker), {
      name: "Job intake", type: "job-intake", typeVersion: 1, parameters: { sources: ["email"] },
    })
    expect(JSON.parse(result)).toMatchObject({ definition: { payload: { id: "typed-definition" } },
      initial: { authorization: { authority: { currentOwner: { certificates: expect.arrayContaining([{ signature: "prepared-leaf" }]) } } } } })
    expect(mocks.workspaceRole).toHaveBeenCalledWith(state.doc, state.profile)
    expect(mocks.admissionAuthority).toHaveBeenCalledWith(state.doc, state.profile)
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ signingContext: expect.any(Function) }))
    expect(mocks.resolveContext).toHaveBeenCalledTimes(2)
    for (const [, purpose, , options] of mocks.resolveContext.mock.calls) {
      expect(purpose).toMatch(/workspace-grant|automation-definition/)
      expect(options.certificates).toContain(state.profile.certificate)
      expect(options.certificates).toContainEqual({ signature: "owner-ancestor" })
      await expect(options.ensureCurrent()).resolves.toBeUndefined()
      await expect(options.currentAuthority()).resolves.toContain("admission-v1")
    }
  })

  it("Given a reactive Rusty config from app state, When exporting approval, Then snapshot JSON values before async work", async () => {
    const state = fixture()
    readyMocks(state)
    const worker = { origin: "https://worker.example.test", integrationId: "legacy-route", definitionId: "typed-definition",
      personId: "worker-person", identityPublicKey: "worker-public", deviceId: "worker-device",
      devicePublicKey: "worker-device-public", deviceCertificate: { signature: "worker-cert" } }
    const reactiveConfig = reactive(state.config)
    await expect(exportApprovedAutomation(state.host as never, reactiveConfig, JSON.stringify(worker))).resolves.toBeTruthy()
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ blind: state.config }))
  })

  it("Given a stale Vue config after the repository confirms a newer Rusty policy, When exporting approval, Then sign the repository revision", async () => {
    const state = fixture()
    readyMocks(state)
    const latest = { ...state.config, policyRevision: 2, minimumWriterVersion: 2 as const }
    mocks.savedConfigs.mockResolvedValue([latest])
    mocks.ensureWriter.mockResolvedValue(latest)
    mocks.prepare.mockImplementation(async (input: Record<string, unknown>) => ({
      ...structuredClone(state.packet), blind: structuredClone(input.blind),
    }))
    const worker = { origin: "https://worker.example.test", integrationId: "legacy-route", definitionId: "typed-definition",
      personId: "worker-person", identityPublicKey: "worker-public", deviceId: "worker-device",
      devicePublicKey: "worker-device-public", deviceCertificate: { signature: "worker-cert" } }
    const result = await exportApprovedAutomation(state.host as never, state.config, JSON.stringify(worker))
    expect(mocks.ensureWriter).toHaveBeenCalledWith(state.host, latest, expect.any(Function))
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ blind: latest }))
    expect(JSON.parse(result).blind).toMatchObject({ policyRevision: 2, minimumWriterVersion: 2 })
  })

  it("Given visible owner UI but native visitor authority, When exporting, Then refuse before activation or command", async () => {
    const state = fixture()
    readyMocks(state)
    mocks.workspaceRole.mockResolvedValue("visitor")
    await expect(exportApprovedAutomation(state.host as never, state.config, JSON.stringify({ integrationId: "legacy-route" })))
      .rejects.toThrow(/owner/i)
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(state.host.executeCommandAsync).not.toHaveBeenCalled()
  })

  it("Given confirmed Rusty policy, When background replication advances before approval rereads access, Then export with current progress", async () => {
    const state = fixture()
    readyMocks(state)
    const confirmed = { ...state.config, minimumWriterVersion: 2 as const, preferenceRevision: "device:1" }
    const refreshed = { ...confirmed, cursor: 12, lastUploaded: "A".repeat(43) }
    mocks.ensureWriter.mockResolvedValue(confirmed)
    mocks.savedConfigs.mockResolvedValueOnce([confirmed]).mockResolvedValueOnce([refreshed])
    await expect(exportApprovedAutomation(state.host as never, state.config, "{}")).resolves.toBeTruthy()
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ blind: refreshed }))
  })

  it("Given the same workspace heads are reloaded as a new Automerge handle, When authority checks resume, Then allow the approval", async () => {
    const state = fixture()
    readyMocks(state)
    mocks.admissionAuthority.mockImplementation(async () => {
      state.host.setActiveDoc(Automerge.clone(state.doc) as never)
      return state.authority
    })
    await expect(exportApprovedAutomation(state.host as never, state.config, "{}")).resolves.toBeTruthy()
  })

  it("Given the workspace changes during an authority check, When approval resumes, Then refuse before command", async () => {
    const state = fixture()
    readyMocks(state)
    mocks.admissionAuthority.mockImplementation(async () => {
      state.host.setActiveDoc(Automerge.change(Automerge.clone(state.doc), draft => { draft.title = "Changed during approval" }) as never)
      return state.authority
    })
    await expect(exportApprovedAutomation(state.host as never, state.config, "{}"))
      .rejects.toThrow(/workspace owner authority changed during automation approval/i)
    expect(state.host.executeCommandAsync).not.toHaveBeenCalled()
  })

  it.each([
    { readToken: "replacement" }, { writeToken: "replacement" }, { contentKey: "replacement" },
    { servicePublicKey: "replacement" }, { policyRevision: 3 }, { keyEpoch: 2 },
    { historicalContentKeys: { "1": "replacement" } }, { historicalContentKeyVariants: { "1": ["replacement"] } },
    { preferenceRevision: "device:2" }, { minimumWriterVersion: undefined }, { removalPending: true },
  ])("Given confirmed Rusty policy, When authority changes to %j before approval rereads access, Then refuse before key export", async change => {
    const state = fixture()
    readyMocks(state)
    const confirmed = { ...state.config, minimumWriterVersion: 2 as const, preferenceRevision: "device:1" }
    mocks.ensureWriter.mockResolvedValue(confirmed)
    mocks.savedConfigs.mockResolvedValueOnce([confirmed]).mockResolvedValueOnce([{ ...confirmed, ...change }])
    await expect(exportApprovedAutomation(state.host as never, state.config, "{}"))
      .rejects.toThrow(/policy changed during automation approval/i)
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(state.host.executeCommandAsync).not.toHaveBeenCalled()
  })

  it("Given identity or workspace switches during asynchronous context resolution, When signing resumes, Then reject without command", async () => {
    const state = fixture()
    readyMocks(state)
    let entered!: () => void
    let release!: () => void
    const reached = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    mocks.resolveContext.mockImplementation(async (_profile: LocalProfile, _purpose: string,
      _binding: Record<string, string | number>, options: { ensureCurrent?: () => Promise<void>; currentAuthority?: () => Promise<string> }) => {
      await options.ensureCurrent?.()
      entered()
      await barrier
      await options.ensureCurrent?.()
      return { revision: await options.currentAuthority?.() } as never
    })
    const worker = { origin: "https://worker.example.test", integrationId: "legacy-route", definitionId: "typed-definition",
      personId: "worker-person", identityPublicKey: "worker-public", deviceId: "worker-device",
      devicePublicKey: "worker-device-public", deviceCertificate: { signature: "worker-cert" } }
    const pending = exportApprovedAutomation(state.host as never, state.config, JSON.stringify(worker), {
      name: "Job intake", type: "job-intake", typeVersion: 1, parameters: { sources: ["email"] },
    })
    const outcome = pending.then(() => ({ kind: "resolved" as const }), error => ({ kind: "rejected" as const, error }))
    const boundary = await Promise.race([reached.then(() => "context" as const), outcome.then(() => "done" as const)])
    if (boundary === "context") {
      state.host.setProfile({ ...state.profile, identity: { ...state.profile.identity, personId: "other-person" },
        device: { ...state.profile.device, deviceId: "other-device" } } as LocalProfile)
      state.host.setActiveDoc(undefined)
      release()
    }
    const result = await outcome
    expect(boundary).toBe("context")
    expect(result.kind).toBe("rejected")
    expect(state.host.executeCommandAsync).not.toHaveBeenCalled()
  })
})
