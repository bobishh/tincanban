import { beforeAll, describe, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import { decodePairingFrame, encodePairingFrame, inspectPairingFrame } from "@meta-uber/mesh-pairing"
import type { SyncConnection } from "./transport"
import { liveAutomergeWorkspaceSync, liveWorkspaceSetSync, workspaceSet, publishConfirmedWorkspace, publishOwnerWorkspaceOffer } from "./workspaceSet"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { readProofPage, writeProofPage, clearProofPages } from "./proofPageCache"
import { WorkspaceChangeRejected } from "./changeAuthorization"
import { sha256Base64Url } from "../domain/identity"
import * as Automerge from "@automerge/automerge/slim"
import { createLiveWorkspaceSession } from "@meta-uber/mesh-runtime"
import { initializeAutomerge } from "../crdt"
import { MeshNetworkError } from "@meta-uber/mesh-transport"
import { clearMeshTrace, meshTraceSnapshot } from "./meshTrace"
import { withWorkspaceMutation } from "../workspaceMutation"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("Confirmed ownership delivery", () => {
  it("waits for a matching receipt instead of treating a sent frame as a durable save", async () => {
    const bytes = new Uint8Array([1, 2, 3])
    let acknowledge!: (bytes: Uint8Array) => void
    const read = new Promise<Uint8Array>(resolve => { acknowledge = resolve })
    const connection = { openStream: async () => ({ send: vi.fn(), closeSend: vi.fn(), read: () => read }) } as never
    let finished = false
    const delivery = publishConfirmedWorkspace(connection, "secret", bytes).then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    acknowledge(encodePairingFrame("mesh-durable-ack", "secret", new TextEncoder().encode(await sha256Base64Url(bytes))))
    await delivery
    expect(finished).toBe(true)
  })

  it("rejects a receipt for different contents", async () => {
    const connection = { openStream: async () => ({ send: vi.fn(), closeSend: vi.fn(),
      read: async () => encodePairingFrame("mesh-durable-ack", "secret", new TextEncoder().encode("wrong")) }) } as never
    await expect(publishConfirmedWorkspace(connection, "secret", new Uint8Array([1]))).rejects.toThrow(/receipt/i)
  })

  it("acknowledges only after the document and ownership metadata have been persisted", async () => {
    let save!: () => void
    const persisted = new Promise<void>(resolve => { save = resolve })
    const bytes = new TextEncoder().encode(JSON.stringify([{ id: "workspace", bytes: "AA", mesh: {} }]))
    const stream = { send: vi.fn(), closeSend: vi.fn(), read: async () => encodePairingFrame("mesh-durable-batch", "secret", bytes) }
    let accepted = false
    const connection = { acceptStream: async () => { if (!accepted) { accepted = true; return stream }; return new Promise<never>(() => {}) },
      close: vi.fn(), openStream: vi.fn() }
    const mergeMesh = vi.fn(() => persisted)
    const session = liveWorkspaceSetSync(connection, "secret", workspaceSet({ read: vi.fn(), merge: vi.fn(), activate: vi.fn(), mergeMesh }, ["workspace"]))
    await vi.waitFor(() => expect(mergeMesh).toHaveBeenCalled())
    expect(stream.send).not.toHaveBeenCalled()
    save()
    await vi.waitFor(() => expect(stream.send).toHaveBeenCalled())
    expect(inspectPairingFrame(stream.send.mock.calls[0]![0]).type).toBe("mesh-durable-ack")
    await session.close()
  })
})

describe("workspace invitation scope", () => {
  it("keeps the failure reason visible when the board has a long title", async () => {
    const replica = workspaceSet({
      read: async () => { throw new Error("Workspace storage is unavailable") },
      merge: vi.fn(), activate: vi.fn(),
    }, [{ id: "default", title: "Long board title ".repeat(100) }])
    const error = await replica.snapshot().catch(error => error) as Error
    expect(error.message.length).toBeLessThan(512)
    expect(error.message).toContain("Workspace storage is unavailable")
  })

  it("identifies the exact workspace when a multi-workspace snapshot member fails", async () => {
    const failure = new Error("Workspace storage is unavailable")
    const read = vi.fn(async (id: string) => {
      if (id === "second-board") throw failure
      return new Uint8Array([1])
    })
    const replica = workspaceSet({ read, merge: vi.fn(), activate: vi.fn() }, [
      { id: "first-board", title: "Job search" },
      { id: "second-board", title: "Job search" },
    ])

    await expect(replica.snapshot()).rejects.toMatchObject({
      message: expect.stringContaining("Workspace second-board (Job search) snapshot failed: Workspace storage is unavailable"),
      cause: failure,
    })
    expect(read).toHaveBeenCalledWith("first-board")
    expect(read).toHaveBeenCalledWith("second-board")
  })

  it.each([
    [{ id: "a", bytes: "AA" }, { id: "private", bytes: "AA" }],
    [{ id: "a", bytes: "AA" }, { id: "a", bytes: "AA" }],
    [{ id: "a", bytes: "AA" }],
  ].map(entries => ({ entries })))("rejects a mismatched or incomplete set before any document is saved: %j", async ({ entries }) => {
    const merge = vi.fn()
    const replica = workspaceSet({ read: vi.fn(), merge, activate: vi.fn() }, ["a", "b"])
    await expect(replica.receive(new TextEncoder().encode(JSON.stringify(entries)))).rejects.toThrow(/different set/)
    expect(merge).not.toHaveBeenCalled()
  })

  it("Given a failing sync section, when a snapshot is received, then diagnostics identify its stage", async () => {
    const replica = workspaceSet({
      read: vi.fn(), merge: vi.fn(), activate: vi.fn(),
      mergeChat: vi.fn().mockRejectedValue(new Error("Invalid workspace grant")),
    }, ["workspace"])
    const bytes = new TextEncoder().encode(JSON.stringify([{ id: "workspace", bytes: "AA", chat: {} }]))

    await expect(replica.receive(bytes)).rejects.toThrow("Chat workspace: Invalid workspace grant")
  })

  it("Given workspace validation rejects a snapshot, when the join reports the failure, then its safe schema path is retained", async () => {
    const rejected = new Error("Invalid workspace received.", {
      cause: { code: "invalid_input", field: "entities.card_1.kind" },
    })
    const replica = workspaceSet({
      read: vi.fn(), merge: vi.fn().mockRejectedValue(rejected), activate: vi.fn(),
    }, ["workspace"])
    const bytes = new TextEncoder().encode(JSON.stringify([{ id: "workspace", bytes: "AA" }]))

    await expect(replica.receive(bytes)).rejects.toThrow(
      "Workspace workspace: Invalid workspace received. [invalid_input at entities.card_1.kind]",
    )
  })

  it("validates every invited workspace before persisting any of them", async () => {
    const validate = vi.fn(async (id: string) => {
      if (id === "second") throw new Error("Invalid workspace grant")
    })
    const merge = vi.fn()
    const replica = workspaceSet({ read: vi.fn(), validate, merge, activate: vi.fn() }, ["first", "second"])
    const bytes = new TextEncoder().encode(JSON.stringify([
      { id: "first", bytes: "AA" },
      { id: "second", bytes: "AA" },
    ]))

    await expect(replica.receive(bytes)).rejects.toThrow("Workspace second: Invalid workspace grant")
    expect(validate).toHaveBeenCalledTimes(2)
    expect(merge).not.toHaveBeenCalled()
  })
})

describe("live mesh heartbeat", () => {
  it("requires an authenticated acknowledgement from the remote peer", async () => {
    const sent: Uint8Array[] = []
    const connection: SyncConnection = {
      openStream: async () => ({
        send: async bytes => { sent.push(bytes) },
        closeSend: async () => {},
        read: async () => encodePairingFrame("sync-heartbeat-ack", "mesh-secret", new Uint8Array()),
      }),
      acceptStream: () => new Promise(() => {}),
      close: async () => {},
    }
    const replica = workspaceSet({ read: vi.fn(), merge: vi.fn(), activate: vi.fn() }, ["workspace"])
    const session = liveWorkspaceSetSync(connection, "mesh-secret", replica)

    await session.heartbeat?.()

    expect(sent).toHaveLength(1)
    expect(inspectPairingFrame(sent[0]!)).toEqual({ type: "sync-heartbeat", secret: "mesh-secret" })
    await session.close()
  })

  it("Given a joined peer requests durable handoff, when live sync receives it, then control reaches the host without parsing it as data", async () => {
    let delivered = false
    const stream = {
      send: vi.fn(), closeSend: vi.fn(),
      read: vi.fn(async () => encodePairingFrame("mesh-handoff-request", "mesh-secret", new Uint8Array())),
    }
    let accepted = false
    const connection: SyncConnection = {
      openStream: vi.fn(),
      acceptStream: vi.fn(async () => {
        if (!accepted) { accepted = true; return stream }
        return new Promise<never>(() => {})
      }),
      close: vi.fn(async () => {}),
    }
    const replica = workspaceSet({ read: vi.fn(), merge: vi.fn(), activate: vi.fn() }, ["workspace"])
    const session = liveWorkspaceSetSync(connection, "mesh-secret", replica, {
      onHandoffRequest: async () => { delivered = true },
    })

    await vi.waitFor(() => expect(delivered).toBe(true))
    await session.close()
  })
})

describe("incremental workspace control plane", () => {
  it.each([
    ["Authorization records changed; restart document sync", true],
    ["Authorization authority changed; restart document sync", true],
    ["No document awaiting authorization pages", true],
    ["Invalid authorization signature", false],
  ])("Given proof transfer fails with %s, then session restart is %s", async (message, restart) => {
    const bytes = Automerge.save(Automerge.from({ id: "workspace" }))
    let accepted = false
    let rejectAccept: ((error: Error) => void) | undefined
    const connection: SyncConnection = {
      openStream: vi.fn(),
      acceptStream: async () => {
        if (accepted) return new Promise((_, reject) => { rejectAccept = reject })
        accepted = true
        return { send: vi.fn(async () => {}), closeSend: vi.fn(async () => {}), read: async () => encodePairingFrame("mesh-control-sync", "secret",
          new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: "workspace", authorization: [] }))) }
      },
      close: vi.fn(async () => { rejectAccept?.(new Error("Connection closed")) }),
    }
    const merge = vi.fn(async () => { throw new Error(message) })
    const session = liveAutomergeWorkspaceSync(connection, "secret", { read: async () => bytes, merge, activate: vi.fn() }, "workspace", "local", "remote")
    void session.done.catch(() => {})
    await vi.waitFor(() => expect(merge).toHaveBeenCalled())
    if (restart) await vi.waitFor(() => expect(connection.close).toHaveBeenCalled())
    else expect(connection.close).not.toHaveBeenCalled()
    await session.close()
  })

  it("Given control history exceeds 256 KiB, when published, then bounded frames deliver the complete state once", async () => {
    const sent: Uint8Array[] = []
    const authorization = [{ hash: "history", signature: "s".repeat(300_000) }]
    const bytes = Automerge.save(Automerge.from({ id: "workspace" }))
    const sender = liveAutomergeWorkspaceSync({
      openStream: async () => ({ send: async frame => { sent.push(frame) }, closeSend: async () => {}, read: vi.fn() }),
      acceptStream: () => new Promise(() => {}), close: vi.fn(),
    }, "secret", { read: async () => bytes, merge: vi.fn(), activate: vi.fn(), readAuthorization: async () => authorization },
    "workspace", "a", "b")
    await expect(sender.publish()).resolves.toBeUndefined()
    const control = sent.filter(frame => inspectPairingFrame(frame).type === "mesh-control-sync")
    expect(control.length).toBeGreaterThan(1)
    for (const frame of control) expect(decodePairingFrame(frame, "mesh-control-sync", "secret").length).toBeLessThanOrEqual(256 * 1024)
    const count = sent.length
    await sender.publish()
    expect(sent).toHaveLength(count)
    const merge = vi.fn()
    let index = 0
    const receiver = liveAutomergeWorkspaceSync({
      openStream: vi.fn(), close: vi.fn(),
      acceptStream: async () => index < control.length
        ? { read: async () => control[index++]!, send: vi.fn(), closeSend: vi.fn() }
        : new Promise(() => {}),
    }, "secret", { read: async () => bytes, merge, activate: vi.fn() },
    "workspace", "b", "a")
    await vi.waitFor(() => expect(merge).toHaveBeenCalledExactlyOnceWith("workspace", bytes, authorization))
    await sender.close()
    await receiver.close()
  })

  it("Given an authorization-only update, when a control frame arrives, then it merges the proof without a document change", async () => {
    const merge = vi.fn(async () => {})
    const authorization = [{ hash: "cleanup", signature: "signed" }]
    let accepted = false
    const stream = {
      send: vi.fn(), closeSend: vi.fn(async () => {}),
      read: vi.fn(async () => encodePairingFrame("mesh-control-sync", "mesh-secret",
        new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: "workspace", authorization })))),
    }
    const connection: SyncConnection = {
      openStream: vi.fn(),
      acceptStream: vi.fn(async () => {
        if (!accepted) { accepted = true; return stream }
        return new Promise<never>(() => {})
      }),
      close: vi.fn(async () => {}),
    }
    const bytes = new Uint8Array([1, 2, 3])
    const session = liveAutomergeWorkspaceSync(connection, "mesh-secret", {
      read: async () => bytes, merge, activate: vi.fn(),
    }, "workspace", "local", "remote")

    await vi.waitFor(() => expect(merge).toHaveBeenCalledWith("workspace", bytes, authorization))
    await session.close()
  })

  it("Given an authorization-only update, when the session publishes, then it sends the proof in a control frame", async () => {
    const sent: Uint8Array[] = []
    const bytes = Automerge.save(Automerge.from({ id: "workspace" }))
    const authorization = [{ hash: "cleanup", signature: "signed" }]
    const connection: SyncConnection = {
      openStream: vi.fn(async () => ({ send: async (frame: Uint8Array) => { sent.push(frame) }, closeSend: async () => {}, read: async () => new Uint8Array() })),
      acceptStream: () => new Promise(() => {}), close: vi.fn(async () => {}),
    }
    const session = liveAutomergeWorkspaceSync(connection, "mesh-secret", {
      read: async () => bytes, merge: vi.fn(), activate: vi.fn(), readAuthorization: async () => authorization,
    }, "workspace", "local", "remote")

    await session.publish()

    const control = sent.find(frame => inspectPairingFrame(frame).type === "mesh-control-sync")!
    const payload = JSON.parse(new TextDecoder().decode(
      decodePairingFrame(control, "mesh-control-sync", "mesh-secret"),
    ))
    expect(payload.authorization).toEqual(authorization)
    await session.close()
  })

  it("Given ownership state changes, when a control frame arrives, then it merges without a full workspace document", async () => {
    const mergeMesh = vi.fn(async () => {})
    let accepted = false
    const stream = {
      send: vi.fn(), closeSend: vi.fn(async () => {}),
      read: vi.fn(async () => encodePairingFrame("mesh-control-sync", "mesh-secret",
        new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: "workspace", mesh: { epoch: 2 } })))),
    }
    const connection: SyncConnection = {
      openStream: vi.fn(),
      acceptStream: vi.fn(async () => {
        if (!accepted) { accepted = true; return stream }
        return new Promise<never>(() => {})
      }),
      close: vi.fn(async () => {}),
    }
    const session = liveAutomergeWorkspaceSync(connection, "mesh-secret", {
      read: async () => new Uint8Array(), merge: vi.fn(), activate: vi.fn(), mergeMesh,
    }, "workspace", "local", "remote")

    await vi.waitFor(() => expect(mergeMesh).toHaveBeenCalledWith("workspace", { epoch: 2 }))
    expect(stream.closeSend).toHaveBeenCalled()
    await session.close()
  })

  it("Given two owner devices, when a workspace offer arrives, then it is persisted before acknowledgement", async () => {
    const offer = new TextEncoder().encode('{"version":1,"workspaceId":"future"}')
    const accepted = vi.fn(async () => {})
    let delivered = false
    const inbound = {
      send: vi.fn(), closeSend: vi.fn(async () => {}),
      read: vi.fn(async () => encodePairingFrame("mesh-owner-workspace-offer", "mesh-secret", offer)),
    }
    const connection: SyncConnection = {
      openStream: vi.fn(),
      acceptStream: vi.fn(async () => {
        if (!delivered) { delivered = true; return inbound }
        return new Promise<never>(() => {})
      }),
      close: vi.fn(async () => {}),
    }
    const session = liveAutomergeWorkspaceSync(connection, "mesh-secret", {
      read: async () => new Uint8Array(), merge: vi.fn(), activate: vi.fn(),
    }, "workspace", "local", "remote", undefined, {
      ownerWorkspaceOfferFrame: "mesh-owner-workspace-offer",
      onOwnerWorkspaceOffer: accepted,
    })

    await vi.waitFor(() => expect(accepted).toHaveBeenCalledWith(offer))
    expect(inspectPairingFrame(inbound.send.mock.calls[0]![0]).type).toBe("mesh-durable-ack")
    await session.close()
  })

  it("requires a matching receipt when publishing an owner workspace", async () => {
    const offer = new Uint8Array([1, 2, 3])
    const stream = { send: vi.fn(), closeSend: vi.fn(),
      read: async () => encodePairingFrame("mesh-durable-ack", "secret",
        new TextEncoder().encode(await sha256Base64Url(offer))) }
    const connection = { openStream: async () => stream } as never
    await expect(publishOwnerWorkspaceOffer(connection, "secret", offer, "mesh-owner-workspace-offer")).resolves.toBeUndefined()
    expect(inspectPairingFrame(stream.send.mock.calls[0]![0]).type).toBe("mesh-owner-workspace-offer")
  })
})


