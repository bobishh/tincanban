import { effectScope, nextTick, ref } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { usePublicBoardDelivery } from "./usePublicBoardDelivery"

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), delivery: vi.fn(), credential: vi.fn(), authority: vi.fn(), role: vi.fn() }))
vi.mock("../localDb", () => ({ readLocal: mocks.read, writeLocal: mocks.write, deleteLocal: vi.fn(), listLocalKeys: vi.fn(async () => []) }))
vi.mock("../sync/peerStore", () => ({ peerStore: {
  getWorkspaceCredential: mocks.credential,
  getWorkspaceAuthority: mocks.authority,
} }))
vi.mock("../domain/proofs", () => ({ defaultProofStore: { listCertificates: vi.fn(async () => []) } }))
vi.mock("../sync/durableMeshBase", () => ({ uniqueCertificates: (_profile: unknown, certificates: unknown[]) => certificates }))
vi.mock("../public/publicDelivery", () => ({ deliverPublicBoard: mocks.delivery }))
vi.mock("../sync/changeAuthorization", () => ({ workspaceRole: mocks.role }))

describe("editor public delivery recovery", () => {
  let scope = effectScope()
  let role = ref<string | null>("editor")
  let version = ref(1)
  let recoveryActive = ref(false)
  let authorityVersion = ref(1)
  let origin = ref("https://rusty.test")
  let profile = { identity: { personId: "person", publicKey: "identity-key" }, device: { deviceId: "device" }, certificate: {} }
  const heads = ["a".repeat(64)]

  beforeEach(() => {
    vi.useFakeTimers()
    scope = effectScope()
    role = ref("editor")
    version = ref(1)
    recoveryActive = ref(false)
    authorityVersion = ref(1)
    origin = ref("https://rusty.test")
    profile = { identity: { personId: "person", publicKey: "identity-key" }, device: { deviceId: "device" }, certificate: {} }
    mocks.read.mockReset().mockResolvedValue(null)
    mocks.write.mockReset().mockResolvedValue(undefined)
    mocks.credential.mockReset().mockResolvedValue({ workspaceId: "workspace", ownerPersonId: "owner", ownerPublicKey: "owner-key",
      ownerCertificates: [], epoch: 1, localGrant: { payload: { workspaceId: "workspace", personId: "person", role: "editor", accessEpoch: 1 } } })
    mocks.authority.mockReset().mockResolvedValue({ workspaceId: "workspace", ownerPersonId: "owner", ownerPublicKey: "owner-key",
      ownerCertificates: [], epoch: 1, localGrant: { payload: { workspaceId: "workspace", personId: "person", role: "editor", accessEpoch: 1 } }, scopeAuthoritySnapshot: "authority" })
    mocks.role.mockReset().mockResolvedValue("editor")
    mocks.delivery.mockReset().mockImplementation(async input => {
      await input.resolveWriter?.()
      await input.ensureCurrent()
      return { revision: 3, hash: "hash" }
    })
  })
  afterEach(() => { scope.stop(); vi.useRealTimers() })

  function create() {
    return scope.run(() => usePublicBoardDelivery({ origin: () => origin.value, workspaceId: () => "workspace",
      boardId: () => "board", document: () => ({ id: "workspace" } as never), sourceVersion: () => version.value,
      sourceHeads: () => heads, role: () => role.value, profile: () => profile as never, recoveryActive: () => recoveryActive.value,
      authorityVersion: () => authorityVersion.value, debounceMs: 0 }))!
  }

  it("Given no connected publication server, when editor state changes, then perform no public requests", async () => {
    origin.value = ""
    create()
    version.value++
    await nextTick()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.delivery).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it("Given editor delivery in flight, when the publication host changes, then invalidate the old operation and deliver only to the new host", async () => {
    let release!: () => void
    let original: { ensureCurrent: () => Promise<void> } | undefined
    mocks.delivery.mockImplementationOnce(async input => {
      original = input
      await new Promise<void>(resolve => { release = resolve })
      return { revision: 50, hash: "old" }
    })
    const hook = create()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(original).toBeDefined())
    origin.value = "https://replacement.test"
    await nextTick()
    await expect(original!.ensureCurrent()).rejects.toThrow(/changed/)
    release()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(mocks.delivery).toHaveBeenCalledTimes(2))
    expect(mocks.delivery.mock.calls[1]![0].origin).toBe("https://replacement.test")
    await vi.waitFor(() => expect(hook.status.value).toBe("delivered"))
  })

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

  it("Given verified durable editor authority without a transport credential, when public delivery starts, then send current admitted content", async () => {
    mocks.credential.mockResolvedValue(null)
    const hook = create()
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(hook.status.value).toBe("delivered"))
    expect(mocks.role).toHaveBeenCalledWith(expect.objectContaining({ id: "workspace" }), profile)
    expect(mocks.credential).not.toHaveBeenCalled()
    expect(hook.error.value).toBe("")
  })

  it("Given stale connection rights and current durable editor authority, when public delivery starts, then use the authoritative grant", async () => {
    mocks.credential.mockResolvedValue({ workspaceId: "workspace", ownerPersonId: "previous-owner", epoch: 9,
      localGrant: { payload: { workspaceId: "workspace", personId: "person", role: "visitor", accessEpoch: 9 } } })
    const hook = create()
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(hook.status.value).toBe("delivered"))
    expect(mocks.role).toHaveBeenCalled()
    expect(mocks.credential).not.toHaveBeenCalled()
  })

  it("Given cached editor presentation but current membership denied, when preparing public delivery, then block before signing", async () => {
    mocks.role.mockResolvedValue("visitor")
    const hook = create()
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(hook.status.value).toBe("blocked"))
    expect(hook.error.value).toMatch(/access.*Sync/i)
  })

  it("Given authority changes during membership verification, when preparing delivery, then retry instead of using the captured grant", async () => {
    const authority = await mocks.authority()
    mocks.role.mockImplementationOnce(async () => {
      mocks.authority.mockResolvedValue({ ...authority, catalog: { revocations: ["new-revocation"] } })
      return "editor"
    })
    const hook = create()
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(hook.status.value).toBe("retry"))
    expect(hook.error.value).toContain("authority changed")
  })

  it("Given an already public board awaiting its durable authority, when the authority arrives without a source edit, then retry and deliver automatically", async () => {
    const authority = await mocks.authority()
    mocks.authority.mockResolvedValue(null)
    const hook = create()
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(hook.status.value).toBe("retry"))
    expect(mocks.role).not.toHaveBeenCalled()
    mocks.authority.mockResolvedValue(authority)
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(() => expect(hook.status.value).toBe("delivered"))
    expect(version.value).toBe(1)
    expect(hook.deliveredHeads.value).toEqual(heads)
  })

  it("Given a public board blocked on an unavailable editor grant, when authority changes while its cached role and source stay unchanged, then verify and deliver automatically", async () => {
    const authority = await mocks.authority()
    mocks.authority.mockResolvedValue({ ...authority, localGrant: undefined })
    const hook = create()
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(hook.status.value).toBe("blocked"))
    mocks.authority.mockResolvedValue(authority)
    authorityVersion.value++
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(hook.status.value).toBe("delivered"))
    expect(version.value).toBe(1)
    expect(role.value).toBe("editor")
  })

  it("Given current editor access denied, when an authority notification arrives, then recheck and remain blocked without a recurring retry", async () => {
    mocks.role.mockResolvedValue("visitor")
    const hook = create()
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(hook.status.value).toBe("blocked"))
    authorityVersion.value++
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(mocks.role).toHaveBeenCalledTimes(2))
    expect(hook.status.value).toBe("blocked")
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.role).toHaveBeenCalledTimes(2)
  })

  it("Given persisted authority cannot be validated, when delivery reads it, then block without a recurring retry", async () => {
    mocks.authority.mockRejectedValue(new Error("Invalid workspace authority"))
    const hook = create()
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(hook.status.value).toBe("blocked"))
    const reads = mocks.authority.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.authority).toHaveBeenCalledTimes(reads)
  })

  it("Given current source already delivered, when authority notifications arrive without a source change, then keep the confirmed delivery without sending it again", async () => {
    const hook = create()
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(hook.status.value).toBe("delivered"))
    authorityVersion.value++
    await nextTick()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.delivery).toHaveBeenCalledTimes(1)
    expect(hook.status.value).toBe("delivered")
  })

  it("Given a confirmed public board without editor authority, when authorization fails, then block with a Sync action instead of retrying forever", async () => {
    mocks.credential.mockResolvedValue(null)
    mocks.authority.mockResolvedValue({ ...await mocks.authority(), localGrant: undefined })
    const hook = create()
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(hook.status.value).toBe("blocked"))
    expect(hook.error.value).toMatch(/access.*Sync/i)
    const reads = mocks.authority.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.authority).toHaveBeenCalledTimes(reads)
  })

  it("Given public delivery blocked on missing authority, when Sync restores access and closes, then resume once without a new board edit", async () => {
    const authority = await mocks.authority()
    mocks.credential.mockResolvedValue(null)
    mocks.authority.mockResolvedValue({ ...authority, localGrant: undefined })
    const hook = create()
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(hook.status.value).toBe("blocked"))
    recoveryActive.value = true
    await nextTick()
    mocks.authority.mockResolvedValue(authority)
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
