import { beforeEach, describe, expect, it, vi } from "vitest"
import { createWorkspaceDoc } from "../domain/seeds"
import type { LocalProfile } from "../domain/identity"
import { exportApprovedAutomation } from "./automationActivation"

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), resolveContext: vi.fn(), exportAuthorization: vi.fn(),
  workspaceRole: vi.fn(), admissionAuthority: vi.fn() }))

vi.mock("../app/automation", () => ({ prepareAutomationActivation: mocks.prepare }))
vi.mock("../domain/localSigningContext", () => ({ resolveLocalSigningContext: mocks.resolveContext }))
vi.mock("../sync/changeAuthorization", () => ({ exportAuthorizationBundle: mocks.exportAuthorization,
  workspaceRole: mocks.workspaceRole, localWorkspaceAdmissionAuthority: mocks.admissionAuthority }))

type Fixture = ReturnType<typeof fixture>
function fixture() {
  const profile = { identity: { personId: "owner-person", publicKey: "owner-public", displayName: "Owner" },
    device: { deviceId: "owner-device", publicKey: "device-public", displayName: "Owner device" },
    certificate: { signature: "leaf-cert", payload: { personId: "owner-person", deviceId: "owner-device" } }, privateKeys: {} } as unknown as LocalProfile
  const doc = createWorkspaceDoc("automation-workspace", "Applications", profile.identity.personId, "job-search")
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
  const packet = { version: 2, workspaceId: doc.id, definition: { payload: { id: "typed-definition", name: "Job intake" } },
    grant: { payload: { grantId: "grant-1", accessEpoch: 7 } }, bindings: { boardId: "board-1" },
    initial: { document: "AQ", authorization: { authority: { currentOwner: { personId: profile.identity.personId,
      certificates: [{ signature: "prepared-leaf" }] } } }, chat: null } }
  return { profile, doc, config, host, authority, packet }
}

function readyMocks(state: Fixture) {
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
  beforeEach(() => { vi.clearAllMocks() })

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

  it("Given visible owner UI but native visitor authority, When exporting, Then refuse before activation or command", async () => {
    const state = fixture()
    readyMocks(state)
    mocks.workspaceRole.mockResolvedValue("visitor")
    await expect(exportApprovedAutomation(state.host as never, state.config, JSON.stringify({ integrationId: "legacy-route" })))
      .rejects.toThrow(/owner/i)
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