describe("rejected document isolation", () => {
  it("Given an interrupted incoming stream, When the frame fails, Then its trace identifies a network failure", async () => {
    clearMeshTrace()
    const record = vi.spyOn(await import("./telemetry"), "record").mockImplementation(() => {})
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    const stream = { read: async () => { throw new MeshNetworkError("private peer endpoint") },
      send: vi.fn(), closeSend: vi.fn(async () => {}) }
    let accepted = false
    const connection = { acceptStream: async () => {
      if (accepted) return new Promise<never>(() => {})
      accepted = true
      return stream
    }, close: vi.fn(), openStream: vi.fn() }
    const session = liveAutomergeWorkspaceSync(connection, "secret", {
      read: async () => new Uint8Array(), merge: vi.fn(), activate: vi.fn(),
    }, "workspace", "local", "remote")
    try {
      Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
      await vi.waitFor(() => expect(record).toHaveBeenCalledWith("workspace.frame.rejected",
        expect.objectContaining({ error: expect.any(MeshNetworkError) }), "warn"))
      expect(meshTraceSnapshot()).toContainEqual(expect.objectContaining({ event: "workspace.frame.rejected" }))
    } finally {
      await session.close()
      record.mockRestore()
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  it("Given blocked persistence, when authenticated heartbeat arrives, then liveness replies before any durable receipt", async () => {
    let saved!: () => void
    const pending = new Promise<void>(resolve => { saved = resolve })
    const batch = new TextEncoder().encode(JSON.stringify([{ id: "workspace", bytes: "AA" }]))
    const frames = [encodePairingFrame("mesh-durable-batch", "secret", batch),
      encodePairingFrame("sync-heartbeat", "wrong-secret", new Uint8Array()),
      encodePairingFrame("sync-heartbeat", "secret", new Uint8Array())]
    const streams = frames.map(frame => ({ read: async () => frame, send: vi.fn(), closeSend: vi.fn(async () => {}) }))
    let index = 0
    const connection = { acceptStream: async () => streams[index++] ?? new Promise<never>(() => {}),
      close: vi.fn(), openStream: vi.fn() }
    const merge = vi.fn(() => pending)
    const session = liveAutomergeWorkspaceSync(connection, "secret", {
      read: async () => new Uint8Array(), merge, activate: vi.fn(),
    }, "workspace", "local", "remote")
    await vi.waitFor(() => expect(streams[2]!.send).toHaveBeenCalledOnce())
    expect(merge).toHaveBeenCalledOnce()
    expect(streams[0]!.send).not.toHaveBeenCalled()
    expect(streams[1]!.send).not.toHaveBeenCalled()
    expect(inspectPairingFrame(streams[2]!.send.mock.calls[0]![0]).type).toBe("sync-heartbeat-ack")
    expect(connection.close).not.toHaveBeenCalled()
    saved()
    await vi.waitFor(() => expect(streams[0]!.send).toHaveBeenCalledOnce())
    expect(inspectPairingFrame(streams[0]!.send.mock.calls[0]![0]).type).toBe("mesh-durable-ack")
    await session.close()
  })

  it("keeps the peer session alive when one application control frame cannot be stored", async () => {
    const authorization = [{ signed: { signature: "legacy-proof" } }]
    const frames = [
      encodePairingFrame("mesh-control-sync", "secret", new TextEncoder().encode(JSON.stringify({
        version: 1, workspaceId: "workspace", authorization,
      }))),
      encodePairingFrame("sync-heartbeat", "secret", new Uint8Array()),
    ]
    const streams = frames.map(frame => ({ read: async () => frame, send: vi.fn(), closeSend: vi.fn(async () => {}) }))
    let index = 0
    const connection = {
      acceptStream: async () => streams[index++] ?? new Promise<never>(() => {}),
      close: vi.fn(), openStream: vi.fn(),
    }
    const merge = vi.fn().mockRejectedValueOnce(new TypeError("legacy proof cannot be merged"))
    const session = liveAutomergeWorkspaceSync(connection as never, "secret", {
      read: async () => new Uint8Array([1]), merge, activate: vi.fn(),
    }, "workspace", "local", "remote")
    let ended = false
    void session.done.then(() => { ended = true }, () => { ended = true })

    await vi.waitFor(() => expect(streams[1]!.send).toHaveBeenCalledOnce())
    expect(ended).toBe(false)
    expect(connection.close).not.toHaveBeenCalled()
    expect(inspectPairingFrame(streams[1]!.send.mock.calls[0]![0]).type).toBe("sync-heartbeat-ack")
    await session.close()
  })

  it("keeps heartbeat and control alive after a rejected document and can accept a later corrected frame", async () => {
    const error = new WorkspaceChangeRejected("Unsigned workspace change rejected")
    const current = Automerge.save(Automerge.from({ id: "workspace" }))
    const changed = Automerge.save(Automerge.from({ id: "workspace", title: "from remote" }))
    const remote = createLiveWorkspaceSession("workspace", "secret")
    remote.startDocumentSync("remote", "local")
    const local = createLiveWorkspaceSession("workspace", "secret")
    local.startDocumentSync("local", "remote")
    let syncFrame = remote.generateDocument(changed, undefined)!
    for (let round = 0; round < 12; round += 1) {
      const incoming = local.receive(syncFrame)!
      if (incoming.kind !== "automergeSync") throw new Error("Expected Automerge frame")
      const prepared = local.prepareDocument(Uint8Array.from(incoming.payload ?? []), current, undefined)
      if (prepared.acceptedChanges > 0) { local.abortDocument(); break }
      local.commitDocument()
      if (!prepared.response) throw new Error("Automerge exchange ended before changes")
      const response = remote.receive(Uint8Array.from(prepared.response))!
      if (response.kind !== "automergeSync") throw new Error("Expected Automerge response")
      const source = remote.prepareDocument(Uint8Array.from(response.payload ?? []), changed, undefined)
      remote.commitDocument()
      syncFrame = source.response ? Uint8Array.from(source.response) : remote.generateDocument(changed, undefined)!
    }
    local.free?.()
    const reject = vi.fn()
    const mergeMesh = vi.fn()
    const frames = [syncFrame, encodePairingFrame("sync-heartbeat", "secret", new Uint8Array()),
      encodePairingFrame("mesh-control-sync", "secret", new TextEncoder().encode(JSON.stringify({version:1,workspaceId:"workspace",mesh:{epoch:2}}))), syncFrame]
    const streams = frames.map(frame => ({ read: async () => frame, send: vi.fn(), closeSend: vi.fn() }))
    let index = 0
    const connection = { acceptStream: async () => streams[index++] ?? new Promise<never>(() => {}), close: vi.fn(), openStream: vi.fn(async () => ({send:vi.fn(), closeSend:vi.fn(), read:vi.fn(async () => new Uint8Array())})) }
    const merge = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined)
    const session = liveAutomergeWorkspaceSync(connection, "secret", {read:async () => current,merge,activate:vi.fn(),mergeMesh},
      "workspace","local","remote",reject)
    let ended = false
    void session.done.then(() => { ended = true }, () => { ended = true })
    await vi.waitFor(() => expect(merge).toHaveBeenCalledTimes(2))
    expect(reject).toHaveBeenCalledWith(error)
    expect(ended).toBe(false)
    expect(connection.close).not.toHaveBeenCalled()
    expect(inspectPairingFrame(streams[1]!.send.mock.calls[0]![0]).type).toBe("sync-heartbeat-ack")
    expect(mergeMesh).toHaveBeenCalledWith("workspace",{epoch:2})
    await expect(session.publish()).resolves.toBeUndefined()
    await session.close()
    remote.free?.()
  })
})


describe("scope shutdown fitness", () => {
  it("Given a queued current-peer control receive, When its callback disconnects that session, Then receive finishes and scope cleanup drains outside the callback", async () => {
    const frame = encodePairingFrame("mesh-control-sync", "secret", new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: "workspace", mesh: { epoch: 2 } })))
    let accepted = false
    let finished = false
    const stream = { read: async () => frame, send: vi.fn(), closeSend: vi.fn() }
    let endAccept!: () => void
    const disconnected = new Promise<never>((_, reject) => { endAccept = () => reject(new Error("Disconnected")) })
    const connection = { acceptStream: async () => { if (!accepted) { accepted = true; return stream } return disconnected },
      close: vi.fn(async () => endAccept()), openStream: vi.fn() }
    const session = liveAutomergeWorkspaceSync(connection, "secret", { read: vi.fn(), merge: vi.fn(), activate: vi.fn(),
      mergeMesh: async () => { await session.close(); finished = true } }, "workspace", "local", "remote")
    await vi.waitFor(() => expect(finished).toBe(true))
    await session.done
    expect(connection.close).toHaveBeenCalledOnce()
    await session.close()
    expect(connection.close).toHaveBeenCalledOnce()
  })

  it("Given receive waits for the revocation mutation lock, When that lock owner disconnects the session, Then the lock releases before scope drain", async () => {
    const frame = encodePairingFrame("mesh-control-sync", "secret", new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: "workspace", mesh: { epoch: 2 } })))
    let entered!: () => void
    const waitingForLock = new Promise<void>(resolve => { entered = resolve })
    let endAccept!: () => void
    const disconnected = new Promise<never>((_, reject) => { endAccept = () => reject(new Error("Disconnected")) })
    let accepted = false
    let finished = false
    const connection = { acceptStream: async () => { if (!accepted) { accepted = true; return { read: async () => frame, send: vi.fn(), closeSend: vi.fn() } } return disconnected },
      close: vi.fn(async () => endAccept()), openStream: vi.fn() }
    const session = await withWorkspaceMutation("workspace", async () => {
      const current = liveAutomergeWorkspaceSync(connection, "secret", { read: vi.fn(), merge: vi.fn(), activate: vi.fn(),
        mergeMesh: async () => { entered(); await withWorkspaceMutation("workspace", async () => { finished = true }) } }, "workspace", "local", "remote")
      await waitingForLock
      await current.close()
      return current
    })
    await session.done
    expect(finished).toBe(true)
    expect(connection.close).toHaveBeenCalledOnce()
  })
})

