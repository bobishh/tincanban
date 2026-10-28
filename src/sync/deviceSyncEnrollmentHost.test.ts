import { beforeEach, describe, expect, it, vi } from "vitest"
import { createDeviceEnrollmentInvite, createPairingSecret, encodePairingFrame, type DeviceEnrollmentInvitation } from "@meta-uber/mesh-pairing"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createEnrollmentRequest } from "./enrollment"
import { defaultInvitationService, resetInvitationStorageForTest } from "./invitations"
import { receiveEnrollment } from "./deviceSyncEnrollment"
import { completeEnrollmentApproval } from "./deviceSyncSamePersonWorkspace"
import { MeshNetworkError } from "@meta-uber/mesh-transport"
import type { DuplexStream, SyncConnection, SyncNode } from "./transport"

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error("Condition was not met")
}

const stream = (read: () => Promise<Uint8Array>): DuplexStream => ({
  read,
  send: vi.fn(async () => undefined),
  closeSend: vi.fn(async () => undefined),
})

const contextFor = () => {
  let approvalResolver: ((approved: boolean) => void) | undefined
  const context = {
    currentRun: () => 1,
    denyPendingApproval: vi.fn(),
    handoffNode: vi.fn(async () => undefined),
    setApprovalResolver: vi.fn((resolve: ((approved: boolean) => void) | undefined) => { approvalResolver = resolve }),
    state: {
      authCode: { value: "" },
      enrollmentDeviceName: { value: "" },
      enrollmentSameIdentity: { value: false },
      step: { value: "enroll-host" },
      isOpen: { value: false },
      error: { value: "" },
    },
  }
  return { context, decline: () => approvalResolver?.(false) }
}

const enrollmentInvitation = async (): Promise<DeviceEnrollmentInvitation> => {
  const owner = await bootstrapIdentity("Owner")
  const invite = createDeviceEnrollmentInvite("owner-endpoint", createPairingSecret(), owner)
  await defaultInvitationService.saveIssuedInvitation(invite)
  return invite
}

describe("enrollment history transport recovery", () => {
  it.each(["reply", "request header"])("Given an approved enrollment, when one history %s stream is reset, then serve its fresh retry and finish acknowledgement on the same connection", async failureStage => {
    const secret = "history-retry-secret"
    const history = new TextEncoder().encode(`tincanban-peer-history-v1\n${JSON.stringify({ version: 1,
      kind: "workspace-history-object-read", baselineId: "B".repeat(43), objectId: "A".repeat(43),
      binding: { workspaceId: "board", historyEpoch: 1, indexId: "catalogue", objectKind: "page", partIndex: 0, partCount: 1 } })}`)
    const reset = vi.fn(async () => {})
    const incoming = (frame: Uint8Array) => ({ ...stream(async () => frame),
      readPairingOrRawPrefix: async () => frame, reset })
    const ack = incoming(encodePairingFrame("enroll-ack", secret, new Uint8Array([1])))
    const confirmation = incoming(encodePairingFrame("mesh-handoff-confirmed", secret, new Uint8Array()))
    const first = incoming(history)
    if (failureStage === "request header") first.readPairingOrRawPrefix = async () => { throw new MeshNetworkError("Peer reset its expired history stream") }
    const acceptStream = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(incoming(history))
      .mockResolvedValueOnce(ack).mockResolvedValueOnce(confirmation)
    let servedHistory = 0
    const serve = vi.fn(async (frame: Uint8Array) => {
      if (frame !== history) return false
      if (failureStage === "reply" && ++servedHistory === 1) throw new MeshNetworkError("Peer reset its expired history stream")
      return true
    })
    const replica = { servePeerHistoryBaselineRead: async () => false, servePeerHistoryDocumentRead: async () => false,
      servePeerHistoryObjectRead: serve, serveProofPage: async () => false,
      resolveProofs: async (bytes: Uint8Array) => bytes, receive: vi.fn(async () => {}) }
    const guard = vi.fn(async () => {})
    const connection = { acceptStream, openStream: vi.fn(), close: vi.fn() }
    await expect(completeEnrollmentApproval(connection, replica as never, "phone-device", secret, guard, {} as never, "Rejected"))
      .resolves.toBeUndefined()
    expect(acceptStream).toHaveBeenCalledTimes(4)
    expect(reset).toHaveBeenCalledOnce()
    expect(replica.receive).toHaveBeenCalledOnce()
    expect(ack.send).toHaveBeenCalledOnce()
    expect(connection.close).not.toHaveBeenCalled()
  })

  it.each(["revoked", "malformed"])("Given a %s history request, when enrollment handles the failure, then terminate instead of reading another stream", async failure => {
    const frame = new TextEncoder().encode("tincanban-peer-history-v1\n{}")
    let replyFailed = false
    const incoming = { ...stream(async () => frame), readPairingOrRawPrefix: async () => frame, reset: vi.fn(async () => {}) }
    const acceptStream = vi.fn(async () => incoming)
    const replica = { servePeerHistoryBaselineRead: async () => false, servePeerHistoryDocumentRead: async () => false,
      servePeerHistoryObjectRead: async () => {
        replyFailed = true
        throw failure === "revoked" ? new MeshNetworkError("Reply stream reset") : new Error("Malformed history request")
      } }
    const guard = async () => { if (replyFailed && failure === "revoked") throw new Error("Device access revoked") }
    await expect(completeEnrollmentApproval({ acceptStream } as never, replica as never, "phone-device", "secret", guard, {} as never, "Rejected"))
      .rejects.toThrow(failure === "revoked" ? "Device access revoked" : "Malformed history request")
    expect(acceptStream).toHaveBeenCalledOnce()
  })
})

