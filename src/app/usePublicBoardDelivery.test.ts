import { effectScope, nextTick, ref } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { usePublicBoardDelivery } from "./usePublicBoardDelivery"

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), delivery: vi.fn() }))
vi.mock("../localDb", () => ({ readLocal: mocks.read, writeLocal: mocks.write, deleteLocal: vi.fn(), listLocalKeys: vi.fn(async () => []) }))
vi.mock("../sync/peerStore", () => ({ peerStore: {
  getWorkspaceCredential: vi.fn(async () => ({ workspaceId: "workspace", ownerPersonId: "owner", ownerPublicKey: "owner-key",
    ownerCertificates: [], epoch: 1, localGrant: { payload: { workspaceId: "workspace", personId: "person", role: "editor", accessEpoch: 1 } } })),
  getWorkspaceAuthority: vi.fn(async () => ({ workspaceId: "workspace", ownerCertificates: [], scopeAuthoritySnapshot: "authority" })),
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
  let profile = { identity: { personId: "person", publicKey: "identity-key" }, device: { deviceId: "device" }, certificate: {} }
  const heads = ["a".repeat(64)]

  beforeEach(() => {
    vi.useFakeTimers()
    scope = effectScope()
    role = ref("editor")
    version = ref(1)
    profile = { identity: { personId: "person", publicKey: "identity-key" }, device: { deviceId: "device" }, certificate: {} }
    mocks.read.mockReset().mockResolvedValue(null)
    mocks.write.mockReset().mockResolvedValue(undefined)
    mocks.delivery.mockReset().mockResolvedValue({ revision: 3, hash: "hash" })
  })
  afterEach(() => { scope.stop(); vi.useRealTimers() })

  function create() {
    return scope.run(() => usePublicBoardDelivery({ origin: "https://rusty.test", workspaceId: () => "workspace",
      boardId: () => "board", document: () => ({ id: "workspace" } as never), sourceVersion: () => version.value,
      sourceHeads: () => heads, role: () => role.value, profile: () => profile as never, debounceMs: 0 }))!
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
})
