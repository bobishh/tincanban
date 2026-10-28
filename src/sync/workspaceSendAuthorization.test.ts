import { beforeAll, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { liveAutomergeWorkspaceSync } from "./workspaceSet"
import type { SyncConnection } from "./transport"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

it.each(["document", "control"] as const)("Given a live scope with private %s bytes prepared, when access is revoked while its stream opens, then send no further bytes", async kind => {
  const document = Automerge.from({ id: "workspace", title: "Private board content" })
  const bytes = Automerge.save(document)
  Automerge.free(document)
  let authorized = true, opens = 0, opened!: () => void, resume!: () => void
  const pendingOpen = new Promise<void>(resolve => { opened = resolve })
  const ready = new Promise<void>(resolve => { resume = resolve })
  const send = vi.fn<(bytes: Uint8Array) => Promise<void>>(async () => {})
  const reset = vi.fn(async () => { if (kind === "control") throw new Error("Cleanup failed") })
  const connection: SyncConnection = {
    openStream: async () => {
      opens++
      if (opens === (kind === "document" ? 1 : 2)) { opened(); await ready }
      return { send, closeSend: async () => {}, read: async () => new Uint8Array(), reset }
    },
    acceptStream: () => new Promise(() => {}), close: vi.fn(async () => {}),
  }
  const session = liveAutomergeWorkspaceSync(connection, "secret", { read: async () => bytes, merge: async () => {}, activate: async () => {},
    readMesh: async () => ({ identityDevicePreferences: { privateMarker: "Do not disclose after revocation" } }),
  }, "workspace", "local-device", "remote-device", undefined, {
    ensureCurrent: async () => { if (!authorized) throw new Error("Recipient access was revoked") },
  })
  const publishing = session.publish()
  try {
    await pendingOpen
    const sentBeforeRevocation = send.mock.calls.length
    authorized = false
    resume()
    await expect(publishing).rejects.toThrow("Recipient access was revoked")
    expect(send).toHaveBeenCalledTimes(sentBeforeRevocation)
    expect(reset).toHaveBeenCalledOnce()
    if (kind === "control") expect(sentBeforeRevocation).toBe(1)
  } finally { resume(); await publishing.catch(() => {}); await session.close() }
})

it("Given an older stream without reset, when authorization fails after opening, then end that stream without closing its healthy connection", async () => {
  const document = Automerge.from({ id: "workspace" }), bytes = Automerge.save(document)
  Automerge.free(document)
  let authorized = true
  const send = vi.fn(async () => {}), closeSend = vi.fn(async () => {}), close = vi.fn(async () => {})
  const connection: SyncConnection = { openStream: async () => {
    authorized = false
    return { send, closeSend, read: async () => new Uint8Array() }
  }, acceptStream: () => new Promise(() => {}), close }
  const session = liveAutomergeWorkspaceSync(connection, "secret", { read: async () => bytes, merge: async () => {}, activate: async () => {} },
    "workspace", "local-device", "remote-device", undefined, { ensureCurrent: async () => {
      if (!authorized) throw new Error("Recipient access was revoked")
    } })
  try {
    await expect(session.publish()).rejects.toThrow("Recipient access was revoked")
    expect(send).not.toHaveBeenCalled()
    expect(closeSend).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
  } finally { await session.close() }
})

it("Given an incoming document request awaiting local storage, when access is revoked during that read, then release no document response on the existing stream", async () => {
  const local = Automerge.from({ id: "workspace", title: "Private response content" })
  const remote = Automerge.from({ id: "workspace" })
  const bytes = Automerge.save(local), remoteBytes = Automerge.save(remote)
  Automerge.free(local); Automerge.free(remote)
  const runtime = meshRustRuntime().createMeshScopeRuntime("workspace", "secret")
  runtime.startDocumentSync("remote-device", "local-device")
  const frame = Uint8Array.from(runtime.publishFrame(remoteBytes, undefined)!)
  let authorized = true, accepted = false, reading!: () => void, resume!: () => void
  const readStarted = new Promise<void>(resolve => { reading = resolve })
  const ready = new Promise<void>(resolve => { resume = resolve })
  const send = vi.fn(async () => {}), closeSend = vi.fn(async () => {})
  const incoming = { send, closeSend, read: async () => frame, readPairingOrRawPrefix: async () => frame }
  const connection: SyncConnection = { openStream: vi.fn(), close: vi.fn(async () => {}),
    acceptStream: async () => { if (accepted) return new Promise(() => {}); accepted = true; return incoming } }
  const session = liveAutomergeWorkspaceSync(connection, "secret", {
    read: async () => { reading(); await ready; return bytes }, merge: async () => {}, activate: async () => {},
  }, "workspace", "local-device", "remote-device", undefined, {
    ensureCurrent: async () => { if (!authorized) throw new Error("Recipient access was revoked") },
  })
  try {
    await readStarted
    authorized = false
    resume()
    await vi.waitFor(() => expect(closeSend).toHaveBeenCalled())
    expect(send).not.toHaveBeenCalled()
  } finally { resume(); await session.close(); runtime.free?.() }
})
