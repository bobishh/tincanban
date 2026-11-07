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

beforeEach(() => resetIdentityStorageForTest())

async function recoveryFixture(dial = vi.fn(async () => { throw new Error("Peer offline") }),
  read: (id: string) => Promise<Uint8Array> = async () => { throw new Error("Board is not retained") },
  options: Partial<ConstructorParameters<typeof IdentityPeerRecovery>[0]> = {}) {
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
  const start = vi.fn(async () => node)
  const recovery = new IdentityPeerRecovery({ transport: { start },
    store: { read } as unknown as WorkspaceSetStore, mesh: {} as DurableMesh,
    getProfile: async () => profile, workspaces: () => [], changed: vi.fn(), ...options })
  return { profile, root, invite, dial, recovery, start }
}

it("Given the current document is already retained, when board loading recovers peers, then it does not dial a same-person history transfer", async () => {
  const read = vi.fn(async () => new Uint8Array([1]))
  const dial = vi.fn(async () => { throw new Error("Peer should stay idle") })
  const { recovery } = await recoveryFixture(dial, read)
  try {
    await recovery.recover(["board"])
    expect(read).toHaveBeenCalledWith("board")
    expect(dial).not.toHaveBeenCalled()
  } finally { await recovery.close() }
})

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

it("Given an imported editor board and a saved peer address without Rusty, when recovering its missing copy, then attempt the peer and retain the shared catalog reference", async () => {
  const { root, dial, recovery } = await recoveryFixture()
  registerWorkspaceInRoot(root, "board", "board", "import")
  await defaultStorage.savePersonalRoot(root)
  try {
    await recovery.recover(["board"])
    expect(dial).toHaveBeenCalledWith("remote")
    expect((await defaultStorage.loadPersonalRoot())?.workspaces.board).toEqual(root.workspaces.board)
  } finally { await recovery.close() }
})

it("Given an unpaired local Identity, when background recovery starts, then keep optional transport unloaded while explicit recovery can still reach a saved peer without Rusty", async () => {
  const { start, dial, recovery } = await recoveryFixture()
  try {
    await recovery.start()
    expect(start).not.toHaveBeenCalled()
    await recovery.recover(["board"])
    expect(start).toHaveBeenCalledOnce()
    expect(dial).toHaveBeenCalledWith("remote")
  } finally { await recovery.close() }
})

it("Given owner, editor, visitor, unreadable and inaccessible boards, when publishing recovery sources, then advertise every accessible copy without letting one unreadable board block the others", async () => {
  let personId = ""
  const { profile, recovery } = await recoveryFixture(undefined, undefined, {
    workspaces: () => ["own", "editor", "visitor", "broken", "denied"].map(id => ({ id, title: id })),
    workspaceOwner: async id => {
      if (id === "broken") throw new Error("Local copy unavailable")
      return id === "own" ? personId : "another-owner"
    },
    mesh: { enrollmentGrant: async (id: string) => ["editor", "visitor"].includes(id) ? { payload: { role: id } } : undefined } as unknown as DurableMesh,
  })
  personId = profile.identity.personId
  try {
    await recovery.recover([])
    const sources = await readIdentityPeerRecovery(personId)
    expect(sources.filter(source => source.invite.issuerEndpoint === "local").map(source => source.workspaceId).sort())
      .toEqual(["editor", "own", "visitor"])
    expect(sources.some(source => source.workspaceId === "board" && source.invite.issuerEndpoint === "remote")).toBe(true)
  } finally { await recovery.close() }
})
