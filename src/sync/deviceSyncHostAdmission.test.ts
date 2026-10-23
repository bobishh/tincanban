import { afterEach, expect, it, vi } from "vitest"
import { defaultInvitationService } from "./invitations"
import { defaultProofStore } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { approveWorkspaceAccess, prepareWorkspaceAccess } from "./deviceSyncHostAdmission"
import type { HostRuntime } from "./deviceSyncHost"

vi.mock("./invitations", () => ({ defaultInvitationService: { approveWorkspaceJoinSet: vi.fn() } }))
vi.mock("../domain/proofs", () => ({ defaultProofStore: { putGrant: vi.fn() } }))
vi.mock("../storage", () => ({ defaultStorage: { withWorkspaceAuthorityMutation: vi.fn() } }))
vi.mock("../domain/identity", () => ({ toBase64Url: () => "snapshot" }))

afterEach(() => vi.unstubAllGlobals())

it("Given a committed grant after an interrupted response, when the same person retries, then reuse membership without issuing another grant", async () => {
  vi.stubGlobal("window", {})
  const guest = { personId: "guest-person", meshPeers: { device: "guest-device" } }
  const grant = { payload: { grantId: "grant-1", workspaceId: "workspace-1", role: "editor" } } as never
  const existing = { ok: true as const, grants: [grant] }
  const mesh = {
    checkGuestDevices: vi.fn(async () => "guest-device"),
    acceptGuest: vi.fn(async () => {}),
    invitationPayload: vi.fn(async () => undefined),
  }
  const runtime = {
    invite: { invitationId: "invite-1", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    workspaces: [{ id: "workspace-1", title: "Workspace" }],
    profile: { identity: { personId: "owner-person" } },
    context: { durableMesh: mesh, currentRun: () => 1 },
    run: 1,
    stopped: () => false,
    replica: { snapshot: vi.fn(async () => new Uint8Array([1])) },
    grants: new Map([[guest.personId, existing]]),
    approvals: { delete: vi.fn() },
  } as unknown as HostRuntime

  const approval = await approveWorkspaceAccess(runtime, guest)
  expect(approval).toMatchObject({ ok: true, value: { personId: guest.personId, grants: [grant], role: "editor" } })
  if (!approval.ok) throw new Error("Existing grant was not reused")
  await prepareWorkspaceAccess(runtime, approval.value)

  expect(mesh.acceptGuest).toHaveBeenCalledOnce()
  expect(defaultInvitationService.approveWorkspaceJoinSet).not.toHaveBeenCalled()
  expect(defaultStorage.withWorkspaceAuthorityMutation).not.toHaveBeenCalled()
  expect(defaultProofStore.putGrant).not.toHaveBeenCalled()
})
