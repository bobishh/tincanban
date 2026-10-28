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

async function recoveryFixture(dial = vi.fn(async () => { throw new Error("Peer offline") })) {
  const profile = await bootstrapIdentity()
  const root = createPersonalRoot(profile, await certHashDefault(profile.certificate))
  registerWorkspaceInRoot(root, "board", "board", "genesis")
  await defaultStorage.savePersonalRoot(root)
  const invite = createDeviceEnrollmentInvite("remote", "secret", { ...profile,
    device: { ...profile.device, deviceId: "other-approved-device" } })
  await saveIdentityPeerRecovery(profile.identity.personId, [{ workspaceId: "board", invite }])
  let finishAccept: (value: undefined) => void = () => {}
  const node = { endpointId: "local", dial,
    accept: async () => ({ accept: () => new Promise<undefined>(resolve => { finishAccept = resolve }),
      close: async () => { finishAccept(undefined) } }), close: vi.fn(async () => {}) } as unknown as SyncNode
  const read = vi.fn(async () => { throw new Error("Board is not retained") })
  const recovery = new IdentityPeerRecovery({ transport: { start: async () => node },
    store: { read } as unknown as WorkspaceSetStore, mesh: {} as DurableMesh,
    getProfile: async () => profile, ownedWorkspaces: async () => [], changed: vi.fn() })
  return { profile, root, invite, dial, recovery }
}

it("Given a retained P2P source is unreachable, when the user retries loading boards, then retry the same source without losing its catalog reference", async () => {
  const { profile, root, invite, dial, recovery } = await recoveryFixture()
  try {
    await recovery.recover(["board"])
    expect(dial).toHaveBeenCalledTimes(1)
    await recovery.recover(["board"])
    expect(dial).toHaveBeenCalledTimes(2)
    expect((await defaultStorage.loadPersonalRoot())?.workspaces.board).toEqual(root.workspaces.board)
    expect(await readIdentityPeerRecovery(profile.identity.personId)).toEqual([{ workspaceId: "board", invite }])
  } finally { await recovery.close() }
})

it("Given peer history recovery is waiting on an offline device, when saved routes are requested, then restore routes without waiting for that network attempt", async () => {
  let rejectDial!: (error: Error) => void
  const dial = vi.fn(() => new Promise<never>((_, reject) => { rejectDial = reject }))
  const { recovery } = await recoveryFixture(dial)
  const history = recovery.recover(["board"])
  await vi.waitFor(() => expect(dial).toHaveBeenCalledOnce())
  let completed = false
  const routes = recovery.recover(["board"], { routesOnly: true }).then(() => { completed = true })
  try {
    await vi.waitFor(() => expect(completed).toBe(true), { timeout: 200 })
    expect(dial).toHaveBeenCalledOnce()
  } finally {
    rejectDial(new Error("Peer offline"))
    await Promise.all([history, routes])
    await recovery.close()
  }
})

it("Given peer recovery is already in flight, when another recovery request joins it, then reuse its failed attempt instead of immediately redialing the same offline source", async () => {
  let rejectDial!: (error: Error) => void
  const dial = vi.fn(async () => { throw new Error("Peer offline") })
    .mockImplementationOnce(() => new Promise<never>((_, reject) => { rejectDial = reject }))
  const { recovery } = await recoveryFixture(dial)
  const first = recovery.recover(["board"])
  await vi.waitFor(() => expect(dial).toHaveBeenCalledOnce())
  const second = recovery.recover(["board"])
  await recovery.start()
  rejectDial(new Error("Peer offline"))
  try {
    await Promise.all([first, second])
    expect(dial).toHaveBeenCalledOnce()
  } finally { await recovery.close() }
})