describe("paged initial snapshot transport", () => {
  async function fixture() {
    const doc = Automerge.from({ id: crypto.randomUUID(), title: "Pages" })
    const document = Automerge.save(doc)
    const hash = Automerge.decodeChange(Automerge.getLastLocalChange(doc)!).hash
    const authorization = { version: 1, authority: { genesisOwner: { personId: "fixture-owner" } },
      records: Array.from({ length: 20_001 }, (_, index) => ({ signed: { signature: `signature-${String(index).padStart(6, "0")}`,
        payload: { hashes: [hash] } } })) }
    const readAuthorization = vi.fn(async () => authorization)
    const source = workspaceSet({ read: async () => document, readAuthorization,
      merge: vi.fn(), activate: vi.fn() }, [doc.id])
    const merge = vi.fn()
    const validate = vi.fn(async (_id: string, _bytes: Uint8Array, proof: any) => {
      expect(proof.version).toBe(2)
      expect(proof.pages.flat()).toHaveLength(20_001)
    })
    const target = workspaceSet({ read: async () => { throw new Error("Absent snapshot") }, merge, validate, activate: vi.fn() }, [doc.id])
    const frames: Uint8Array[] = []
    let requests = 0
    let failAt = 0
    const connection = { openStream: async () => {
      let request!: Uint8Array
      return { send: async (frame: Uint8Array) => { request = frame; frames.push(frame) }, closeSend: async () => {},
        read: async () => {
          requests++
          let reply!: Uint8Array
          await source.serveProofPage(request, { read: vi.fn(), send: async frame => { reply = frame; frames.push(frame) }, closeSend: async () => {} }, "secret")
          if (requests === failAt) throw new Error("Lost page response")
          return reply
        } }
    }, acceptStream: vi.fn(), close: vi.fn() } as SyncConnection
    return { id: doc.id, document, authorization, source, target, merge, validate, readAuthorization, connection, frames,
      count: () => requests, fail: (at: number) => { failAt = at } }
  }
  it("Given 20,001 records, fetches bounded pages before any validation or document publication", async () => {
    const f = await fixture()
    const snapshot = await f.source.snapshot()
    await expect(f.target.validate(snapshot)).rejects.toThrow(/pages required/)
    expect(f.merge).not.toHaveBeenCalled()
    const resolved = await f.target.resolveProofs(snapshot, f.connection, "secret")
    expect(f.validate).not.toHaveBeenCalled()
    expect(f.merge).not.toHaveBeenCalled()
    expect(f.frames.every(frame => frame.length <= 256 * 1024)).toBe(true)
    expect(f.readAuthorization).toHaveBeenCalledTimes(2) // Snapshot plus first source page; subsequent pages reuse frozen index.
    await f.target.receive(resolved)
    expect(f.merge).toHaveBeenCalledTimes(1)
    const decoded = meshRustRuntime().state.decodeWorkspaceSet(resolved, [f.id])
    expect((decoded[0]!.authorization as any).pages.flat()).toHaveLength(20_001)
    await clearProofPages(f.id)
  }, 20_000)
  it("Given lost response, retry reuses saved pages; corrupt saved page forces bounded refetch", async () => {
    const f = await fixture()
    const snapshot = await f.source.snapshot()
    f.fail(2)
    await expect(f.target.resolveProofs(snapshot, f.connection, "secret")).rejects.toThrow("Lost page response")
    expect(f.merge).not.toHaveBeenCalled()
    const first = JSON.parse(new TextDecoder().decode(f.frames[0]!.subarray(f.frames[0]!.indexOf(10) + 1)))
    const cacheKey = `${first.requestId}:${first.after}`
    expect(await readProofPage(f.id, cacheKey)).toBeDefined()
    await writeProofPage(f.id, cacheKey, new TextEncoder().encode("corrupt"))
    const resolved = await f.target.resolveProofs(snapshot, f.connection, "secret")
    expect(f.count()).toBeGreaterThan(2)
    await f.target.receive(resolved)
    expect(f.merge).toHaveBeenCalledTimes(1)
    await clearProofPages(f.id)
  }, 20_000)
  it("Given durable local coverage, manifest resolves without network; authority still passes validation", async () => {
    const f = await fixture()
    const target = workspaceSet({ read: async () => f.document, merge: vi.fn(), activate: vi.fn(), validate: vi.fn() }, [f.id])
    const resolved = await target.resolveProofs(await f.source.snapshot())
    const entry = meshRustRuntime().state.decodeWorkspaceSet(resolved, [f.id])[0]!
    expect(entry.authorization).toMatchObject({ version: 2, pages: [] })
    await target.validate(resolved)
    expect(f.count()).toBe(0)
  })
  it("Given initial durable batch, emits receipt only after all pages and durable merge", async () => {
    const f = await fixture()
    let release!: () => void
    const durable = new Promise<void>(resolve => { release = resolve })
    const merge = vi.fn(() => durable)
    const target = workspaceSet({ read: async () => { throw new Error("Absent snapshot") }, merge, activate: vi.fn() }, [f.id])
    const stream = { send: vi.fn(), closeSend: vi.fn(), read: async () => encodePairingFrame("mesh-durable-batch", "secret", await f.source.snapshot()) }
    let sent = false
    f.connection.acceptStream = async () => { if (!sent) { sent = true; return stream }; return new Promise<never>(() => {}) }
    const session = liveWorkspaceSetSync(f.connection, "secret", target)
    await vi.waitFor(() => expect(merge).toHaveBeenCalled(), { timeout: 20_000 })
    expect(stream.send).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(stream.send).toHaveBeenCalledTimes(1))
    expect(inspectPairingFrame(stream.send.mock.calls[0]![0]).type).toBe("mesh-durable-ack")
    await session.close()
    await clearProofPages(f.id)
  }, 20_000)
})