describe("device enrollment host admission", () => {
  beforeEach(() => {
    resetIdentityStorageForTest()
    resetInvitationStorageForTest()
  })

  it("admits a verified guest while an earlier connection never opens its enrollment stream", async () => {
    const invite = await enrollmentInvitation()
    resetIdentityStorageForTest()
    const guest = await bootstrapIdentity("Guest")
    const request = encodePairingFrame("enroll-request", invite.secret, await createEnrollmentRequest(invite, guest))
    const silent = { acceptStream: vi.fn(() => new Promise<DuplexStream>(() => {})), close: vi.fn(async () => undefined), openStream: vi.fn() } as SyncConnection
    const verifiedStream = stream(async () => request)
    const verified = {
      acceptStream: vi.fn(async () => verifiedStream),
      close: vi.fn(async () => undefined),
      openStream: vi.fn(),
    } as unknown as SyncConnection
    const accept = vi.fn()
      .mockResolvedValueOnce(silent)
      .mockResolvedValueOnce(verified)
    const acceptor = { accept, close: vi.fn(async () => undefined) }
    const node = { close: vi.fn(async () => undefined) } as unknown as SyncNode
    const { context, decline } = contextFor()

    const receiving = receiveEnrollment(context as never, 1, node, acceptor, invite.secret, invite, undefined as never)

    await waitFor(() => context.state.step.value === "enroll-host-pending")
    expect(context.state.enrollmentDeviceName.value).toBe(guest.device.displayName)
    expect(silent.close).toHaveBeenCalled()

    decline()
    await receiving

    expect(context.handoffNode).toHaveBeenCalledWith("Enrollment finished")
  })

  it("continues listening after an unauthenticated connection closes before a verified guest arrives", async () => {
    const invite = await enrollmentInvitation()
    resetIdentityStorageForTest()
    const guest = await bootstrapIdentity("Guest")
    const request = encodePairingFrame("enroll-request", invite.secret, await createEnrollmentRequest(invite, guest))
    const rejected = { acceptStream: vi.fn(async () => { throw new Error("connection closed") }), close: vi.fn(async () => undefined), openStream: vi.fn() } as SyncConnection
    const verifiedStream = stream(async () => request)
    const verified = {
      acceptStream: vi.fn(async () => verifiedStream),
      close: vi.fn(async () => undefined),
      openStream: vi.fn(),
    } as unknown as SyncConnection
    const accept = vi.fn()
      .mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce(verified)
    const acceptor = { accept, close: vi.fn(async () => undefined) }
    const node = { close: vi.fn(async () => undefined) } as unknown as SyncNode
    const { context, decline } = contextFor()

    const receiving = receiveEnrollment(context as never, 1, node, acceptor, invite.secret, invite, undefined as never)

    await waitFor(() => context.state.step.value === "enroll-host-pending")
    expect(rejected.close).toHaveBeenCalled()

    decline()
    await receiving
    expect(context.handoffNode).toHaveBeenCalledWith("Enrollment finished")
  })

  it("does not wait for another connection after a verified guest has authenticated", async () => {
    const invite = await enrollmentInvitation()
    resetIdentityStorageForTest()
    const guest = await bootstrapIdentity("Guest")
    const request = encodePairingFrame("enroll-request", invite.secret, await createEnrollmentRequest(invite, guest))
    const verified = {
      acceptStream: vi.fn(async () => stream(async () => request)),
      close: vi.fn(async () => undefined),
      openStream: vi.fn(),
    } as unknown as SyncConnection
    let releaseAccept: ((connection: SyncConnection | undefined) => void) | undefined
    const accept = vi.fn()
      .mockResolvedValueOnce(verified)
      .mockImplementation(() => new Promise<SyncConnection | undefined>(resolve => { releaseAccept = resolve }))
    const acceptor = { accept, close: vi.fn(async () => releaseAccept?.(undefined)) }
    const node = { close: vi.fn(async () => undefined) } as unknown as SyncNode
    const { context, decline } = contextFor()

    const receiving = receiveEnrollment(context as never, 1, node, acceptor, invite.secret, invite, undefined as never)

    await waitFor(() => context.state.step.value === "enroll-host-pending")
    expect(accept).toHaveBeenCalledTimes(2)

    decline()
    await receiving
  })

  it("claims only one request when two guests authenticate concurrently", async () => {
    const invite = await enrollmentInvitation()
    resetIdentityStorageForTest()
    const firstGuest = await bootstrapIdentity("First guest")
    resetIdentityStorageForTest()
    const secondGuest = await bootstrapIdentity("Second guest")
    const frameFor = async (guest: typeof firstGuest) => encodePairingFrame("enroll-request", invite.secret, await createEnrollmentRequest(invite, guest))
    const firstClose = vi.fn(async () => undefined)
    const secondClose = vi.fn(async () => undefined)
    const first = { acceptStream: vi.fn(async () => stream(async () => await frameFor(firstGuest))), close: firstClose, openStream: vi.fn() } as unknown as SyncConnection
    const second = { acceptStream: vi.fn(async () => stream(async () => await frameFor(secondGuest))), close: secondClose, openStream: vi.fn() } as unknown as SyncConnection
    const acceptor = { accept: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second), close: vi.fn(async () => undefined) }
    const node = { close: vi.fn(async () => undefined) } as unknown as SyncNode
    const { context, decline } = contextFor()
    const claim = vi.spyOn(defaultInvitationService, "claimInvitation")

    const receiving = receiveEnrollment(context as never, 1, node, acceptor, invite.secret, invite, undefined as never)

    await waitFor(() => context.state.step.value === "enroll-host-pending")
    expect(claim).toHaveBeenCalledTimes(1)
    expect(firstClose.mock.calls.length + secondClose.mock.calls.length).toBe(1)

    decline()
    await receiving
    claim.mockRestore()
  })

  it("closes the listener when a replacement run cancels a pending admission", async () => {
    const invite = await enrollmentInvitation()
    let run = 1
    const acceptor = { accept: vi.fn(() => new Promise<Awaited<ReturnType<SyncNode["dial"]>> | undefined>(() => {})), close: vi.fn(async () => undefined) }
    const node = { close: vi.fn(async () => undefined) } as unknown as SyncNode
    const { context } = contextFor()
    context.currentRun = () => run

    const receiving = receiveEnrollment(context as never, 1, node, acceptor, invite.secret, invite, undefined as never)
    run = 2
    await receiving

    expect(acceptor.close).toHaveBeenCalled()
    expect(context.handoffNode).not.toHaveBeenCalled()
  })
})
