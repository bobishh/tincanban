import "fake-indexeddb/auto"
import { beforeEach, expect, it, vi } from "vitest"
import { createDeviceEnrollmentInvite } from "@meta-uber/mesh-pairing"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot, registerWorkspaceInRoot } from "../domain/personalRoot"
import { certHashDefault } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { saveIdentityPeerRecovery, readIdentityPeerRecovery } from "./identityPeerRecoveryCatalog"
import { IdentityPeerRecovery } from "./identityPeerRecovery"
import type { DurableMesh } from "./durableMesh"
import type { SyncNode } from "./transport"
import type { WorkspaceSetStore } from "./workspaceSet"
vi.mock("./privateReplicaRepository", () => ({ getIdentityReplicaConfigurations: async () => [{ purpose: "identity" }] }))
beforeEach(() => resetIdentityStorageForTest())

it("Given a retained P2P source is unreachable, when the user retries loading boards, then retry the same source without losing its catalog reference", async () => {
  const profile = await bootstrapIdentity()
  const root = createPersonalRoot(profile, await certHashDefault(profile.certificate))
  registerWorkspaceInRoot(root, "board", "board", "genesis")
  await defaultStorage.savePersonalRoot(root)
  const invite = createDeviceEnrollmentInvite("remote", "secret", { ...profile,
    device: { ...profile.device, deviceId: "other-approved-device" } })
  await saveIdentityPeerRecovery(profile.identity.personId, [{ workspaceId: "board", invite }])
  let finishAccept: (value: undefined) => void = () => {}
  const dial = vi.fn(async () => { throw new Error("Peer offline") })
  const node = { endpointId: "local", dial,
    accept: async () => ({ accept: () => new Promise<undefined>(resolve => { finishAccept = resolve }),
      close: async () => { finishAccept(undefined) } }), close: vi.fn(async () => {}) } as unknown as SyncNode
  const read = vi.fn(async () => { throw new Error("Board is not retained") })
  const recovery = new IdentityPeerRecovery({ transport: { start: async () => node },
    store: { read } as unknown as WorkspaceSetStore, mesh: {} as DurableMesh,
    getProfile: async () => profile, ownedWorkspaces: async () => [], changed: vi.fn() })
  try {
    await recovery.recover(["board"])
    expect(dial).toHaveBeenCalledTimes(1)
    await recovery.recover(["board"])
    expect(dial).toHaveBeenCalledTimes(2)
    expect((await defaultStorage.loadPersonalRoot())?.workspaces.board).toEqual(root.workspaces.board)
    expect(await readIdentityPeerRecovery(profile.identity.personId)).toEqual([{ workspaceId: "board", invite }])
  } finally { await recovery.close() }
})
