import { effectScope, nextTick, ref } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { usePublicBoardDelivery } from "./usePublicBoardDelivery"

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), delivery: vi.fn(), credential: vi.fn(), authority: vi.fn() }))
vi.mock("../localDb", () => ({ readLocal: mocks.read, writeLocal: mocks.write, deleteLocal: vi.fn(), listLocalKeys: vi.fn(async () => []) }))
vi.mock("../sync/peerStore", () => ({ peerStore: {
  getWorkspaceCredential: mocks.credential,
  getWorkspaceAuthority: mocks.authority,
} }))
vi.mock("../domain/proofs", () => ({ defaultProofStore: { listCertificates: vi.fn(async () => []) } }))
vi.mock("../sync/meshRecords", () => ({ verifyWorkspaceGrant: vi.fn(async () => "editor") }))
vi.mock("../sync/durableMeshBase", () => ({ isDeviceRevoked: () => false, isGrantRevoked: () => false,
  hasLeftWorkspace: () => false, uniqueCertificates: (_profile: unknown, certificates: unknown[]) => certificates }))
vi.mock("../public/publicDelivery", () => ({ deliverPublicBoard: mocks.delivery }))

describe("editor public delivery recovery", () => {
  let scope = effectScope()
  let role = ref<string | null>("editor")
  let version = ref(1)
  let recoveryActive = ref(false)
  let profile = { identity: { personId: "person", publicKey: "identity-key" }, device: { deviceId: "device" }, certificate: {} }
  const heads = ["a".repeat(64)]

  beforeEach(() => {
    vi.useFakeTimers()
    scope = effectScope()
    role = ref("editor")
    version = ref(1)
    recoveryActive = ref(false)
    profile = { identity: { personId: "person", publicKey: "identity-key" }, device: { deviceId: "device" }, certificate: {} }
    mocks.read.mockReset().mockResolvedValue(null)
    mocks.write.mockReset().mockResolvedValue(undefined)
    mocks.credential.mockReset().mockResolvedValue({ workspaceId: "workspace", ownerPersonId: "owner", ownerPublicKey: "owner-key",
      ownerCertificates: [], epoch: 1, localGrant: { payload: { workspaceId: "workspace", personId: "person", role: "editor", accessEpoch: 1 } } })
    mocks.authority.mockReset().mockResolvedValue({ workspaceId: "workspace", ownerCertificates: [], scopeAuthoritySnapshot: "authority" })
    mocks.delivery.mockReset().mockImplementation(async input => {
      await input.resolveWriter?.()
      await input.ensureCurrent()
      return { revision: 3, hash: "hash" }
    })
  })
  afterEach(() => { scope.stop(); vi.useRealTimers() })

  function create() {
    return scope.run(() => usePublicBoardDelivery({ origin: "https://rusty.test", workspaceId: () => "workspace",
      boardId: () => "board", document: () => ({ id: "workspace" } as never), sourceVersion: () => version.value,
      sourceHeads: () => heads, role: () => role.value, profile: () => profile as never, recoveryActive: () => recoveryActive.value, debounceMs: 0 }))!
  }

  it("resumes durable retry marker after hook restart", async () => {
    mocks.read.mockResolvedValue(JSON.stringify({ version: 1, workspaceId: "workspace", boardId: "board", sourceHeads: heads,
      status: "retry", attempts: 1, updatedAt: Date.now() }))
    const hook = create()
    await nextTick()
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalled())
    await Promise.resolve()
    expect(mocks.delivery).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(() => expect(mocks.delivery).toHaveBeenCalledTimes(1))
    expect(hook.status.value).toBe("delivered")
    expect(mocks.write.mock.calls[0]?.[0]).toContain(encodeURIComponent("person"))
    expect(mocks.write.mock.calls[0]?.[0]).toContain(encodeURIComponent("device"))
  })

  it("rechecks authority after role changes while a delivery is in flight", async () => {
    let release!: () => void
    let deliveryInput: { ensureCurrent: () => Promise<void> } | undefined
    mocks.delivery.mockImplementation(async (input: { ensureCurrent: () => Promise<void> }) => {
      deliveryInput = input
      await new Promise<void>(resolve => { release = resolve })
      return { revision: 3, hash: "hash" }
    })
    create()
    await nextTick()
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalled())
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(deliveryInput).toBeDefined())
    role.value = "visitor"
    await nextTick()
    await expect(deliveryInput!.ensureCurrent()).rejects.toThrow(/access or source changed/)
    release()
  })

  it("Given a private board and missing local editor authority, when delivery checks visibility, then finish quietly without reading publication credentials", async () => {
    mocks.credential.mockResolvedValue(null)
    mocks.authority.mockResolvedValue(null)
    mocks.delivery.mockResolvedValue(null)
    const hook = create()
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(hook.status.value).toBe("private"))
    expect(hook.error.value).toBe("")
    expect(mocks.credential).not.toHaveBeenCalled()
    expect(mocks.authority).not.toHaveBeenCalled()
  })

  it("Given a confirmed public board without editor authority, when authorization fails, then block with a Sync action instead of retrying forever", async () => {
    mocks.credential.mockResolvedValue(null)
    const hook = create()
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(hook.status.value).toBe("blocked"))
    expect(hook.error.value).toMatch(/access.*Sync/i)
    const reads = mocks.credential.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.credential).toHaveBeenCalledTimes(reads)
  })

  it("Given public delivery blocked on missing authority, when Sync restores access and closes, then resume once without a new board edit", async () => {
    const credential = await mocks.credential()
    mocks.credential.mockResolvedValue(null)
    const hook = create()
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(hook.status.value).toBe("blocked"))
    recoveryActive.value = true
    await nextTick()
    mocks.credential.mockResolvedValue(credential)
    recoveryActive.value = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(hook.status.value).toBe("delivered"))
    expect(hook.error.value).toBe("")
    expect(mocks.delivery).toHaveBeenCalledTimes(2)
  })

  it("Given an in-flight visibility request, when its effect scope is disposed, then reject later authorization without reading credentials", async () => {
    let deliveryInput: { resolveWriter: () => Promise<unknown> } | undefined
    let release!: () => void
    mocks.delivery.mockImplementation(async input => {
      deliveryInput = input
      await new Promise<void>(resolve => { release = resolve })
      return null
    })
    create()
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(deliveryInput).toBeDefined())
    scope.stop()
    await expect(deliveryInput!.resolveWriter()).rejects.toThrow(/access or source changed/)
    expect(mocks.credential).not.toHaveBeenCalled()
    release()
  })

  it("Given current public editor authority, when the server temporarily fails, then retry and confirm admitted changes", async () => {
    const deliver = mocks.delivery.getMockImplementation()!
    mocks.delivery.mockImplementationOnce(async input => { await input.resolveWriter?.(); throw new Error("Server temporarily unavailable") })
      .mockImplementation(deliver)
    const hook = create()
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(hook.status.value).toBe("retry"))
    expect(hook.error.value).toContain("temporarily unavailable")
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(() => expect(hook.status.value).toBe("delivered"))
    expect(hook.error.value).toBe("")
    expect(hook.deliveredHeads.value).toEqual(heads)
  })
})
