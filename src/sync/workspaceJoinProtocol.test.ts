import { describe, expect, it } from "vitest"
import { isMeshNetworkFailure, MeshNetworkError } from "@meta-uber/mesh-transport"
import { BrowserWorkspaceJoinGuest, BrowserWorkspaceJoinHandoffGuest, BrowserWorkspaceJoinHandoffHost, BrowserWorkspaceJoinHost, WorkspaceJoinRejectedError } from "@meta-uber/mesh-runtime"
import { WasmWorkspaceJoinHandshake, WasmWorkspaceJoinHandoff } from "@meta-uber/mesh-transport/wasm"
import { sha256Base64Url } from "../domain/identity"
import { keeperCommitReceiptVerifier } from "./keeperCommitReceipt"

const secret = "join-secret"

function pairedAdapters() {
  let requestFrame: Uint8Array<ArrayBufferLike> = new Uint8Array()
  let requestReady!: (frame: Uint8Array<ArrayBufferLike>) => void
  let responseReady!: (frame: Uint8Array<ArrayBufferLike>) => void
  let acknowledgementReady!: (frame: Uint8Array<ArrayBufferLike>) => void
  const requestFrameReady = new Promise<Uint8Array<ArrayBufferLike>>(resolve => { requestReady = resolve })
  const responseFrameReady = new Promise<Uint8Array<ArrayBufferLike>>(resolve => { responseReady = resolve })
  const acknowledgementFrameReady = new Promise<Uint8Array<ArrayBufferLike>>(resolve => { acknowledgementReady = resolve })
  const guestRequestStream = {
    send: async (bytes: Uint8Array) => { requestFrame = bytes; requestReady(bytes) },
    read: async () => responseFrameReady, closeSend: async () => {},
  }
  const hostResponseStream = {
    send: async (bytes: Uint8Array) => { responseReady(bytes) },
    read: async () => requestFrame, closeSend: async () => {},
  }
  const guestAckStream = {
    send: async (bytes: Uint8Array) => { acknowledgementReady(bytes) },
    read: async () => new Uint8Array(), closeSend: async () => {},
  }
  const hostAckStream = {
    send: async () => {}, read: async () => acknowledgementFrameReady, closeSend: async () => {},
  }
  return {
    host: new BrowserWorkspaceJoinHost(new WasmWorkspaceJoinHandshake(secret, "host")),
    guest: new BrowserWorkspaceJoinGuest(new WasmWorkspaceJoinHandshake(secret, "guest")),
    hostResponseStream,
    guestRequestStream,
    hostConnection: { acceptStream: async () => hostAckStream, openStream: async () => hostResponseStream },
    guestConnection: { openStream: async () => guestAckStream, acceptStream: async () => { throw new Error("Unused guest stream") } },
    requestFrameReady,
  }
}

const request = new TextEncoder().encode('{"personId":"guest"}')
const success = new TextEncoder().encode('{"grants":[],"snapshot":"host"}')
const guestSnapshot = new TextEncoder().encode('[{"snapshot":"guest"}]')

function handoffConnection(guest: WasmWorkspaceJoinHandoff, host: WasmWorkspaceJoinHandoff, failConfirmation = false) {
  let requestFrame: Uint8Array<ArrayBufferLike> = new Uint8Array()
  let opened = 0
  const requestStream = {
    send: async (frame: Uint8Array) => { requestFrame = frame },
    read: async () => host.hostReceiveRequest(requestFrame),
    closeSend: async () => {},
  }
  const confirmationStream = {
    send: async (frame: Uint8Array) => { host.hostReceiveConfirmation(frame) },
    read: async () => new Uint8Array(),
    closeSend: async () => {},
  }
  return {
    openStream: async () => {
      opened += 1
      if (opened === 1) return requestStream
      if (failConfirmation) throw new MeshNetworkError("network offline before confirmation")
      return confirmationStream
    },
    acceptStream: async () => { throw new Error("Unused host stream") },
  }
}

