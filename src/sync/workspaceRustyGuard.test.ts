import { afterEach, expect, it, vi } from "vitest"
import { assertParticipantStorageAccess } from "./workspaceRustyGuard"
import { peerStore } from "./peerStore"
import * as storageAccess from "./workspaceRustyAccess"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import type { BlindReplicaConfig } from "./blindReplication"
import { WorkspaceUnavailableError } from "../workspaceAvailability"

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const grant = { payload: { kind: "workspace-grant", version: 1, workspaceId: "shared", personId: "editor", role: "editor", grantId: "grant", accessEpoch: 2 }, signature: "signed", signerKeyId: "owner-device" }
  const authority = { ownerPersonId: "owner", localGrant: grant }
  vi.spyOn(peerStore, "getWorkspaceCredential").mockResolvedValue(authority as never)
  vi.spyOn(peerStore, "getWorkspaceAuthority").mockResolvedValue(authority as never)
  const state = meshRustRuntime().state
  vi.spyOn(state, "hasAuthorityConflict").mockReturnValue(false)
  vi.spyOn(state, "isDeviceRevoked").mockReturnValue(false)
  vi.spyOn(state, "isGrantRevoked").mockReturnValue(false)
  vi.spyOn(state, "hasLeftWorkspace").mockReturnValue(false)
  const verify = vi.spyOn(storageAccess, "verifyBoardStorageAccess").mockResolvedValue(undefined)
  const withWorkspaceDoc = vi.fn().mockRejectedValue(new WorkspaceUnavailableError())
  const app = { getCurrentProfile: () => ({ identity: { personId: "editor", publicKey: "editor-key" }, device: { deviceId: "approved-device" } }), withWorkspaceDoc }
  const config = { workspaceId: "shared", boardAccess: { authorization: { signerKeyId: "owner-device", payload: { workspaceGrant: grant } } } } as BlindReplicaConfig
  return { app, config, verify, withWorkspaceDoc, authority, grant, state }
}

it("Given an admitted editor and retained Rusty access, when its board copy is absent, then authenticate the first download without requiring that copy", async () => {
  const { app, config, verify, authority } = fixture()
  await expect(assertParticipantStorageAccess(app as never, config)).resolves.toBeUndefined()
  expect(verify).toHaveBeenCalledWith(config, "shared", authority, "editor", "editor", "editor-key")
})

it("Given a missing board and a different admitted grant, when storage is requested, then reject the mismatched access", async () => {
  const { app, config, verify } = fixture()
  config.boardAccess!.authorization.payload.workspaceGrant = { ...config.boardAccess!.authorization.payload.workspaceGrant!, payload: {
    ...config.boardAccess!.authorization.payload.workspaceGrant!.payload, grantId: "different-grant" } }
  await expect(assertParticipantStorageAccess(app as never, config)).rejects.toThrow(/grant/i)
  expect(verify).not.toHaveBeenCalled()
})

it("Given a stored board that cannot be decoded, when storage access is checked, then propagate corruption instead of bootstrapping", async () => {
  const { app, config, verify, withWorkspaceDoc } = fixture()
  const failure = new Error("Stored board is corrupt")
  withWorkspaceDoc.mockRejectedValue(failure)
  await expect(assertParticipantStorageAccess(app as never, config)).rejects.toBe(failure)
  expect(verify).not.toHaveBeenCalled()
})

it("Given revoked editor membership, when a first board download is requested, then reject before reading the document", async () => {
  const { app, config, withWorkspaceDoc, state } = fixture()
  vi.mocked(state.isGrantRevoked).mockReturnValue(true)
  await expect(assertParticipantStorageAccess(app as never, config)).rejects.toThrow(/revoked/i)
  expect(withWorkspaceDoc).not.toHaveBeenCalled()
})
