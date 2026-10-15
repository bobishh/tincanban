import { beforeEach, describe, expect, it, vi } from "vitest"

const ports = vi.hoisted(() => ({ open: vi.fn(), decode: vi.fn(), admit: vi.fn(), coverage: vi.fn(), activate: vi.fn() }))
vi.mock("../sync/historyRecoveryFile", () => ({ openHistoryRecoveryFile: ports.open, createHistoryRecoveryFileWriter: vi.fn() }))
vi.mock("../sync/workspaceHistoryRecoveryDecode", () => ({ decodeWorkspaceRecoveryEvidence: ports.decode }))
vi.mock("../sync/peerHistoryRecoveryCoverage", () => ({ verifyDecodedPeerHistoryRecoveryCoverage: ports.coverage }))
vi.mock("../sync/workspaceHistoryRecoveryAdmission", () => ({ admitWorkspaceHistoryRecovery: ports.admit, recoveryProjectionAccess: vi.fn() }))
vi.mock("../sync/workspaceHistoryRecoveryProjection", () => ({ prepareWorkspaceHistoryRecoveryProjection: vi.fn(), resumeWorkspaceHistoryRecoveryProjection: ports.activate }))

import { inspectPrivateWorkspaceRecovery, restorePrivateWorkspaceRecovery } from "./workspaceHistoryRecovery"

describe("private workspace recovery product boundary", () => {
  beforeEach(() => vi.resetAllMocks())

  it("Given incorrect words, when inspecting a file, then no decoded state or activation is published", async () => {
    ports.open.mockRejectedValue(new Error("Recovery words did not unlock this file"))
    await expect(inspectPrivateWorkspaceRecovery(new Blob(["encrypted"]), "wrong words")).rejects.toThrow("unlock")
    expect(ports.decode).not.toHaveBeenCalled()
    expect(ports.admit).not.toHaveBeenCalled()
    expect(ports.activate).not.toHaveBeenCalled()
  })

  it("Given a fabricated preview, when restoring, then reject before reading or replacing a workspace", async () => {
    const profile = vi.fn()
    await expect(restorePrivateWorkspaceRecovery({ tincanban: { getCurrentProfile: profile } } as never,
      { workspaceId: "board", personId: "person", coverage: "complete", missingCount: 0 }, true)).rejects.toThrow("Inspect")
    expect(profile).not.toHaveBeenCalled()
    expect(ports.activate).not.toHaveBeenCalled()
  })

  it("Given authenticated bytes with invalid signed history, when inspecting, then refuse a usable preview", async () => {
    ports.open.mockResolvedValue({ header: { workspaceId: "board", identityRecovery: { personId: "person" } },
      transfer: {}, records: [{ kind: "history-recovery-manifest", workspaceId: "board", coverage: "complete",
        missingObjects: [], unresolvedDirectories: [] }] })
    ports.decode.mockResolvedValue({ journal: { receivedBaselines: [] }, auxiliary: new Map(), attachments: [] })
    ports.admit.mockRejectedValue(new Error("Invalid original history authorization"))
    await expect(inspectPrivateWorkspaceRecovery(new Blob(["encrypted"]), "valid words")).rejects.toThrow("authorization")
    expect(ports.activate).not.toHaveBeenCalled()
  })

  it("Given an authenticated incomplete backup, when inspected, then show missing coverage without returning keys or usable copied previews", async () => {
    ports.open.mockResolvedValue({ header: { workspaceId: "board", identityRecovery: { personId: "person" } },
      transfer: { privateSecret: "never return" }, records: [{ kind: "history-recovery-manifest", workspaceId: "board", coverage: "incomplete",
        missingObjects: [{ scopeId: "scope", ciphertextId: "missing" }], unresolvedDirectories: [], missingAttachmentIds: ["attachment"], missingPeerObjects: [{ baselineId: "baseline", objectId: "part" }] }] })
    ports.decode.mockResolvedValue({ journal: { receivedBaselines: [] }, auxiliary: new Map(), attachments: [] })
    ports.admit.mockResolvedValue({})
    const preview = await inspectPrivateWorkspaceRecovery(new Blob(["encrypted"]), "valid words")
    expect(preview).toEqual({ workspaceId: "board", personId: "person", coverage: "incomplete", missingCount: 3 })
    expect(Object.isFrozen(preview)).toBe(true)
    const profile = vi.fn()
    await expect(restorePrivateWorkspaceRecovery({ tincanban: { getCurrentProfile: profile } } as never,
      { ...preview }, true)).rejects.toThrow("Inspect")
    expect(profile).not.toHaveBeenCalled()
  })
})