describe("Rust workspace join state machine in browser stream adapter", () => {
  it("Given a keeper commit remains pending, when an offer is accepted, then bounded receipt reaches host only after commit", async () => {
    const pair = pairedAdapters()
    const snapshot = new TextEncoder().encode("offered workspace snapshot")
    const verify = await keeperCommitReceiptVerifier(["one", "two"], snapshot)
    let commit!: () => void
    let installing!: () => void
    const installed = new Promise<void>(resolve => { installing = resolve })
    const committed = new Promise<void>(resolve => { commit = resolve })
    let acknowledged = false
    const receipt = new TextEncoder().encode(JSON.stringify({ kind: "keeper-provision-commit", version: 1,
      workspaceIds: ["one", "two"], snapshotHash: await sha256Base64Url(snapshot) }))
    const guestRun = pair.guest.handle(pair.guestRequestStream, pair.guestConnection, request, async () => {
      installing()
      await committed
      return { value: "committed", acknowledgement: receipt }
    })
    const hostRun = pair.host.handle(await pair.requestFrameReady, pair.hostResponseStream, pair.hostConnection, {
      request: bytes => bytes,
      approve: async () => ({ ok: true as const, value: "approved keeper" }),
      prepare: async () => success,
      acknowledged: async payload => { verify(payload); acknowledged = true; expect(payload.byteLength).toBeLessThan(512) },
    })
    await installed
    expect(acknowledged).toBe(false)
    commit()
    await expect(guestRun).resolves.toBe("committed")
    await expect(hostRun).resolves.toEqual({ kind: "accepted", value: "approved keeper" })
    expect(acknowledged).toBe(true)
  })

  it("Given a keeper sends a receipt for another snapshot, when host checks ACK, then host never accepts the peer", async () => {
    const pair = pairedAdapters()
    const verify = await keeperCommitReceiptVerifier(["one"], new Uint8Array([1]))
    const receipt = new TextEncoder().encode(JSON.stringify({ kind: "keeper-provision-commit", version: 1,
      workspaceIds: ["one"], snapshotHash: "wrong" }))
    const guestRun = pair.guest.handle(pair.guestRequestStream, pair.guestConnection, request,
      async () => ({ value: "committed", acknowledgement: receipt }))
    const hostRun = pair.host.handle(await pair.requestFrameReady, pair.hostResponseStream, pair.hostConnection, {
      request: bytes => bytes,
      approve: async () => ({ ok: true as const, value: "approved keeper" }),
      prepare: async () => success,
      acknowledged: async payload => verify(payload),
    })
    await expect(hostRun).rejects.toThrow("Invalid keeper commit receipt")
    await expect(guestRun).resolves.toBe("committed")
  })

  it("Given a prepared workspace, when guest accepts and acknowledges it, then host receives guest snapshot", async () => {
    const pair = pairedAdapters()
    const guestRun = pair.guest.handle(pair.guestRequestStream, pair.guestConnection, request, async payload => {
      expect(payload).toEqual(success)
      return { value: guestSnapshot, acknowledgement: guestSnapshot }
    })
    const requestFrame = await pair.requestFrameReady
    const hostRun = pair.host.handle(requestFrame, pair.hostResponseStream, pair.hostConnection, {
      request: bytes => JSON.parse(new TextDecoder().decode(bytes)),
      approve: async () => ({ ok: true as const, value: "approved" }),
      prepare: async value => { expect(value).toBe("approved"); return success },
      acknowledged: async payload => { expect(payload).toEqual(guestSnapshot) },
    })

    await expect(guestRun).resolves.toEqual(guestSnapshot)
    await expect(hostRun).resolves.toEqual({ kind: "accepted", value: "approved" })
  })

  it("Given approval fails with network-like text, when host rejects, then guest acknowledges once and does not retry", async () => {
    const pair = pairedAdapters()
    const guestRun = pair.guest.handle(pair.guestRequestStream, pair.guestConnection, request, async () => ({ value: guestSnapshot, acknowledgement: guestSnapshot }))
    const requestFrame = await pair.requestFrameReady
    const hostRun = pair.host.handle(requestFrame, pair.hostResponseStream, pair.hostConnection, {
      request: bytes => JSON.parse(new TextDecoder().decode(bytes)),
      approve: async () => ({ ok: false as const, error: "Workspace authority network validation failed" }),
      prepare: async () => success,
    })

    await expect(guestRun).rejects.toBeInstanceOf(WorkspaceJoinRejectedError)
    const terminal = await guestRun.catch(error => error as WorkspaceJoinRejectedError) as WorkspaceJoinRejectedError
    expect(terminal.message).toBe("Workspace authority network validation failed")
    expect(isMeshNetworkFailure(terminal)).toBe(false)
    await expect(hostRun).resolves.toEqual({ kind: "declined" })
  })

  it("Given snapshot preparation fails, when host sends rejection, then both sides see the cause", async () => {
    const pair = pairedAdapters()
    const failure = new Error("Workspace snapshot preparation failed")
    const guestRun = pair.guest.handle(pair.guestRequestStream, pair.guestConnection, request, async () => ({ value: guestSnapshot, acknowledgement: guestSnapshot }))
    const requestFrame = await pair.requestFrameReady
    const hostRun = pair.host.handle(requestFrame, pair.hostResponseStream, pair.hostConnection, {
      request: bytes => JSON.parse(new TextDecoder().decode(bytes)),
      approve: async () => ({ ok: true as const, value: "approved" }),
      prepare: async () => { throw failure },
    })

    await expect(guestRun).rejects.toThrow(failure.message)
    const hostError = await hostRun.catch(error => error as WorkspaceJoinRejectedError)
    expect(hostError).toBeInstanceOf(WorkspaceJoinRejectedError)
    expect((hostError as WorkspaceJoinRejectedError).cause).toBe(failure)
  })

  it("Given guest validation fails after an accepted response, when it sends a negative acknowledgement, then host sees a terminal cause", async () => {
    const pair = pairedAdapters()
    const guestRun = pair.guest.handle(pair.guestRequestStream, pair.guestConnection, request, async () => {
      throw new Error("Snapshot storage failed: network locked")
    })
    const requestFrame = await pair.requestFrameReady
    const hostRun = pair.host.handle(requestFrame, pair.hostResponseStream, pair.hostConnection, {
      request: bytes => JSON.parse(new TextDecoder().decode(bytes)),
      approve: async () => ({ ok: true as const, value: "approved" }),
      prepare: async () => success,
    })

    await expect(guestRun).rejects.toBeInstanceOf(WorkspaceJoinRejectedError)
    await expect(hostRun).rejects.toThrow("Snapshot storage failed: network locked")
    expect(isMeshNetworkFailure(await guestRun.catch(error => error as WorkspaceJoinRejectedError))).toBe(false)
  })

  it("Given wrong secret, wrong stage, or duplicate response, then Rust rejects each transition", async () => {
    const requestFrame = new WasmWorkspaceJoinHandshake(secret, "guest").sendRequest(request)
    const wrongSecretHost = new WasmWorkspaceJoinHandshake("other-secret", "host")
    await expect(Promise.resolve().then(() => wrongSecretHost.receiveRequest(requestFrame))).rejects.toThrow(/authorization failed/i)

    const host = new WasmWorkspaceJoinHandshake(secret, "host")
    await expect(Promise.resolve().then(() => host.respond(success))).rejects.toThrow(/out of sequence/i)
    const validRequest = new WasmWorkspaceJoinHandshake(secret, "guest").sendRequest(request)
    host.receiveRequest(validRequest)
    const response = host.respond(success)
    const invalidPhaseGuest = new WasmWorkspaceJoinHandshake(secret, "guest")
    await expect(Promise.resolve().then(() => invalidPhaseGuest.receiveResponse(response))).rejects.toThrow(/out of sequence/i)
    const responseAfterRequest = new WasmWorkspaceJoinHandshake(secret, "guest")
    const requestFromThisGuest = responseAfterRequest.sendRequest(request)
    void requestFromThisGuest
    responseAfterRequest.receiveResponse(response)
    await expect(Promise.resolve().then(() => responseAfterRequest.receiveResponse(response))).rejects.toThrow(/out of sequence/i)
  })

  it("Given rejection ack path fails after authenticated denial, then the failure remains terminal", async () => {
    const pair = pairedAdapters()
    pair.guestConnection.openStream = async () => { throw new Error("network offline") }
    pair.hostConnection.acceptStream = async () => { throw new Error("network offline") }
    const guestRun = pair.guest.handle(pair.guestRequestStream, pair.guestConnection, request, async () => ({ value: guestSnapshot, acknowledgement: guestSnapshot }))
    const requestFrame = await pair.requestFrameReady
    const hostRun = pair.host.handle(requestFrame, pair.hostResponseStream, pair.hostConnection, {
      request: bytes => JSON.parse(new TextDecoder().decode(bytes)),
      approve: async () => ({ ok: false as const, error: "Owner declined" }),
      prepare: async () => success,
    })
    const guestError = await guestRun.catch(error => error as WorkspaceJoinRejectedError) as WorkspaceJoinRejectedError
    expect(guestError).toBeInstanceOf(WorkspaceJoinRejectedError)
    expect(guestError.message).toBe("Owner declined")
    expect(guestError.cause).toBeInstanceOf(Error)
    expect(isMeshNetworkFailure(guestError)).toBe(false)
    await expect(hostRun).resolves.toEqual({ kind: "declined" })
  })

  it("Given mesh resume fails before adoption, when retryable, then Rust returns retry after rollback", async () => {
    const guestMachine = new WasmWorkspaceJoinHandoff(secret, "guest")
    const hostMachine = new WasmWorkspaceJoinHandoff(secret, "host")
    const connection = handoffConnection(guestMachine, hostMachine)
    let rollbackCount = 0
    const result = await new BrowserWorkspaceJoinHandoffGuest(guestMachine).run(connection,
      async () => { throw new MeshNetworkError("network offline during resume") },
      async () => { rollbackCount += 1 })

    expect(result).toEqual({ kind: "retry" })
    expect(rollbackCount).toBe(1)
    expect(() => guestMachine.guestResumeSucceeded()).toThrow("Workspace handoff out of sequence")
  })

  it("Given mesh resumed, when confirmation stream fails, then Rust preserves adopted ownership", async () => {
    const guestMachine = new WasmWorkspaceJoinHandoff(secret, "guest")
    const hostMachine = new WasmWorkspaceJoinHandoff(secret, "host")
    const connection = handoffConnection(guestMachine, hostMachine, true)
    let resumeCount = 0
    let rollbackCount = 0
    const result = await new BrowserWorkspaceJoinHandoffGuest(guestMachine).run(connection,
      async () => { resumeCount += 1 },
      async () => { rollbackCount += 1 })

    expect(result.kind).toBe("adopted")
    expect(resumeCount).toBe(1)
    expect(rollbackCount).toBe(0)
    expect(() => guestMachine.guestConfirmationSent()).toThrow("Workspace handoff out of sequence")
  })

  it("Given the receiver already consumed handoff request, when host sends ready, then it does not read the stream again", async () => {
    const guest = new WasmWorkspaceJoinHandoff(secret, "guest")
    const host = new WasmWorkspaceJoinHandoff(secret, "host")
    const requestFrame = guest.guestRequest()
    let confirmationFrame: Uint8Array = new Uint8Array()
    const consumedStream = {
      read: async () => { throw new Error("Handoff request frame was already consumed") },
      send: async (ready: Uint8Array) => {
        guest.guestReceiveReady(ready)
        guest.guestResumeSucceeded()
        confirmationFrame = guest.guestBeginConfirmation()
      }, closeSend: async () => {},
    }
    const confirmationStream = {
      read: async () => confirmationFrame,
      send: async () => {}, closeSend: async () => {},
    }

    await expect(new BrowserWorkspaceJoinHandoffHost(host).run(consumedStream, requestFrame, {
      openStream: async () => { throw new Error("Unused host stream") },
      acceptStream: async () => confirmationStream,
    })).resolves.toBeUndefined()
    expect(guest.guestConfirmationSent()).toBe("complete")
  })
})
